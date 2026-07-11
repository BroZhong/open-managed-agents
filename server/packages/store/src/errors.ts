export class PendingEventClaimLostError extends Error {
  readonly code = "pending_event_claim_lost";

  constructor(
    readonly sessionId: string,
    readonly eventId: string,
    readonly ownerId: string,
    readonly generation: number,
  ) {
    super(
      `Pending event claim lost: ${sessionId}/${eventId} owner=${ownerId} generation=${generation}`,
    );
    this.name = "PendingEventClaimLostError";
  }
}
