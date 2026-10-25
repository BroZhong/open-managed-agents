/**
 * An Environment (ADR-0024): a platform Base Image, an init script and
 * environment variables, built once into an image that serves Sandboxes.
 *
 * Built-in Environments (`ownerType` `platform`, `tenantId` null, fixed ids
 * such as `env_video_production`) live in the same table as a Tenant's own;
 * they differ only in permissions, which the API enforces: every Tenant sees
 * them, none may change them. Names are unique per owner among Environments
 * that are not deleted.
 */
export type EnvironmentOwnerType = "platform" | "tenant";

/** The platform images an Environment builds on (`ENVIRONMENT_BASE_IMAGES`). */
export type EnvironmentBaseImage = "oma-base" | "oma-media";

/**
 * `pending` until the builder claims the active build, `building` while it
 * runs, then `ready` (its image now serves) or `failed` (the previous image,
 * if any, keeps serving). A change to `baseImage` or `initScript` makes it
 * `pending` again.
 */
export type EnvironmentStatus = "pending" | "building" | "failed" | "ready";

/**
 * A build is `pending` until a builder claims it with a lease, `running`
 * while that lease is held, and ends `succeeded`, `failed`, or `superseded`
 * when a newer change (or deletion of the Environment) replaced it before it
 * finished. At most one build per Environment is `pending` or `running`.
 */
export type EnvironmentBuildStatus = "pending" | "running" | "succeeded" | "failed" | "superseded";

/**
 * Where a secret's value comes from: `platform` (a deployment secret, only
 * obtained by copying a Built-in Environment) or `environment` (a Tenant
 * secret stored encrypted on this Environment under `key`).
 */
export type EnvironmentSecretSource = "platform" | "environment";

/**
 * One variable, in the shape the built-in definition files use
 * (`sandbox/environments/<name>/environment.json`): a plain value, or a
 * reference to a secret. Secret values never appear here.
 */
export type EnvironmentVariable =
  | { name: string; value: string }
  | { name: string; secretRef: { source: EnvironmentSecretSource; key: string } };

