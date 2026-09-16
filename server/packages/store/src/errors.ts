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

export class SkillNameConflictError extends Error {
  readonly code = "skill_name_conflict";
  constructor(name: string) {
    super(`A Skill named "${name}" already exists for this owner.`);
    this.name = "SkillNameConflictError";
  }
}
