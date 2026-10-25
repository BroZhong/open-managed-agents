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
  /** An Environment's builds, newest first, deleted or not. */
  listBuilds(environmentId: string): Promise<EnvironmentBuild[]>;
}
