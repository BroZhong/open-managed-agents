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

/** A Skill exceeds `SKILL_BUNDLE_MAX_BYTES` uncompressed; the API maps this to 413. */
export class SkillBundleTooLargeError extends Error {
  readonly code = "skill_bundle_too_large";
  constructor(readonly actualBytes: number, readonly limitBytes: number) {
    super(`Skill is too large: ${actualBytes} bytes uncompressed exceeds the ${limitBytes / (1024 * 1024)} MB (${limitBytes}-byte) limit.`);
    this.name = "SkillBundleTooLargeError";
  }
}

/** A Skill file cannot be packed: invalid or duplicate path, or invalid mode. A client error. */
export class InvalidSkillFileError extends Error {
  readonly code = "invalid_skill_file";
  constructor(readonly path: string, message: string) {
    super(message);
    this.name = "InvalidSkillFileError";
  }
}

/** Stored bytes are not a well-formed Skill Bundle, or do not match their sha256. A server fault. */
export class InvalidSkillBundleError extends Error {
  readonly code = "invalid_skill_bundle";
  constructor(message: string) {
    super(message);
    this.name = "InvalidSkillBundleError";
  }
}

/**
 * A compare-and-set Skill update lost a race: the row's current bundle is no
 * longer the version the edit was based on. The API maps this to 409.
 */
export class SkillVersionConflictError extends Error {
  readonly code = "skill_version_conflict";
  constructor(
    readonly skillId: string,
    readonly expectedBundleSha256: string | null,
    readonly actualBundleSha256: string | null,
  ) {
    super(`Skill ${skillId} changed concurrently: expected bundle ${expectedBundleSha256 ?? "none"}, found ${actualBundleSha256 ?? "none"}.`);
    this.name = "SkillVersionConflictError";
  }
}
