import type { AdapterInput, DurableEvent, StreamEvent } from "./types.js";

/**
 * How a run ended (ADR-0020). `"finished"`: the Adapter is done with the Turn,
 * including when it ended in an error it recorded or because of an Interrupt.
 * `"stopped"`: the Adapter stopped before the Turn finished because the Host
 * asked it to (`AdapterInput.stopRequest`, #254); the Host writes no terminal
 * event and hands the Turn to a later attempt.
 */
export type AdapterRunResult = "finished" | "stopped";

export interface Adapter {
  /**
   * Execute one Turn attempt. Everything the Adapter produces goes through
   * `input.journal`; the returned Promise settles once the Adapter no longer
   * runs the Turn. A rejection is an Adapter failure, which the Host records
   * unless the Turn was interrupted or the attempt lost the Turn.
   */
  run(input: AdapterInput): Promise<AdapterRunResult>;
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
  record(event: DurableEvent): void;
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
