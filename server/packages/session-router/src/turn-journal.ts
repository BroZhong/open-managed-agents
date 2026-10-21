import type { StoredEvent } from "@oma-server/store";
import type { SessionEvent, StreamEvent, TurnJournalPort } from "@open-managed-agents/adapter-core";

/** A durable event in the event log's input shape, before it has a seq. */
export interface JournalEvent {
  type: string;
  data: unknown;
  /** Envelope fields; the append port supplies the defaults when absent. */
  sessionThreadId?: string;
  apiKeyId?: string;
}

/** A Delta aligned to the Turn output block its Complete Event will replace. */
export interface JournalDelta {
  turnId: string;
  blockIndex: number;
  /**
   * The attempt that streamed it. Attempts of one input share the Turn and its
   * block numbering, so this is what keeps a console from joining a lost
   * attempt's partial output to its successor's.
   */
  attempt: number;
  type: string;
  data: StreamEvent;
}

/** Persistence is injected by the Host; the journal knows no PG, Redis or delegation. */
export interface TurnJournalOptions {
  sessionId: string;
  /** This attempt's claim generation; tags every Delta it emits. */
  attempt: number;
  /**
   * Fenced, idempotent append returning the stored row. Repeating a key
   * returns the original row. A rejection fails the journal permanently.
   */
  append(event: JournalEvent, key: string): Promise<StoredEvent>;
  /** Live notification of a row this journal wrote. */
  publish(stored: StoredEvent): void;
  /** Transient Delta output, awaited before the next Delta leaves. Failures are ignored. */
  outputDelta(delta: JournalDelta): void | Promise<unknown>;
  /** Durable form and idempotency key of an event the Adapter recorded. */
  fromAdapter(event: Exclude<SessionEvent, StreamEvent>): { event: JournalEvent; key: string };
  /**
   * Called once, at the first failure, before the failing flush rejects: the
   * owner stops the attempt on it as on a lost lease (ADR-0020).
   */
  onFail?(error: unknown): void;
  logger?: Pick<Console, "info">;
}

/**
 * The only write entry of one Turn attempt (ADR-0020). The Router creates it
 * after claiming the input, records its own events with explicit idempotency
 * keys, and hands {@link adapter} to the Adapter. Nothing is written outside
 * flush: there is no background writer.
 */
export class TurnJournal {
  readonly adapter: TurnJournalPort;
  private pending: Array<{ event: JournalEvent; key: string; owned: boolean }> = [];
  /** Keys recorded by this journal, queued or written. */
  private readonly keys = new Set<string>();
  /** Rows of the owner's own events by key. The Adapter's bulk output is not kept. */
  private readonly ownerRows = new Map<string, StoredEvent>();
  private turnId?: string;
  private tail: Promise<void> = Promise.resolve();
  private deltas: Promise<void> = Promise.resolve();
  private failure: unknown;
  private failed = false;
  private revoked = false;
  private publishedSeq = 0;
  private readonly logger: Pick<Console, "info">;

  constructor(private readonly options: TurnJournalOptions) {
    this.logger = options.logger ?? console;
    this.adapter = {
      record: (event) => {
        if (!this.adapterOpen) return;
        try {
          const { event: durable, key } = options.fromAdapter(event);
          this.queue(durable, key, false);
        } catch (error) {
          this.fail(error);
        }
      },
      delta: (event, blockIndex) => { if (this.adapterOpen) this.delta(event, blockIndex); },
      flush: () => this.revoked ? Promise.reject(new Error("Turn journal write entry revoked")) : this.flush(),
    };
  }

  /** Queue the owner's own event under an explicit idempotency key. Never throws. */
  record(event: JournalEvent, key: string): void {
    this.queue(event, key, true);
  }

  /**
   * Name the Turn this attempt executes; Deltas and flush logs carry it. A
   * Turn is named after its input's seq, which only the attempt's first write
   * (promoting the input) assigns, so the owner binds the name after that
   * flush and before it hands {@link adapter} out.
   */
  bindTurn(turnId: string): void {
    this.turnId = turnId;
  }

  /**
   * The stored row of the owner's event recorded under `key`, once a flush has
   * appended it; for a key an earlier attempt already wrote, the original row.
   */
  written(key: string): StoredEvent | undefined {
    return this.ownerRows.get(key);
  }

  /**
   * Detach the Adapter. What it recorded so far is written at the next flush;
   * from now on its record and delta are dropped and its flush rejects.
   */
  revokeAdapter(): void {
    this.revoked = true;
  }

  flush(): Promise<void> {
    const started = performance.now();
    const write = this.tail.then(() => this.write(started));
    this.tail = write.catch(() => {});
    return write;
  }

  /** A revoked or failed attempt no longer owns the Turn's output. */
  private get adapterOpen(): boolean {
    return !this.revoked && !this.failed;
  }

  private queue(event: JournalEvent, key: string, owned: boolean): void {
    if (this.failed || this.keys.has(key)) return;
    try {
      // The caller may keep mutating its objects; the write uses this snapshot.
      this.pending.push({ event: structuredClone(event), key, owned });
      this.keys.add(key);
    } catch (error) {
      this.fail(error);
    }
  }

  /** Deltas leave one at a time so the live projection keeps call order. */
  private delta(event: StreamEvent, blockIndex: number): void {
    // The Adapter receives its port only once the Turn is bound.
    const delta: JournalDelta = { turnId: this.turnId!, blockIndex, attempt: this.options.attempt, type: event.type, data: event };
    // Checked again at output time, after earlier Deltas have left.
    this.deltas = this.deltas.then(() => this.adapterOpen ? this.options.outputDelta(delta) : undefined).then(() => {}, () => {});
  }

  /** A later write must never land behind a lost one, so failure is sticky. */
  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.failure = error;
    this.options.onFail?.(error);
  }

  /** Group commit: one flush writes everything recorded until it runs. */
  private async write(started: number): Promise<void> {
    if (this.failed) throw this.failure;
    const batch = this.pending.splice(0);
    if (!batch.length) return;
    let events = 0;
    let bytes = 0;
    let error: string | undefined;
    try {
      for (const { event, key, owned } of batch) {
        const stored = await this.options.append(event, key);
        if (owned) this.ownerRows.set(key, stored);
        events++;
        bytes += Buffer.byteLength(JSON.stringify(event.data) ?? "");
        // Appends are serial, so each new row has a higher seq than any before.
        // A lower one is an idempotent hit on an earlier attempt's row.
        if (stored.seq > this.publishedSeq) {
          this.publishedSeq = stored.seq;
          this.options.publish(stored);
        }
      }
    } catch (failure) {
      this.fail(failure);
      error = failure instanceof Error ? failure.message : String(failure);
      throw failure;
    } finally {
      // One line per write round, for flush latency p50/p99 from Runner logs.
      // The duration is what the flush caller waited, queueing included. The
      // flush that promotes the input runs before the Turn has a name.
      const durationMs = Math.round((performance.now() - started) * 10) / 10;
      this.logger.info(JSON.stringify({ msg: "turn_journal_flush", sessionId: this.options.sessionId, turnId: this.turnId,
        events, bytes, durationMs, ...(error === undefined ? {} : { error }) }));
    }
  }
}
