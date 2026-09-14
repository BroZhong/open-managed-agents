import type {
  ExecOptions,
  ExecOutputChunk,
  FileListEntry,
  ToolExecutor,
  ToolFileSystem,
  ToolFileSystemOptions,
} from "@open-managed-agents/adapter-core";
import { SANDBOX_WORKSPACE_ROOT } from "@open-managed-agents/adapter-core";
import type { SandboxClient, SandboxFsAccess } from "./sandbox-client.js";
import {
  assertProjectionOutsideWorkspace,
  type ProvisionSource,
  type ProjectionTarget,
  type ReadonlyProjection,
} from "./provision-source.js";
import {
  assertWorkspaceMountSpec,
  workspaceMountMetadata,
  WorkspaceMountUnavailable,
  type WorkspaceMountSpec,
  type WorkspaceMountTarget,
} from "./workspace-mount.js";

/** Host computes the trusted mount identity and read-only Skill projections. */
export interface EnvSpec {
  tenantId: string;
  workspaceId: string;
  workspaceMount: WorkspaceMountSpec;
  image?: string;
  env?: Record<string, string>;
  projections?: readonly ReadonlyProjection[];
}

export interface SandboxManagerDeps {
  sandboxClient: SandboxClient;
  provisionSources: Record<string, ProvisionSource>;
  defaults?: { lifetimeSeconds?: number };
}
export interface SandboxDescriptor {
  sandboxId: string;
  tenantId: string;
  workspaceId: string;
  createdAtMs: number;
}
export class SandboxSessionClosed extends Error {
  constructor() {
    super("SandboxSession has been disposed and can no longer be used");
    this.name = "SandboxSessionClosed";
  }
}

/** Creates independent Session resources; their OSS Workspace may be shared. */
export interface SandboxManager {
  open(spec: EnvSpec): SandboxSession;
  list(filter?: {
    tenantId?: string;
    workspaceId?: string;
  }): Promise<SandboxDescriptor[]>;
  reclaim(sandboxId: string): Promise<void>;
}

export interface SandboxSession {
  readonly fileSystem: ToolFileSystem;
  exec(command: string[], opts?: ExecOptions): AsyncIterable<ExecOutputChunk>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  list(globOrDir?: string): Promise<FileListEntry[]>;
  /** Recheck an existing mount and replace Skill projections; cold sessions stay cold. */
  prepare(projections?: readonly ReadonlyProjection[]): Promise<void>;
  /** Availability check only: never scans files or claims all open handles were saved. */
  checkWorkspace(): Promise<void>;
  /** Close execution resources. Completed writes already belong to the Workspace. */
  dispose(): Promise<void>;
}

export class DefaultSandboxManager implements SandboxManager {
  constructor(private readonly deps: SandboxManagerDeps) {}
  open(spec: EnvSpec): SandboxSession {
    return new SandboxSessionImpl(this.deps, spec);
  }
  async list(_filter?: {
    tenantId?: string;
    workspaceId?: string;
  }): Promise<SandboxDescriptor[]> {
    return [];
  }
  async reclaim(sandboxId: string): Promise<void> {
    await this.deps.sandboxClient.destroy(sandboxId);
  }
}

class SandboxSessionImpl implements SandboxSession {
  readonly fileSystem: ToolFileSystem;
  private readonly target: WorkspaceMountTarget;
  private projections: readonly ReadonlyProjection[];
  /** Targets that may contain files, including a partially failed projection. */
  private readonly projectedPaths = new Set<string>();
  private sandboxId?: string;
  private pendingCleanupId?: string;
  /** Only an in-flight create/rebuild is shared; failed provisioning can be retried. */
  private ensuring?: Promise<string>;
  private disposing?: Promise<void>;
  private closed = false;

