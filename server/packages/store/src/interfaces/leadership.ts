/**
 * The lead of one role among the Runners of an environment (ADR-0026): at
 * most one Runner holds it at a time, and when it stops, or vanishes, the
 * next Runner to ask takes it.
 */
export interface Leadership {
  /**
   * Whether this Runner leads now. Asked every period: it takes the lead
   * when no Runner holds it, keeps it while it does, and finds out that it
   * lost it (its connection ended) and whether it can take it again.
   * Rejects when that cannot be told; the caller then does not lead.
   */
  hold(): Promise<boolean>;
  /** Give the lead up for good, at shutdown: the next Runner to ask takes it. */
  close(): Promise<void>;
}
