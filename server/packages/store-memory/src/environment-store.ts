import {
  EnvironmentNameConflictError,
  environmentDefinitionSha256,
  newEnvironmentBuildId,
  type ClaimedEnvironmentBuild,
  type Environment,
  type EnvironmentBaseImage,
  type EnvironmentBuild,
  type EnvironmentBuildLease,
  type EnvironmentBuildQueue,
  type EnvironmentBuildRenewal,
  type EnvironmentOwner,
  type EnvironmentStore,
  type EnvironmentStoreCreateInput,
  type EnvironmentStoreUpdateInput,
  type SandboxEnvironmentRecord,
} from "@oma-server/store";

function validateLeaseMs(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new RangeError("Environment Build lease must be a positive integer of milliseconds");
}

type StoredEnvironment = Omit<Environment, "lastBuild"> & { lastBuildId: string; deletedAt: Date | null };

const owns = (owner: EnvironmentOwner, env: StoredEnvironment) =>
  owner.ownerType === "platform" ? env.ownerType === "platform" : env.ownerType === "tenant" && env.tenantId === owner.tenantId;

/**
 * In-memory {@link EnvironmentStore} and {@link EnvironmentBuildQueue} with
 * the PostgreSQL store's semantics. `now` stands in for the database clock
 * that judges leases.
 */
export class InMemoryEnvironmentStore implements EnvironmentStore, EnvironmentBuildQueue {
  private environments = new Map<string, StoredEnvironment>();
  /** Insertion order is build order. */
  private builds: EnvironmentBuild[] = [];
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async list(tenantId: string): Promise<Environment[]> {
    const visible = [...this.environments.values()].filter((env) => this.visible(tenantId, env));
    const rank = (env: StoredEnvironment) => (env.ownerType === "platform" ? 0 : 1);
    visible.sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
    return visible.map((env) => this.view(env));
  }

  async get(tenantId: string, id: string): Promise<Environment | null> {
    const env = this.environments.get(id);
    return env && this.visible(tenantId, env) ? this.view(env) : null;
  }

  async listForSessions(tenantId: string, ids: readonly string[]): Promise<Environment[]> {
    return [...new Set(ids)].flatMap((id) => {
      const env = this.environments.get(id);
      return env && (env.ownerType === "platform" || env.tenantId === tenantId) ? [this.view(env)] : [];
    });
  }

  async getForSandbox(tenantId: string, id: string): Promise<SandboxEnvironmentRecord | null> {
    const env = this.environments.get(id);
    if (!env || (env.ownerType !== "platform" && env.tenantId !== tenantId)) return null;
    return structuredClone({ id: env.id, tenantId: env.tenantId, image: env.image, env: env.env, encryptedSecrets: env.encryptedSecrets });
  }

  /**
   * Build an Environment where no image builder runs (tests): claim its
   * active build and complete it the way the builder does, so `image` now
   * serves its new Sandboxes and the Environment is ready.
   */
  async buildNow(environmentId: string, image: string, manifest: Record<string, unknown> = {}): Promise<void> {
    const build = this.builds.find((candidate) => candidate.environmentId === environmentId && candidate.status === "pending");
    if (!build) throw new Error(`Environment ${environmentId} has no pending build`);
    const { lease } = this.claim(build, "in-memory-builder", 60_000);
    if (!await this.succeedBuild(lease, { image, manifest })) throw new Error(`Environment ${environmentId}'s build was not recorded`);
  }

