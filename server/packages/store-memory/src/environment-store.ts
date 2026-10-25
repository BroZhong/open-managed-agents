import {
  EnvironmentNameConflictError,
  environmentDefinitionSha256,
  newEnvironmentBuildId,
  type Environment,
  type EnvironmentBaseImage,
  type EnvironmentBuild,
  type EnvironmentOwner,
  type EnvironmentStore,
  type EnvironmentStoreCreateInput,
  type EnvironmentStoreUpdateInput,
  type SandboxEnvironmentRecord,
} from "@oma-server/store";

type StoredEnvironment = Omit<Environment, "lastBuild"> & { lastBuildId: string; deletedAt: Date | null };

const owns = (owner: EnvironmentOwner, env: StoredEnvironment) =>
  owner.ownerType === "platform" ? env.ownerType === "platform" : env.ownerType === "tenant" && env.tenantId === owner.tenantId;

/** In-memory {@link EnvironmentStore} with the PostgreSQL store's semantics. */
export class InMemoryEnvironmentStore implements EnvironmentStore {
  private environments = new Map<string, StoredEnvironment>();
  /** Insertion order is build order. */
  private builds: EnvironmentBuild[] = [];

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
   * Stands in for the image builder (ADR-0024, "Building") where none runs:
   * the Environment's active build succeeded with `image`, which now serves
   * its new Sandboxes, and the Environment is ready.
   */
  succeedBuild(environmentId: string, image: string): void {
    const env = this.environments.get(environmentId);
    const build = this.builds.find((candidate) => candidate.environmentId === environmentId && (candidate.status === "pending" || candidate.status === "running"));
    if (!env || !build) throw new Error(`Environment ${environmentId} has no active build`);
    const now = new Date();
    Object.assign(build, { status: "succeeded", startedAt: build.startedAt ?? now, finishedAt: now, image });
    Object.assign(env, { status: "ready", image, updatedAt: now });
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

  async listBuilds(environmentId: string): Promise<EnvironmentBuild[]> {
    return this.builds.filter((build) => build.environmentId === environmentId).reverse().map((build) => structuredClone(build));
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
