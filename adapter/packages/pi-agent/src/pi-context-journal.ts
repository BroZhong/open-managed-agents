import type { ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";

import { isContinuationEntry } from "./pi-continuation.js";

interface JournalOptions {
  manager: SessionManager;
  input: AdapterInput;
  emit(event: SessionEvent): void;
  checkpoint(): SessionEvent[];
  compactionInfo(): { compactionId: string; reason: "manual" | "threshold" | "overflow" } | undefined;
}

/** Platform durability through public SDK events and a request gate. */
export class PiContextJournal {
  private cursor: number;
  private inputRecorded = false;
  private pending: Promise<void> = Promise.resolve();
  failure?: Error;

  constructor(private readonly options: JournalOptions) {
    this.cursor = options.manager.getEntries().length;
  }

  readonly extension: ExtensionFactory = pi => {
    pi.on("tool_call", () => { this.capture(); });
    pi.on("session_compact", () => {
      this.pending = this.pending.then(() => this.commit()).catch(error => {
        // Extension exceptions are swallowed by Pi. Keep failure sticky and
        // enforce it both at streamFunction and at operation settlement.
        this.failure = error instanceof Error ? error : new Error(String(error));
      });
      return this.pending;
    });
  };

  capture(): void {
    if (this.failure) return;
    const { manager, input, emit } = this.options;
    for (const entry of manager.getEntries().slice(this.cursor)) {
      if (isContinuationEntry(entry)) { this.cursor++; continue; }
      if (entry.type === "compaction") break;
      const isInput = entry.type === "message" && entry.message.role === "user" && !this.inputRecorded;
      if (isInput) this.inputRecorded = true;
      emit({ id: `pi_entry_${entry.id}`, type: "agent.context_entry", timestamp: entry.timestamp,
        sdk: "pi@0.83.0", turnId: input.turnId,
        ...(isInput ? { inputEventId: input.inputEventId } : {}), entry: structuredClone(entry) });
      this.cursor++;
    }
  }

  async ready(): Promise<void> {
    await this.pending;
    if (this.failure) throw this.failure;
    this.options.input.signal?.throwIfAborted();
    this.capture();
  }

  private async commit(): Promise<void> {
    if (this.failure) throw this.failure;
    const { input, manager, emit, checkpoint, compactionInfo } = this.options;
    this.capture();
    // Pi 0.83.0 locates the extension event's entry by summary text. Equal
    // summaries can therefore report an old ID; the append-only journal is
    // authoritative and supplies the newly appended boundary instead.
    const entry = manager.getEntries()[this.cursor];
    if (entry?.type !== "compaction") throw new Error("Missing newly appended Pi compaction");
    input.signal?.throwIfAborted();
    if (!input.persistContext) throw new Error("Pi compaction requires a Host persistence barrier");
    const previous = manager.getEntries().slice(0, this.cursor).reverse().find(item => item.type === "message" && item.message.role === "assistant");
    const message = previous?.type === "message" ? previous.message : undefined;
    const measured = message?.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted"
      ? message.usage.totalTokens || message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite : undefined;
    const event: SessionEvent = { id: `pi_entry_${entry.id}`, type: "agent.context_entry", timestamp: entry.timestamp,
      sdk: "pi@0.83.0", turnId: input.turnId, entry: structuredClone(entry), ...compactionInfo(),
      tokensBeforeSource: measured !== undefined && measured === entry.tokensBefore ? "usage" : "estimate" };
    const preceding = checkpoint().filter(event => ["agent.context_start", "agent.context_entry", "agent.context_usage", "agent.compaction"].includes(event.type));
    await input.persistContext([...preceding, event]);
    emit(event);
    this.cursor++;
  }
}
