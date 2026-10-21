import type { AdapterInput, SessionEvent, StreamEvent } from "./types.js";

export interface Adapter {
  run(input: AdapterInput): AsyncIterable<SessionEvent>;
}

/**
 * The Adapter's only write entry for one Turn attempt (ADR-0020). The Host
 * creates it after claiming the input and owns everything behind it: storage,
 * the claim fence and live delivery. The Host can revoke it at any time.
 */
export interface TurnJournalPort {
  /**
   * Queue a durable event behind those recorded before it. Synchronous and
   * never throws: nothing is written until the next flush, the event is
   * written as it was at this call, and recording it again is a no-op.
   */
  record(event: Exclude<SessionEvent, StreamEvent>): void;
  /**
   * Emit a Delta of output block `blockIndex`, which must equal the blockIndex
   * of the Complete Event that later replaces it. Best effort and transient:
   * never awaited, never written durably, and its failure never affects
   * record or flush.
   */
  delta(event: StreamEvent, blockIndex: number): void;
  /**
   * Resolve once every event recorded before this call is persisted and
   * published. Rejects immediately once the Host has revoked this entry, and
   * forever after any write failure.
   */
  flush(): Promise<void>;
}
