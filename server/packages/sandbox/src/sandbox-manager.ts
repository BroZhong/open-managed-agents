import type {
  ExecOptions,
  ExecOutputChunk,
  FileListEntry,
  ToolExecutor,
  ToolFileSystem,
  ToolFileSystemOptions,
} from "@open-managed-agents/adapter-core";
import { SANDBOX_WORKSPACE_ROOT, ExecAbortedBeforeStartError } from "@open-managed-agents/adapter-core";
import { SANDBOX_RUNNING_SECONDS, SANDBOX_IDLE_SECONDS } from "./sandbox-client.js";
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
  /** Business execution/queue coordination and explicit termination only. */
  lifecycle?: SandboxLifecycleStore;
  sandboxClient: SandboxClient;
  provisionSources: Record<string, ProvisionSource>;
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

class BindingCreationPending extends Error {}

/** Creates independent Session resources; their OSS Workspace may be shared. */
export interface SandboxManager {
  beginActivity?(activity: SandboxActivity, signal?: AbortSignal): Promise<boolean>;
  finishActivity?(activity: SandboxActivity): Promise<void>;
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
  withLock<T>(callback: (sandboxId: string | null, creationPending?: boolean) => Promise<{ sandboxId: string | null; creationPending?: boolean; value: T }>): Promise<T>;
  canExecute?(): Promise<boolean>;
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
    const store = this.deps.lifecycle;
    if (!store) return false;
    const deadline = Date.now() + 185_000;
    while (!await store.begin(activity)) {
      if (Date.now() >= deadline) throw new Error('Sandbox termination cleanup is still pending; retry later');
      await delay(250, undefined, { signal });
    }
    return true;
  }
  async finishActivity(activity: SandboxActivity): Promise<void> {
    const store = this.deps.lifecycle;
    await store?.finish(activity, id => this.deps.sandboxClient.setTimeout(id, SANDBOX_IDLE_SECONDS));
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
    return !this.uncertainTurn && (!this.sandboxId || !this.deps.sandboxClient.hasUncertainExecution(this.sandboxId));
  }
  readonly fileSystem: ToolFileSystem;
  private readonly target: WorkspaceMountTarget;
  private projections: readonly ReadonlyProjection[];
  /** Targets that may contain files, including a partially failed projection. */
  private readonly projectedPaths = new Set<string>();
  private sandboxId?: string;
  /** Only an in-flight create/rebuild is shared; failed provisioning can be retried. */
  private ensuring?: Promise<string>;
  private disposing?: Promise<void>;
  private closed = false;
  private prepared = false;
  private generation = 0;
  private uncertainTurn = false;
  private creationUnconfirmed = false;
  private recovering?: Promise<void>;

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
    const native = <T>(options: ToolFileSystemOptions | undefined, work: (fs: ToolFileSystem) => Promise<T>) => {
      options?.signal?.throwIfAborted();
      return this.perform(async id => {
        options?.signal?.throwIfAborted();
        if (!this.deps.sandboxClient.fileSystem) throw new Error('Sandbox client does not support native filesystem primitives');
        return work(this.deps.sandboxClient.fileSystem(id));
      });
    };
    this.fileSystem = {
      readFile: (path, options) => native(options, fs => fs.readFile(this.resolve(path), options)),
      writeFile: (path, content, options) => native(options, fs => fs.writeFile(this.resolve(path), content, options)),
      appendFile: (path, content, options) => native(options, fs => fs.appendFile(this.resolve(path), content, options)),
      access: (path, mode, options) => native(options, fs => fs.access(this.resolve(path), mode, options)),
      stat: (path, options) => native(options, fs => fs.stat(this.resolve(path), options)),
      lstat: (path, options) => native(options, fs => fs.lstat(this.resolve(path), options)),
      realpath: (path, options) => native(options, fs => fs.realpath(this.resolve(path), options)),
      readdir: (path, options) => native(options, fs => fs.readdir(this.resolve(path), options)),
      mkdir: (path, options) => native(options, fs => fs.mkdir(this.resolve(path), options)),
      createTempFile: options => native(options, fs => fs.createTempFile(options)),
    };


  }

  async *exec(
    command: string[],
    opts?: ExecOptions,
  ): AsyncIterable<ExecOutputChunk> {
    const id = await this.ensure();
    const generation = this.generation;
    let settled = false;
    try {
      yield* this.deps.sandboxClient.exec(id, command, {
        cwd: this.resolve(opts?.cwd ?? '.'), timeoutSeconds: opts?.timeoutSeconds,
        env: opts?.env, signal: opts?.signal,
        onExit: result => { settled = true; opts?.onExit?.(result); },
      });
    } catch (error) {
      if (error instanceof ExecAbortedBeforeStartError) { settled = true; throw error; }
      if (settled && error instanceof Error && error.name === 'AbortError') throw error;
      await this.operationFailed(id, generation, error);
    } finally {
      // return()/consumer abandonment bypasses catch. Reliable exit evidence,
      // not a sibling's reset of a shared transport flag, settles this command.
      if (!settled) this.uncertainTurn = true;
    }
  }

  async readFile(path: string): Promise<string> {
    return this.perform(id => this.deps.sandboxClient.readFile(id, this.resolve(path)));
  }
  async writeFile(path: string, content: string): Promise<void> {
    return this.perform(id => this.deps.sandboxClient.writeFile(id, this.resolve(path), content));
  }
  async list(globOrDir?: string): Promise<FileListEntry[]> {
    const pattern = globOrDir?.includes('*') ? globOrDir : undefined;
    const entries = await this.perform(id => this.deps.sandboxClient.list(id, this.resolve(pattern ? '.' : (globOrDir ?? '.'))));
    return entries.map(entry => ({ ...entry, path: this.toRelative(entry.path) }))
      .filter(entry => !pattern || matchGlob(pattern, entry.path));
  }
  private async perform<T>(operation: (id: string) => Promise<T>): Promise<T> {
    const id = await this.ensure();
    const generation = this.generation;
    try { return await operation(id); }
    catch (error) { return this.operationFailed(id, generation, error); }
  }
  private async operationFailed(id: string, generation: number, error: unknown): Promise<never> {
    if (this.deps.sandboxClient.hasUncertainExecution(id)) this.uncertainTurn = true;
    if (error instanceof ExecAbortedBeforeStartError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      this.uncertainTurn = true; // No local exit evidence on a file/RPC abort.
      throw error;
    }
    // Ordinary tool errors are not environment failures.
    if (error && typeof error === 'object' && (
      'exitCode' in error || ('name' in error && ['AbortError', 'FileNotFoundError', 'InvalidArgumentError'].includes(String(error.name))) ||
      ('code' in error && ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ENOTDIR', 'EISDIR', 'EINVAL'].includes(String(error.code)))
    )) throw error;
    this.uncertainTurn = true;
    let recovered = false;
    try {
      if (!this.recovering && generation === this.generation) {
        this.prepared = false;
        this.recovering = this.recover(id).finally(() => { this.recovering = undefined; });
      }
      await this.recovering;
      recovered = this.prepared;
    } catch { /* Unknown control-plane outcomes cannot justify replacement. */ }
    throw new Error(`Sandbox operation outcome is unconfirmed and may have side effects. The original operation was not replayed. ${recovered ? 'The environment is available for subsequent tools.' : 'Environment recovery is unconfirmed; a subsequent tool may retry preparation.'} Inspect files or external effects before deciding whether to request the operation again.`);
  }
  private async recover(failedId: string): Promise<void> {
    const restore = async (storedId: string | null) => {
      await this.assertExecutable();
      const id = storedId ?? this.sandboxId;
      if (!id) return { sandboxId: null, value: undefined };
      const state = await this.deps.sandboxClient.state(id);
      if (state === 'missing') {
        this.sandboxId = undefined;
        return { sandboxId: null, value: undefined };
      }
      // Never replace Running or unknown resources. Refresh a Running handle
      // only after an exception; ordinary tools do not perform this I/O.
      await this.prepareExisting(id);
      return { sandboxId: id, value: undefined };
    };
    if (this.binding) await this.binding.withLock(restore);
    else await restore(failedId);
    // A known missing environment stays cold until the next tool requests it.
  }

  async prepare(
    projections: readonly ReadonlyProjection[] = this.projections,
  ): Promise<void> {
    this.assertOpen();
    this.assertProjections(projections);
    if (this.ensuring) await this.ensuring;
    if (this.recovering) await this.recovering;
    this.projections = projections;
    this.prepared = false;
    this.uncertainTurn = false;
    const refresh = async (id: string | null, creationPending = false) => {
      await this.assertExecutable();
      if (creationPending) throw new Error('Sandbox creation is unconfirmed; automatic replacement is disabled');
      this.sandboxId = id ?? undefined;
      if (!id) return { sandboxId: null, value: undefined };
      if (!await this.deps.sandboxClient.reconnect(id, this.metadata())) {
        this.sandboxId = undefined;
        return { sandboxId: null, value: undefined };
      }
      this.deps.sandboxClient.resetExecutionUncertainty(id);
      await this.prepareExisting(id, false);
      return { sandboxId: id, value: undefined };
    };
    await this.withPreparationLock(refresh);
  }
  private async prepareExisting(id: string, connect = true): Promise<void> {
    if (connect && !await this.deps.sandboxClient.reconnect(id, this.metadata())) {
      throw new Error('Sandbox disappeared during preparation; retry a subsequent tool');
    }
    await this.verify(id);
    if (this.binding) {
      for (const entry of await this.deps.sandboxClient.list(id, '/skills', { missingOk: true })) {
        const name = /^\/skills\/([^/]+)\//.exec(entry.path)?.[1];
        if (name && name !== '.' && name !== '..') this.projectedPaths.add(`/skills/${name}`);
      }
    }
    for (const path of new Set([...this.projectedPaths, ...this.projections.map(projection => projection.targetPath)])) {
      await this.deps.sandboxClient.remove(id, path);
      this.projectedPaths.delete(path);
    }
    await this.projectAll(id);
    this.sandboxId = id;
    this.prepared = true;
    this.generation++;
  }
  async checkWorkspace(): Promise<void> {
    this.assertOpen();
    // No probe at Turn end: this cannot prove that arbitrary open handles saved.
    if (this.uncertainTurn) throw new WorkspaceMountUnavailable();
  }
  private async assertExecutable(): Promise<void> {
    this.assertOpen();
    if (this.binding?.canExecute && !await this.binding.canExecute()) throw new SandboxSessionClosed();
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.closed = true;
    this.disposing = (async () => {
      try {
        await this.ensuring;
      } catch {
        /* An ambiguous create keeps its finite native deadline and durable intent. */
      }
      const lifecycle = this.deps.lifecycle;
      const bindingId = this.binding?.id;
      if (lifecycle && bindingId) {
        const ticket = await lifecycle.claimReclamation(bindingId);
        if (ticket) {
          await this.deps.sandboxClient.destroy(ticket.sandboxId);
          await lifecycle.completeReclamation(ticket);
        }
        if (ticket) this.sandboxId = undefined;
        else if (this.binding) await this.binding.withLock(async id => {
          // Unknown business users may retain a pointer beyond native expiry.
          // Control-plane NotFound is sufficient to clear that vanished resource;
          // a Running/Paused resource remains untouched and is never resumed.
          if (id && await this.deps.sandboxClient.state(id) === 'missing') {
            this.sandboxId = undefined;
            return { sandboxId: null, value: undefined };
          }
          return { sandboxId: id, value: undefined };
        });
        return;
      }
      const destroy = async (id: string | null) => {
        if (this.binding?.canReclaim && !await this.binding.canReclaim()) return { sandboxId: id, value: undefined };
        if (id) {
          await this.deps.sandboxClient.destroy(id);
        }
        return { sandboxId: null, value: undefined };
      };
      if (this.binding) await this.binding.withLock(destroy);
      else await destroy(this.sandboxId ?? null);
      this.sandboxId = undefined;

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
    if (this.recovering) await this.recovering;
    if (this.creationUnconfirmed) throw new Error('Sandbox creation or binding commit is unconfirmed; automatic replacement is disabled');
    if (this.prepared && this.sandboxId) return this.sandboxId;
    if (!this.ensuring) this.ensuring = this.ensurePrepared().finally(() => { this.ensuring = undefined; });
    const id = await this.ensuring;
    this.assertOpen();
    return id;
  }
  private async withPreparationLock<T>(work: (id: string | null) => Promise<{ sandboxId: string | null; creationPending?: boolean; value: T }>): Promise<T> {
    if (!this.binding) return (await work(this.sandboxId ?? null)).value;
    const deadline = Date.now() + 185_000;
    for (;;) {
      try {
        return await this.binding.withLock(async (id, pending) => {
          await this.assertExecutable();
          if (pending) throw new BindingCreationPending();
          return work(id);
        });
      } catch (error) {
        if (!(error instanceof BindingCreationPending)) throw error;
        if (Date.now() >= deadline) throw new Error('Sandbox creation is unconfirmed; automatic replacement is disabled');
        await delay(100);
      }
    }
  }
  private async ensurePrepared(): Promise<string> {
    // Commit intent before issuing create. A lost response or Runner crash must
    // leave an explicit ambiguous binding, not permission to allocate again.
    const reserve = async (id: string | null, creationPending = false) => {
      await this.assertExecutable();
      if (creationPending) throw new Error('Sandbox creation is unconfirmed; automatic replacement is disabled');
      if (id) {
        if (await this.deps.sandboxClient.reconnect(id, this.metadata())) {
          await this.prepareExisting(id, false);
          return { sandboxId: id, value: id };
        }
      }
      return { sandboxId: null, creationPending: true, value: null };
    };
    let existing: string | null;
    try { existing = await this.withPreparationLock(reserve); }
    catch (error) { this.prepared = false; throw error; }
    if (existing) return existing;
    this.creationUnconfirmed = true;
    const handle = await this.deps.sandboxClient.create({
      image: this.spec.image, env: this.spec.env,
      timeoutSeconds: SANDBOX_RUNNING_SECONDS, metadata: this.metadata(),
    }).catch(() => { throw new Error('Sandbox creation response is unconfirmed; automatic replacement is disabled. The platform retains a finite lifetime for any allocated resource.'); });
    const initialize = async (id: string | null) => {
      await this.assertExecutable();
      if (id && id !== handle.id) throw new Error('Sandbox binding changed during creation');
      let failure: unknown;
      try {
        await this.verify(handle.id);
        this.projectedPaths.clear();
        await this.projectAll(handle.id);
      } catch (error) { failure = error; }
      // Retain a known finite-lived resource even on preparation failure. The
      // next Turn can retry preparation, not allocate an untracked replacement.
      return { sandboxId: handle.id, creationPending: false, value: failure };
    };
    const failure = this.binding ? await this.binding.withLock(initialize) : (await initialize(null)).value;
    this.sandboxId = handle.id;
    this.creationUnconfirmed = false;
    if (failure) throw failure;
    this.assertOpen();
    this.prepared = true;
    this.generation++;
    return handle.id;
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
