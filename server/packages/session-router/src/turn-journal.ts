import type { StoredEvent } from "@oma-server/store";
import type { DurableEvent, StreamEvent, TurnJournalPort } from "@open-managed-agents/adapter-core";

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
  fromAdapter(event: DurableEvent): { event: JournalEvent; key: string };
  /**
   * Called once, at the first failure, before the failing flush rejects: the
   * owner stops the attempt on it as on a lost lease (ADR-0020).
   */
  onFail?(error: unknown): void;
  logger?: Pick<Console, "info">;
}

/**
 * Consecutive chunks of one output block leave as one Delta: a Delta may carry
 * more than one token, and each costs a Redis append and a publish. A run of
 * chunks leaves this long after its first chunk, or at once when the next
 * Delta belongs elsewhere, at a flush, or before it would pass the size cap.
 */
const DELTA_WINDOW_MS = 50;
const DELTA_MAX_CHARS = 8192;

/** The text a chunk adds and the key of the chunks it joins; none for stream start/end markers. */
function chunkText(event: StreamEvent): { text: string; key: string } | undefined {
  switch (event.type) {
    case "agent.message_chunk":
    case "agent.thinking_chunk":
      return { text: event.text, key: event.type };
    case "agent.tool_use_input_chunk":
      return { text: event.delta, key: `${event.type}:${event.toolUseId}` };
    default:
      return undefined;
  }
}

/** A run of chunks still taking more: queued for output, not yet left. */
interface DeltaRun {
  key: string;
  blockIndex: number;
  /** The run leaves as its first chunk, carrying the joined text. */
  first: StreamEvent;
  parts: string[];
  chars: number;
  /** Ends the run's window early. */
  close(): void;
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
  private run?: DeltaRun;
  private deltasEnded = false;
  /** Chunks received and Deltas queued since the last flush log line. */
  private deltasIn = 0;
  private deltasOut = 0;
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
    this.closeRun();
  }

  /**
   * End Delta output once the Turn's content is durable, before its Delta
   * stream is reclaimed: queued Deltas are dropped (a completed Turn rejects
   * them anyway) and the one leaving is awaited, so none lands after reclaim.
   */
  endDeltas(): Promise<void> {
    this.deltasEnded = true;
    this.closeRun();
    return this.deltas;
  }

  flush(): Promise<void> {
    const started = performance.now();
    // What the Adapter streamed before this flush leaves now, ahead of its window.
    this.closeRun();
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
    if (this.deltasEnded) return;
    this.deltasIn++;
    const chunk = chunkText(event);
    const run = this.run;
    if (chunk && run && run.key === chunk.key && run.blockIndex === blockIndex && run.chars + chunk.text.length <= DELTA_MAX_CHARS) {
      run.parts.push(chunk.text);
      run.chars += chunk.text.length;
      return;
    }
    this.closeRun();
    if (!chunk) {
      this.output(() => event, blockIndex);
      return;
    }
    let close!: () => void;
    const window = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, DELTA_WINDOW_MS);
      timer.unref?.();
      close = () => { clearTimeout(timer); resolve(); };
    });
    const next: DeltaRun = { key: chunk.key, blockIndex, first: event, parts: [chunk.text], chars: chunk.text.length, close };
    this.run = next;
    this.output(async () => {
      await window;
      // Until it leaves the run keeps taking chunks, also while earlier output holds it past its window.
      if (this.run === next) this.run = undefined;
      const text = next.parts.join("");
      return (next.first.type === "agent.tool_use_input_chunk" ? { ...next.first, delta: text } : { ...next.first, text }) as StreamEvent;
    }, blockIndex);
  }

  /** The open run takes no more chunks and leaves as soon as the Deltas ahead of it have. */
  private closeRun(): void {
    this.run?.close();
    this.run = undefined;
  }

  private output(take: () => StreamEvent | Promise<StreamEvent>, blockIndex: number): void {
    // The Adapter receives its port only once the Turn is bound.
    const turnId = this.turnId!;
    this.deltasOut++;
    this.deltas = this.deltas.then(async () => {
      const event = await take();
      // Checked at output time, after earlier Deltas have left.
      if (!this.adapterOpen || this.deltasEnded) return;
      await this.options.outputDelta({ turnId, blockIndex, attempt: this.options.attempt, type: event.type, data: event });
    }).then(() => {}, () => {});
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
      // flush that promotes the input runs before the Turn has a name. The
      // Delta counts since the previous line give the coalescing ratio.
      const durationMs = Math.round((performance.now() - started) * 10) / 10;
      const { deltasIn, deltasOut } = this;
      this.deltasIn = this.deltasOut = 0;
      this.logger.info(JSON.stringify({ msg: "turn_journal_flush", sessionId: this.options.sessionId, turnId: this.turnId,
        events, bytes, deltasIn, deltasOut, durationMs, ...(error === undefined ? {} : { error }) }));
    }
  }
}