/** The latest build of an Environment, as shown with it. */
export interface EnvironmentBuildSummary {
  id: string;
  status: EnvironmentBuildStatus;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * One Environment Build, written in the transaction that changed its
 * Environment (ADR-0018: PG owns accepted work; the API executes nothing).
 * It snapshots what to build, so a builder never reads a half-changed
 * Environment; the builder claims it with `leaseOwner`/`leaseExpiresAt` and
 * records its outcome on it.
 */
export interface EnvironmentBuild extends EnvironmentBuildSummary {
  environmentId: string;
  ownerType: EnvironmentOwnerType;
  tenantId: string | null;
  baseImage: EnvironmentBaseImage;
  initScript: string;
  /** sha256 of the build definition, see `environmentDefinitionSha256`. */
  definitionSha256: string;
  /** The Base Image digest the builder resolved; null until it claims the build. */
  baseImageDigest: string | null;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  /** The pushed image (by digest) and its manifest; null until the build succeeds. */
  image: string | null;
  manifest: Record<string, unknown> | null;
  /** OSS key of the build log tail; null until the builder writes it. */
  logKey: string | null;
}

export interface Environment {
  id: string;
  ownerType: EnvironmentOwnerType;
  /** The owning Tenant; null for a Built-in Environment. */
  tenantId: string | null;
  name: string;
  description: string;
  baseImage: EnvironmentBaseImage;
  initScript: string;
  env: EnvironmentVariable[];
  /**
   * Tenant secret ciphertexts by `secretRef.key` (source `environment`),
   * sealed by the Host. Never returned by the API.
   */
  encryptedSecrets: Record<string, string>;
  status: EnvironmentStatus;
  /** The image (by digest) that serves Sandboxes; null until a build first succeeds. */
  image: string | null;
  /** The manifest of `image`: package and binary versions. */
  manifest: Record<string, unknown> | null;
  /** The most recent build, whatever its status. */
  lastBuild: EnvironmentBuildSummary | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * What a Session's Sandbox reads of its Environment (ADR-0024): the image
 * new Sandboxes are claimed with, and the variables injected into every
 * command, Tenant secrets still sealed.
 */
export type SandboxEnvironmentRecord = Pick<Environment, "id" | "tenantId" | "image" | "env" | "encryptedSecrets">;

/** Who may change an Environment: a Tenant its own, the platform its built-ins. */
export type EnvironmentOwner =
  | { ownerType: "tenant"; tenantId: string }
  | { ownerType: "platform" };

export interface EnvironmentStoreCreateInput {
  /** `newEnvironmentId()` for a Tenant; the fixed id for a Built-in Environment. */
  id: string;
  owner: EnvironmentOwner;
  name: string;
  description: string;
  baseImage: EnvironmentBaseImage;
  initScript: string;
  env: EnvironmentVariable[];
  encryptedSecrets: Record<string, string>;
}

/** Omitted fields keep their value; `env` and `encryptedSecrets` replace the whole set. */
export interface EnvironmentStoreUpdateInput {
  name?: string;
  description?: string;
  baseImage?: EnvironmentBaseImage;
  initScript?: string;
  env?: EnvironmentVariable[];
  encryptedSecrets?: Record<string, string>;
}

export interface EnvironmentStore {
  /**
   * Every Environment a Tenant can see that is not deleted: the built-ins
   * first, then its own, each by name.
   */
  list(tenantId: string): Promise<Environment[]>;
  /** A visible Environment (a built-in or the Tenant's own); null if absent or deleted. */
  get(tenantId: string, id: string): Promise<Environment | null>;
  /**
   * The Environments of `ids` the Tenant's Sessions can be frozen to: the
   * built-ins and its own, deleted ones included, since a Session keeps
   * running on a deleted Environment's image (ADR-0024). In no order.
   */
  listForSessions(tenantId: string, ids: readonly string[]): Promise<Environment[]>;
  /**
   * {@link SandboxEnvironmentRecord} of an Environment a Tenant's Session
   * runs in, deleted or not; null when the Tenant cannot see it. The Host
   * reads it for every command, so it reads nothing else.
   */
  getForSandbox(tenantId: string, id: string): Promise<SandboxEnvironmentRecord | null>;
  /**
   * Insert the Environment `pending` with its first build, in one
   * transaction. Throws `EnvironmentNameConflictError` when its owner already
   * has an Environment of that name.
   */
  create(input: EnvironmentStoreCreateInput): Promise<Environment>;
  /**
   * Change an Environment `owner` owns. A changed `baseImage` or `initScript`
   * supersedes the active build and queues a new one, making the Environment
   * `pending`, in the same transaction; any other change never builds. Null
   * when it is absent, deleted or not owned by `owner`.
   */
  update(owner: EnvironmentOwner, id: string, input: EnvironmentStoreUpdateInput): Promise<Environment | null>;
  /**
   * Soft-delete: hide it from `list` and `get`, keep the row and its image,
   * and supersede its active build. False when it is absent, already deleted
   * or not owned by `owner`.
   */
  delete(owner: EnvironmentOwner, id: string): Promise<boolean>;
  /**
   * Build the current definition again (`POST /v1/environments/{id}/build`):
   * supersede the active build and queue a new one, making the Environment
   * `pending`, in one transaction. Null when it is absent, deleted or not
   * owned by `owner`.
   */
  rebuild(owner: EnvironmentOwner, id: string): Promise<Environment | null>;
  /** An Environment's builds, newest first, deleted or not. */
  listBuilds(environmentId: string): Promise<EnvironmentBuild[]>;
  /** One of an Environment's builds; null when it has no build of that id. */
  getBuild(environmentId: string, buildId: string): Promise<EnvironmentBuild | null>;
}

/**
 * A builder's hold on a running build (ADR-0018). Every write the builder
 * makes to the build is fenced by it: a reclaim or a retry moves `attempt`
 * on, so a run that lost its lease can no longer change anything.
 */
export interface EnvironmentBuildLease {
  buildId: string;
  owner: string;
  /** The build's `attempts` when this lease was taken. */
  attempt: number;
}

/** A build a builder claimed, with what it needs to run it. */
export interface ClaimedEnvironmentBuild {
  build: EnvironmentBuild;
  lease: EnvironmentBuildLease;
  /**
   * The Environment's variables at claim time. Secret references carry no
   * value; the builder gives the script only the plain ones.
   */
  env: EnvironmentVariable[];
  /** The build was running under a lease that expired: an earlier attempt may have left a pod. */
  reclaimed: boolean;
}

/**
 * How a lease renewal ended: still held, the build `superseded` by a newer
 * change (or deletion), or the lease `lost` (expired or taken over).
 */
export type EnvironmentBuildRenewal = "renewed" | "superseded" | "lost";

/**
 * The image builder's side of Environment Builds (ADR-0024 "Building"). It
 * claims the oldest `pending` build, or a `running` one whose lease expired,
 * and records each step and the outcome under its lease. All lease decisions
 * use the database's clock.
 */
export interface EnvironmentBuildQueue {
  /**
   * Claim the oldest claimable build: mark it `running` under a new lease,
   * count the attempt, keep its first `startedAt`, and mark its Environment
   * `building` when the build is still the Environment's latest. Null when
   * none is claimable.
   */
  claimBuild(owner: string, leaseMs: number): Promise<ClaimedEnvironmentBuild | null>;
  /** Extend a lease that has not expired. */
  renewBuild(lease: EnvironmentBuildLease, leaseMs: number): Promise<EnvironmentBuildRenewal>;
  /**
   * Start another attempt of the same build under the same owner (an
   * infrastructure failure is retried): count it and extend the lease. Null
   * when the lease is no longer held.
   */
  retryBuild(lease: EnvironmentBuildLease, leaseMs: number): Promise<EnvironmentBuildLease | null>;
  /** Let the lease expire now, so the next builder reclaims the build at once (shutdown). */
  releaseBuild(lease: EnvironmentBuildLease): Promise<boolean>;
  /** Record the resolved Base Image digest and/or the log's OSS key. */
  recordBuildProgress(lease: EnvironmentBuildLease, progress: { baseImageDigest?: string; logKey?: string }): Promise<boolean>;
  /**
   * End the build `succeeded` with its image and manifest; when it is still
   * the Environment's latest build, that image now serves and the
   * Environment is `ready`. False, writing nothing, when the lease is no
   * longer held (a superseded build never replaces the image).
   */
  succeedBuild(lease: EnvironmentBuildLease, result: { image: string; manifest: Record<string, unknown> }): Promise<boolean>;
  /**
   * End the build `failed` with the error; the Environment becomes `failed`
   * when it is still its latest build and keeps its image. False, writing
   * nothing, when the lease is no longer held.
   */
  failBuild(lease: EnvironmentBuildLease, error: { code: string; message: string }): Promise<boolean>;
  /** A Built-in Environment by its fixed id; null when there is none or it is deleted. */
  getBuiltIn(id: string): Promise<Environment | null>;
  /**
   * Every Environment on `baseImage` that is not deleted and whose latest
   * build has finished (succeeded or failed) on another Base Image digest
   * than `digest` (`sha256:…`): what a new Base Image must rebuild. One
   * whose latest build is pending or running is not listed: that build runs
   * on the configured digest.
   */
  listBuiltOnOtherBaseImage(baseImage: EnvironmentBaseImage, digest: string): Promise<Array<{ id: string; owner: EnvironmentOwner }>>;
}