  constructor(
    private readonly deps: SandboxManagerDeps,
    private readonly spec: EnvSpec,
  ) {
    const legacyRoot = (spec as EnvSpec & { workspaceDir?: unknown })
      .workspaceDir;
    if (legacyRoot !== undefined && legacyRoot !== SANDBOX_WORKSPACE_ROOT) {
      throw new Error(
        `Sandbox workspace root is fixed at ${SANDBOX_WORKSPACE_ROOT}`,
      );
    }
    assertWorkspaceMountSpec(
      spec.workspaceMount,
      spec.tenantId,
      spec.workspaceId,
    );
    this.target = {
      mountPath: SANDBOX_WORKSPACE_ROOT,
      bucket: spec.workspaceMount.bucket,
      prefix: spec.workspaceMount.prefix,
    };
    this.projections = spec.projections ?? [];
    this.assertProjections(this.projections);

    // Keep identity stable across sandbox reclamation: Pi scopes mutation
    // queues to this capability while each operation resolves the live handle.
    const current = async (options?: ToolFileSystemOptions) => {
      options?.signal?.throwIfAborted();
      const id = await this.ensure();
      options?.signal?.throwIfAborted();
      if (!this.deps.sandboxClient.fileSystem) throw new Error("Sandbox client does not support native filesystem primitives");
      return this.deps.sandboxClient.fileSystem(id);
    };
    this.fileSystem = {
      readFile: async (path, options) => (await current(options)).readFile(this.resolve(path), options),
      writeFile: async (path, content, options) => (await current(options)).writeFile(this.resolve(path), content, options),
      appendFile: async (path, content, options) => (await current(options)).appendFile(this.resolve(path), content, options),
      access: async (path, mode, options) => (await current(options)).access(this.resolve(path), mode, options),
      stat: async (path, options) => (await current(options)).stat(this.resolve(path), options),
      lstat: async (path, options) => (await current(options)).lstat(this.resolve(path), options),
      realpath: async (path, options) => (await current(options)).realpath(this.resolve(path), options),
      readdir: async (path, options) => (await current(options)).readdir(this.resolve(path), options),
      mkdir: async (path, options) => (await current(options)).mkdir(this.resolve(path), options),
      createTempFile: async (options) => (await current(options)).createTempFile(options),
    };


  }

  async *exec(
    command: string[],
    opts?: ExecOptions,
  ): AsyncIterable<ExecOutputChunk> {
    const id = await this.ensure();
    yield* this.deps.sandboxClient.exec(id, command, {
      cwd: this.resolve(opts?.cwd ?? "."),
      timeoutSeconds: opts?.timeoutSeconds,
      env: opts?.env,
      signal: opts?.signal,
      onExit: opts?.onExit,
    });
  }
  async readFile(path: string): Promise<string> {
    const id = await this.ensure();
    return this.deps.sandboxClient.readFile(id, this.resolve(path));
  }
  async writeFile(path: string, content: string): Promise<void> {
    const id = await this.ensure();
    await this.deps.sandboxClient.writeFile(id, this.resolve(path), content);
  }
  async list(globOrDir?: string): Promise<FileListEntry[]> {
    const id = await this.ensure();
    const pattern = globOrDir?.includes("*") ? globOrDir : undefined;
    const entries = await this.deps.sandboxClient.list(
      id,
      this.resolve(pattern ? "." : (globOrDir ?? ".")),
    );
    return entries
      .map((entry) => ({ ...entry, path: this.toRelative(entry.path) }))
      .filter((entry) => !pattern || matchGlob(pattern, entry.path));
  }

  async prepare(
    projections: readonly ReadonlyProjection[] = this.projections,
  ): Promise<void> {
    this.assertOpen();
    this.assertProjections(projections);
    this.projections = projections;
    if (this.ensuring) await this.ensuring;
    this.assertOpen();
    const id = this.sandboxId;
    if (!id || !(await this.deps.sandboxClient.isAlive(id))) return;
    await this.verify(id);
    for (const path of new Set(
      [...this.projectedPaths, ...projections.map((projection) => projection.targetPath)],
    )) {
      await this.deps.sandboxClient.remove(id, path);
      this.projectedPaths.delete(path);
    }
    await this.projectAll(id);
  }

  async checkWorkspace(): Promise<void> {
    this.assertOpen();
    if (this.ensuring) await this.ensuring;
    if (!this.sandboxId) return;
    // A vanished Sandbox leaves completed OSS writes intact, but availability
    // cannot be claimed until the next tool operation recreates and verifies it.
    if (!(await this.deps.sandboxClient.isAlive(this.sandboxId)))
      throw new WorkspaceMountUnavailable();
    await this.verify(this.sandboxId);
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.closed = true;
    this.disposing = (async () => {
      try {
        await this.ensuring;
      } catch {
        /* Failed create cleans up its resource. */
      }
      const id = this.sandboxId;
      if (id) await this.deps.sandboxClient.destroy(id);
      this.sandboxId = undefined;
      if (this.pendingCleanupId) {
        await this.deps.sandboxClient.destroy(this.pendingCleanupId);
        this.pendingCleanupId = undefined;
      }
    })().catch((error) => {
      this.disposing = undefined;
      throw error;
    });
    return this.disposing;
  }

