import type { SessionEvent, StreamEvent, TurnJournalPort } from "@open-managed-agents/adapter-core";

export type DurableEvent = Exclude<SessionEvent, StreamEvent>;

/**
 * In-memory TurnJournalPort with the Host journal's semantics: record queues a
 * snapshot, a repeated event ID is a no-op, flush is the only write and any
 * write failure is sticky. It also keeps every call for assertions.
 */
export class MemoryTurnJournal implements TurnJournalPort {
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
    this.recorded.push(structuredClone(event));
    if (this.failed || this.ids.has(event.id)) return;
    this.ids.add(event.id);
    this.pending.push(structuredClone(event));
  }

  delta(event: StreamEvent, blockIndex: number): void {
    this.deltas.push({ event: structuredClone(event), blockIndex });
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
