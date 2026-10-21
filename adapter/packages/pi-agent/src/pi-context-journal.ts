import type { ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AdapterInput, AgentContextEntryEvent, SessionEvent, StreamEvent } from "@open-managed-agents/adapter-core";

import { isContinuationEntry } from "./pi-continuation.js";
import { PiPresentation } from "./pi-presentation.js";

interface JournalOptions {
  manager: SessionManager;
  input: AdapterInput;
  emit(event: Exclude<SessionEvent, StreamEvent>): void;
  checkpoint(): SessionEvent[];
  takeUncommitted(): SessionEvent[];
  compactionInfo(): { compactionId: string; reason: "manual" | "threshold" | "overflow" } | undefined;
}

const CONTEXT_TYPES = new Set(["agent.context_start", "agent.context_entry", "agent.context_usage", "agent.compaction"]);
/** Matches neither Pi's provider retry nor context-overflow patterns. */
export const COMMIT_BARRIER_FAILED = "OMA commit barrier failed";

/** Platform durability through public SDK events and a request gate. */
export class PiContextJournal {
  private cursor: number;
  private inputRecorded = false;
  private pending: Promise<void> = Promise.resolve();
  private readonly presentation: PiPresentation;
  failure?: Error;

  constructor(private readonly options: JournalOptions) {
    this.cursor = options.manager.getEntries().length;
    this.presentation = new PiPresentation(options.input.agent.mcpServers?.map(server => server.name) ?? []);
    for (const entry of options.manager.getEntries()) this.presentation.describe(entry);
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
        ...(isInput ? { inputEventId: input.inputEventId } : {}), entry: structuredClone(entry),
        presentation: this.presentation.describe(entry) });
      this.cursor++;
    }
  }

  async ready(): Promise<void> {
    await this.pending;
    // Pi turns a request rejection into an error message and applies provider
    // retry and overflow recovery to its text, so a journal failure uses the
    // fixed barrier message.
    if (this.failure) throw this.options.input.journal ? new Error(COMMIT_BARRIER_FAILED) : this.failure;
    this.options.input.signal?.throwIfAborted();
    this.capture();
  }

  /**
   * Commit barrier at each native message boundary. Pi converts the rejection
   * into an error message and applies provider retry to its text, so failure
   * stays sticky and every later boundary rejects with a fixed message.
   */
  async flush(): Promise<void> {
    if (!this.failure) {
      this.capture();
      const write = this.commitWrite();
      if (write) {
        this.pending = this.pending.then(write).catch(error => {
          this.failure = error instanceof Error ? error : new Error(String(error));
        });
      }
    }
    await this.pending;
    if (this.failure) throw new Error(COMMIT_BARRIER_FAILED);
  }

  /**
   * A journal holds every recorded event in call order and writes them all.
   * Without one, commit the context events the Host has not received yet.
   */
  private commitWrite(): (() => Promise<void>) | undefined {
    const { journal, persistContext } = this.options.input;
    if (journal) return () => journal.flush();
    const events = this.options.takeUncommitted().filter(event => CONTEXT_TYPES.has(event.type));
    return persistContext && events.length ? () => persistContext(structuredClone(events)) : undefined;
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
    if (!input.journal && !input.persistContext) throw new Error("Pi compaction requires a Host persistence barrier");
    const previous = manager.getEntries().slice(0, this.cursor).reverse().find(item => item.type === "message" && item.message.role === "assistant");
    const message = previous?.type === "message" ? previous.message : undefined;
    const measured = message?.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted"
      ? message.usage.totalTokens || message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite : undefined;
    const event: AgentContextEntryEvent = { id: `pi_entry_${entry.id}`, type: "agent.context_entry", timestamp: entry.timestamp,
      sdk: "pi@0.83.0", turnId: input.turnId, entry: structuredClone(entry), ...compactionInfo(),
      tokensBeforeSource: measured !== undefined && measured === entry.tokensBefore ? "usage" : "estimate" };
    if (input.journal) {
      // Recorded behind everything before it, so one flush commits the prefix
      // and the boundary. No request may use the summary until it resolves.
      emit(event);
      await input.journal.flush();
    } else {
      const preceding = checkpoint().filter(event => ["agent.context_start", "agent.context_entry", "agent.context_usage", "agent.compaction"].includes(event.type));
      await input.persistContext!([...preceding, event]);
      emit(event);
      // The batch above holds every context event emitted so far.
      this.options.takeUncommitted();
    }
    this.cursor++;
  }
}
