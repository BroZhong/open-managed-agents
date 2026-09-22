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
import type { SandboxActivity, SandboxLifecycleStore } from '@oma-server/store';
import { setTimeout as delay } from 'node:timers/promises';
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
  /** Explicit Session binding allowlist. Omitted means the rollout is disabled. */
  lifecycle?: { store: SandboxLifecycleStore; bindingIds: ReadonlySet<string> };
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
  beginActivity?(activity: SandboxActivity, signal?: AbortSignal): Promise<boolean>;
  finishActivity?(activity: SandboxActivity): Promise<void>;
  sweepIdle?(): Promise<void>;
  open(spec: EnvSpec, binding?: SandboxEnvironmentBinding): SandboxSession;
  list(filter?: {
    tenantId?: string;
    workspaceId?: string;
  }): Promise<SandboxDescriptor[]>;
  reclaim(sandboxId: string): Promise<void>;
}

/** Infrastructure capability supplied separately from the serializable recipe. */
export interface SandboxEnvironmentBinding {
  id?: string;
  withLock<T>(callback: (sandboxId: string | null) => Promise<{ sandboxId: string | null; value: T }>): Promise<T>;
  /** Evaluated inside withLock immediately before reclamation. */
  canReclaim?(): Promise<boolean>;
}

export interface SandboxSession {
  executionSettled?(): boolean;
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
  async beginActivity(activity: SandboxActivity, signal?: AbortSignal): Promise<boolean> {
    const lifecycle = this.deps.lifecycle;
    if (!lifecycle?.bindingIds.has(activity.bindingId)) return false;
    while (!await lifecycle.store.begin(activity)) {
      await delay(250, undefined, { signal });
    }
    return true;
  }
  async finishActivity(activity: SandboxActivity): Promise<void> {
    await this.deps.lifecycle?.store.finish(activity);
  }
  async sweepIdle(): Promise<void> {
    const lifecycle = this.deps.lifecycle;
    if (!lifecycle) return;
    const errors: unknown[] = [];
    for (const bindingId of lifecycle.bindingIds) {
      try {
        const ticket = await lifecycle.store.claimReclamation(bindingId);
        if (!ticket) continue;
        // Ticket commits before external I/O. A lost DB connection cannot reopen
        // this binding while a delayed destroy is still in flight.
        await this.deps.sandboxClient.reconnect?.(ticket.sandboxId, {});
        await this.deps.sandboxClient.destroy(ticket.sandboxId);
        await lifecycle.store.completeReclamation(ticket);
      } catch (error) {
        // One failed gateway deletion must not starve other known-idle bindings.
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Sandbox idle sweep failed for multiple bindings');
  }
  open(spec: EnvSpec, binding?: SandboxEnvironmentBinding): SandboxSession {
    if (this.deps.lifecycle && !binding?.id) throw new Error('Managed Sandbox lifecycle requires durable environment bindings');
    return new SandboxSessionImpl(this.deps, spec, binding);
  }
  async list(_filter?: {
    tenantId?: string;
    workspaceId?: string;
  }): Promise<SandboxDescriptor[]> {
    return [];
  }
  async reclaim(sandboxId: string): Promise<void> {
    if (this.deps.lifecycle) throw new Error('Managed Sandbox reclamation requires a binding and a durable reclamation ticket');
    await this.deps.sandboxClient.destroy(sandboxId);
  }
}

class SandboxSessionImpl implements SandboxSession {
  executionSettled(): boolean {
    return !this.pendingCleanupId && (!this.sandboxId || !this.deps.sandboxClient.hasUncertainExecution(this.sandboxId));
  }
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
    private readonly binding?: SandboxEnvironmentBinding,
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
    const refresh = async (id: string | null) => {
      this.sandboxId = id ?? undefined;
      if (!id) return { sandboxId: null, value: undefined };
      if (await this.deps.sandboxClient.reconnect?.(id, this.metadata()) === false ||
        !(await this.deps.sandboxClient.isAlive(id))) {
        this.sandboxId = undefined;
        return { sandboxId: null, value: undefined };
      }
      await this.verify(id);
      if (this.binding) {
        // Only Host-managed Skill roots live under /skills. Discover old roots
        // after restart so renamed/unequipped projections can be removed.
        // Agents without equipped Skills need no /skills directory. Probe it
        // read-only: the ordinary Sandbox user cannot create paths under /.
        for (const entry of await this.deps.sandboxClient.list(id, "/skills", { missingOk: true })) {
          const name = /^\/skills\/([^/]+)\//.exec(entry.path)?.[1];
          if (name && name !== "." && name !== "..") this.projectedPaths.add(`/skills/${name}`);
        }
      }
      for (const path of new Set([...this.projectedPaths, ...projections.map((projection) => projection.targetPath)])) {
        await this.deps.sandboxClient.remove(id, path);
        this.projectedPaths.delete(path);
      }
      await this.projectAll(id);
      return { sandboxId: id, value: undefined };
    };
    if (this.binding) await this.binding.withLock(refresh);
    else await refresh(this.sandboxId ?? null);
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
      const lifecycle = this.deps.lifecycle;
      if (this.binding?.id && lifecycle?.bindingIds.has(this.binding.id)) {
        const ticket = await lifecycle.store.claimReclamation(this.binding.id, true);
        if (ticket) {
          await this.deps.sandboxClient.reconnect?.(ticket.sandboxId, this.metadata());
          await this.deps.sandboxClient.destroy(ticket.sandboxId);
          await lifecycle.store.completeReclamation(ticket);
        }
        if (ticket) this.sandboxId = undefined;
        return;
      }
      const destroy = async (id: string | null) => {
        if (this.binding?.canReclaim && !await this.binding.canReclaim()) return { sandboxId: id, value: undefined };
        if (id) {
          await this.deps.sandboxClient.reconnect?.(id, this.metadata());
          await this.deps.sandboxClient.destroy(id);
        }
        return { sandboxId: null, value: undefined };
      };
      if (this.binding) await this.binding.withLock(destroy);
      else await destroy(this.sandboxId ?? null);
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
      const ensure = this.binding
        ? this.binding.withLock(async (storedId) => {
            this.sandboxId = storedId ?? undefined;
            if (storedId && await this.deps.sandboxClient.reconnect?.(storedId, this.metadata()) === false) this.sandboxId = undefined;
            const id = await this.ensureLive();
            return { sandboxId: id, value: id };
          })
        : this.ensureLive();
      this.ensuring = ensure.finally(() => {
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
    const managed = Boolean(this.binding?.id && this.deps.lifecycle?.bindingIds.has(this.binding.id));
    const handle = await this.deps.sandboxClient.create({
      image: this.spec.image,
      env: this.spec.env,
      ...(managed ? { neverTimeout: true } : { timeoutSeconds: this.deps.defaults?.lifetimeSeconds ?? 3600 }),
      metadata: this.metadata(),
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
  private metadata(): Record<string, string> {
    return {
      ...(this.binding?.id ? { 'oma.dev/binding': this.binding.id } : {}),
      "oma.dev/tenant": this.spec.tenantId,
      "oma.dev/workspace": this.spec.workspaceId,
      ...workspaceMountMetadata(this.spec.workspaceMount, SANDBOX_WORKSPACE_ROOT),
    };
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