  async create(input: EnvironmentStoreCreateInput): Promise<Environment> {
    if (this.environments.has(input.id)) throw new Error(`Environment ${input.id} already exists`);
    this.assertNameFree(input.owner, input.name);
    const now = new Date();
    const env: StoredEnvironment = {
      id: input.id,
      ownerType: input.owner.ownerType,
      tenantId: input.owner.ownerType === "tenant" ? input.owner.tenantId : null,
      name: input.name,
      description: input.description,
      baseImage: input.baseImage,
      initScript: input.initScript,
      env: structuredClone(input.env),
      encryptedSecrets: { ...input.encryptedSecrets },
      status: "pending",
      image: null,
      manifest: null,
      lastBuildId: "",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    env.lastBuildId = this.queueBuild(env, input.baseImage, input.initScript, now);
    this.environments.set(env.id, env);
    return this.view(env);
  }

  async update(owner: EnvironmentOwner, id: string, input: EnvironmentStoreUpdateInput): Promise<Environment | null> {
    const env = this.environments.get(id);
    if (!env || env.deletedAt || !owns(owner, env)) return null;
    if (input.name !== undefined && input.name !== env.name) this.assertNameFree(owner, input.name, id);
    const now = new Date();
    const baseImage = input.baseImage ?? env.baseImage;
    const initScript = input.initScript ?? env.initScript;
    if (baseImage !== env.baseImage || initScript !== env.initScript) {
      this.supersedeActiveBuild(id, now);
      env.lastBuildId = this.queueBuild(env, baseImage, initScript, now);
      env.status = "pending";
    }
    if (input.name !== undefined) env.name = input.name;
    if (input.description !== undefined) env.description = input.description;
    env.baseImage = baseImage;
    env.initScript = initScript;
    if (input.env !== undefined) env.env = structuredClone(input.env);
    if (input.encryptedSecrets !== undefined) env.encryptedSecrets = { ...input.encryptedSecrets };
    env.updatedAt = now;
    return this.view(env);
  }

  async delete(owner: EnvironmentOwner, id: string): Promise<boolean> {
    const env = this.environments.get(id);
    if (!env || env.deletedAt || !owns(owner, env)) return false;
    const now = new Date();
    env.deletedAt = now;
    env.updatedAt = now;
    this.supersedeActiveBuild(id, now);
    return true;
  }

  async rebuild(owner: EnvironmentOwner, id: string): Promise<Environment | null> {
    const env = this.environments.get(id);
    if (!env || env.deletedAt || !owns(owner, env)) return null;
    const now = new Date();
    this.supersedeActiveBuild(id, now);
    env.lastBuildId = this.queueBuild(env, env.baseImage, env.initScript, now);
    env.status = "pending";
    return this.view(env);
  }

  async listBuilds(environmentId: string): Promise<EnvironmentBuild[]> {
    return this.builds.filter((build) => build.environmentId === environmentId).reverse().map((build) => structuredClone(build));
  }

  async getBuild(environmentId: string, buildId: string): Promise<EnvironmentBuild | null> {
    const build = this.builds.find((candidate) => candidate.id === buildId && candidate.environmentId === environmentId);
    return build ? structuredClone(build) : null;
  }

  async claimBuild(owner: string, leaseMs: number): Promise<ClaimedEnvironmentBuild | null> {
    if (!owner) throw new RangeError("Environment Build lease owner must not be empty");
    validateLeaseMs(leaseMs);
    const now = this.now();
    const build = this.builds.find((candidate) => candidate.status === "pending" || (candidate.status === "running" && candidate.leaseExpiresAt! <= now));
    return build ? this.claim(build, owner, leaseMs) : null;
  }

  private claim(build: EnvironmentBuild, owner: string, leaseMs: number): ClaimedEnvironmentBuild {
    const now = this.now();
    const reclaimed = build.status === "running";
    build.status = "running";
    build.attempts += 1;
    build.leaseOwner = owner;
    build.leaseExpiresAt = new Date(now.getTime() + leaseMs);
    build.startedAt ??= now;
    const env = this.environments.get(build.environmentId);
    if (env && !env.deletedAt && env.lastBuildId === build.id) env.status = "building";
    return {
      build: structuredClone(build),
      lease: { buildId: build.id, owner, attempt: build.attempts },
      env: structuredClone(env?.env ?? []),
      reclaimed,
    };
  }

  async renewBuild(lease: EnvironmentBuildLease, leaseMs: number): Promise<EnvironmentBuildRenewal> {
    validateLeaseMs(leaseMs);
    const build = this.builds.find((candidate) => candidate.id === lease.buildId);
    if (build?.status === "superseded") return "superseded";
    const held = this.held(lease, true);
    if (!held) return "lost";
    held.leaseExpiresAt = new Date(this.now().getTime() + leaseMs);
    return "renewed";
  }

  async retryBuild(lease: EnvironmentBuildLease, leaseMs: number): Promise<EnvironmentBuildLease | null> {
    validateLeaseMs(leaseMs);
    const held = this.held(lease, true);
    if (!held) return null;
    held.attempts += 1;
    held.leaseExpiresAt = new Date(this.now().getTime() + leaseMs);
    return { ...lease, attempt: held.attempts };
  }

  async releaseBuild(lease: EnvironmentBuildLease): Promise<boolean> {
    const held = this.held(lease, false);
    if (held) held.leaseExpiresAt = this.now();
    return !!held;
  }

  async recordBuildProgress(lease: EnvironmentBuildLease, progress: { baseImageDigest?: string; logKey?: string }): Promise<boolean> {
    const held = this.held(lease, false);
    if (!held) return false;
    held.baseImageDigest = progress.baseImageDigest ?? held.baseImageDigest;
    held.logKey = progress.logKey ?? held.logKey;
    return true;
  }

  async succeedBuild(lease: EnvironmentBuildLease, result: { image: string; manifest: Record<string, unknown> }): Promise<boolean> {
    return this.finish(lease, "succeeded", (build, env) => {
      build.image = result.image;
      build.manifest = structuredClone(result.manifest);
      if (env) {
        env.status = "ready";
        env.image = result.image;
        env.manifest = structuredClone(result.manifest);
      }
    });
  }

  async failBuild(lease: EnvironmentBuildLease, error: { code: string; message: string }): Promise<boolean> {
    return this.finish(lease, "failed", (build, env) => {
      build.errorCode = error.code;
      build.errorMessage = error.message;
      if (env) env.status = "failed";
    });
  }

  async getBuiltIn(id: string): Promise<Environment | null> {
    const env = this.environments.get(id);
    return env && env.ownerType === "platform" && !env.deletedAt ? this.view(env) : null;
  }

  async listBuiltOnOtherBaseImage(baseImage: EnvironmentBaseImage, digest: string): Promise<Array<{ id: string; owner: EnvironmentOwner }>> {
    return [...this.environments.values()]
      .filter((env) => {
        const build = this.builds.find((candidate) => candidate.id === env.lastBuildId);
        return env.baseImage === baseImage && !env.deletedAt && !!build
          && (build.status === "succeeded" || build.status === "failed") && build.baseImageDigest !== digest;
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((env): { id: string; owner: EnvironmentOwner } => ({
        id: env.id,
        owner: env.ownerType === "platform" ? { ownerType: "platform" } : { ownerType: "tenant", tenantId: env.tenantId! },
      }));
  }

  /** The build `lease` holds; with `live`, only while the lease has not expired. */
  private held(lease: EnvironmentBuildLease, live: boolean): EnvironmentBuild | undefined {
    const build = this.builds.find((candidate) => candidate.id === lease.buildId);
    if (!build || build.status !== "running" || build.leaseOwner !== lease.owner || build.attempts !== lease.attempt) return undefined;
    if (live && !(build.leaseExpiresAt! > this.now())) return undefined;
    return build;
  }

  /** End a held build; `record` gets its Environment only while the build is still the latest. */
  private finish(
    lease: EnvironmentBuildLease,
    status: "succeeded" | "failed",
    record: (build: EnvironmentBuild, env: StoredEnvironment | undefined) => void,
  ): boolean {
    const build = this.held(lease, false);
    if (!build) return false;
    build.status = status;
    build.finishedAt = this.now();
    const env = this.environments.get(build.environmentId);
    record(build, env && !env.deletedAt && env.lastBuildId === build.id ? env : undefined);
    return true;
  }

  private visible(tenantId: string, env: StoredEnvironment): boolean {
    return !env.deletedAt && (env.ownerType === "platform" || env.tenantId === tenantId);
  }

  private assertNameFree(owner: EnvironmentOwner, name: string, exceptId?: string): void {
    for (const env of this.environments.values()) {
      if (env.id !== exceptId && !env.deletedAt && env.name === name && owns(owner, env)) throw new EnvironmentNameConflictError(name);
    }
  }

  private supersedeActiveBuild(environmentId: string, now: Date): void {
    for (const build of this.builds) {
      if (build.environmentId === environmentId && (build.status === "pending" || build.status === "running")) {
        build.status = "superseded";
        build.finishedAt = now;
      }
    }
  }

  private queueBuild(env: StoredEnvironment, baseImage: EnvironmentBaseImage, initScript: string, now: Date): string {
    const build: EnvironmentBuild = {
      id: newEnvironmentBuildId(),
      environmentId: env.id,
      ownerType: env.ownerType,
      tenantId: env.tenantId,
      status: "pending",
      baseImage,
      initScript,
      definitionSha256: environmentDefinitionSha256(baseImage, initScript),
      baseImageDigest: null,
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      image: null,
      manifest: null,
      logKey: null,
    };
    this.builds.push(build);
    return build.id;
  }

  private view(env: StoredEnvironment): Environment {
    const { lastBuildId, deletedAt: _deleted, ...rest } = env;
    const build = this.builds.find((candidate) => candidate.id === lastBuildId);
    return structuredClone({
      ...rest,
      lastBuild: build ? {
        id: build.id, status: build.status, createdAt: build.createdAt, startedAt: build.startedAt,
        finishedAt: build.finishedAt, errorCode: build.errorCode, errorMessage: build.errorMessage,
      } : null,
    });
  }
}