  private assertOpen(): void {
    if (this.closed) throw new SandboxSessionClosed();
  }
  private assertProjections(projections: readonly ReadonlyProjection[]): void {
    for (const projection of projections)
      assertProjectionOutsideWorkspace(
        projection.targetPath,
        SANDBOX_WORKSPACE_ROOT,
      );
  }
  private async verify(id: string): Promise<void> {
    try {
      await this.deps.sandboxClient.verifyWorkspaceMount(id, this.target);
    } catch {
      throw new WorkspaceMountUnavailable();
    }
  }
  private async ensure(): Promise<string> {
    this.assertOpen();
    if (!this.ensuring) {
      this.ensuring = this.ensureLive().finally(() => {
        this.ensuring = undefined;
      });
    }
    const id = await this.ensuring;
    this.assertOpen();
    return id;
  }
  private async ensureLive(): Promise<string> {
    if (this.pendingCleanupId) {
      await this.deps.sandboxClient.destroy(this.pendingCleanupId);
      this.pendingCleanupId = undefined;
    }
    if (this.sandboxId) {
      if (await this.deps.sandboxClient.isAlive(this.sandboxId)) {
        await this.verify(this.sandboxId);
        return this.sandboxId;
      }
      const old = this.sandboxId;
      await this.deps.sandboxClient.destroy(old);
      this.sandboxId = undefined;
    }
    const handle = await this.deps.sandboxClient.create({
      image: this.spec.image,
      env: this.spec.env,
      timeoutSeconds: this.deps.defaults?.lifetimeSeconds ?? 3600,
      metadata: {
        "oma.dev/tenant": this.spec.tenantId,
        "oma.dev/workspace": this.spec.workspaceId,
        ...workspaceMountMetadata(
          this.spec.workspaceMount,
          SANDBOX_WORKSPACE_ROOT,
        ),
      },
    });
    try {
      await this.verify(handle.id);
      this.projectedPaths.clear(); // The replacement Sandbox has no old projections.
      await this.projectAll(handle.id);
      this.assertOpen();
      this.sandboxId = handle.id;
      return handle.id;
    } catch (error) {
      try {
        await this.deps.sandboxClient.destroy(handle.id);
      } catch {
        this.pendingCleanupId = handle.id;
      }
      throw error;
    }
  }
  private async projectAll(id: string): Promise<void> {
    for (const projection of this.projections) {
      const source = this.deps.provisionSources[projection.source.kind];
      if (!source)
        throw new Error(
          `No ProvisionSource registered for kind "${projection.source.kind}"`,
        );
      this.projectedPaths.add(projection.targetPath);
      await source.project(
        projection.source,
        this.projectionTarget(id, projection.targetPath),
      );
    }
  }
  private projectionTarget(id: string, targetPath: string): ProjectionTarget {
    const client = this.deps.sandboxClient;
    const fs: SandboxFsAccess = {
      writeFile: (path, body) => client.writeFile(id, path, body),
      readFile: (path) => client.readFile(id, path),
      writeFileBytes: (path, body) => client.writeFileBytes(id, path, body),
      readFileBytes: (path) => client.readFileBytes(id, path),
      remove: (path) => client.remove(id, path),
      list: (path) => client.list(id, path),
    };
    return {
      targetPath,
      fs,
      exec: (command, opts) => client.exec(id, command, opts),
    };
  }
  private resolve(path: string): string {
    if (path.startsWith("/")) return path;
    // The Sandbox is the execution boundary; local HOME and Skills stay reachable.
    const relative = path
      .replace(/^\.\//, "")
      .split("/")
      .filter((part) => part && part !== ".")
      .join("/");
    return relative
      ? `${SANDBOX_WORKSPACE_ROOT}/${relative}`
      : SANDBOX_WORKSPACE_ROOT;
  }
  private toRelative(path: string): string {
    const prefix = `${SANDBOX_WORKSPACE_ROOT}/`;
    return path.startsWith(prefix)
      ? path.slice(prefix.length)
      : path === SANDBOX_WORKSPACE_ROOT
        ? ""
        : path;
  }
}

function matchGlob(pattern: string, path: string): boolean {
  let expression = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          expression += "(?:.*/)?";
        } else expression += ".*";
      } else expression += "[^/]*";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) expression += "\\" + ch;
    else expression += ch;
  }
  return new RegExp("^" + expression + "$").test(path);
}
const assertToolExecutor = (session: SandboxSession): ToolExecutor => session;
void assertToolExecutor;
