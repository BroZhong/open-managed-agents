import type { Adapter, TurnJournalPort } from "./interface.js";
import type { AdapterInput, SessionEvent, StreamEvent } from "./types.js";

/** An event an Adapter records durably: anything but a Delta. */
export type DurableEvent = Exclude<SessionEvent, StreamEvent>;

/**
 * In-memory TurnJournalPort for testing Adapters, with the Host journal's
 * semantics (ADR-0020): record queues a snapshot, a repeated event ID is a
 * no-op, flush is the only write and any write failure is sticky. It also
 * keeps every call for assertions.
 */
export class MemoryTurnJournal implements TurnJournalPort {
  /** Every record and delta call in order, including records a failed journal drops. */
  readonly events: SessionEvent[] = [];
  /** Every record call in order, including those a failed journal drops. */
  readonly recorded: DurableEvent[] = [];
  /** Events whose flush resolved, in write order. */
  readonly committed: DurableEvent[] = [];
  readonly deltas: Array<{ event: StreamEvent; blockIndex: number }> = [];
  private pending: DurableEvent[] = [];
  private readonly ids = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;
  private failed = false;

  /** `write` persists one flush's batch; a rejection fails the journal. */
  constructor(private readonly write: (batch: DurableEvent[]) => Promise<void> = async () => {}) {}

  record(event: DurableEvent): void {
    const snapshot = structuredClone(event);
    this.events.push(snapshot);
    this.recorded.push(snapshot);
    if (this.failed || this.ids.has(event.id)) return;
    this.ids.add(event.id);
    this.pending.push(structuredClone(event));
  }

  delta(event: StreamEvent, blockIndex: number): void {
    const snapshot = structuredClone(event);
    this.events.push(snapshot);
    this.deltas.push({ event: snapshot, blockIndex });
  }

  flush(): Promise<void> {
    const write = this.tail.then(async () => {
      if (this.failed) throw this.failure;
      const batch = this.pending.splice(0);
      if (!batch.length) return;
      try {
        await this.write(batch);
      } catch (error) {
        this.failed = true;
        this.failure = error;
        throw error;
      }
      this.committed.push(...batch);
    });
    this.tail = write.catch(() => {});
    return write;
  }
}

/** An AdapterInput without its write entry, which {@link runWithJournal} supplies. */
export type InputWithoutJournal = Omit<AdapterInput, "journal">;

/**
 * Run an Adapter with `journal` as its write entry and return the journal's
 * `events`: everything the Adapter recorded or emitted as a Delta, in call
 * order. Rejects as run() does.
 */
export async function runWithJournal(
  adapter: Adapter,
  input: InputWithoutJournal,
  journal = new MemoryTurnJournal(),
): Promise<SessionEvent[]> {
  await adapter.run({ ...input, journal });
  return journal.events;
}
