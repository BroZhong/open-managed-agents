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
import type { SandboxClient } from "./sandbox-client.js";
import type { InstalledSkillSet, SandboxActivity, SandboxLifecycleStore, SkillBundleStore, SkillSetRecordOutcome } from '@oma-server/store';
import { setTimeout as delay } from 'node:timers/promises';
import { EMPTY_SKILL_SET, SkillInstaller, type SkillInstallBudget, type SkillInstallLedger, type SkillInstallReport, type SkillSet } from "./skill-install.js";
import {
  assertWorkspaceMountSpec,
  workspaceMountMetadata,
  WorkspaceMountUnavailable,
  type WorkspaceMountSpec,
  type WorkspaceMountTarget,
} from "./workspace-mount.js";

/** Host computes the trusted mount identity and the Skill Set to install. */
export interface EnvSpec {
  tenantId: string;
  workspaceId: string;
  workspaceMount: WorkspaceMountSpec;
  image?: string;
  env?: Record<string, string>;
  /** The Agent's equipped Skills; each Turn's `prepare` passes the current Set. Default: none. */
  skills?: SkillSet;
}

export interface SandboxManagerDeps {
  /** Business execution/queue coordination and explicit termination only. */
  lifecycle?: SandboxLifecycleStore;
  sandboxClient: SandboxClient;
  /** Signs the short-lived URLs a Skill Install downloads; required to install any Skill. */
  skillBundleStore?: Pick<SkillBundleStore, "createInstallUrl">;
  /** Skill Install budget calibration (ADR-0022): 20 MB/s with a 30 s floor by default. */
  skillInstallBudget?: SkillInstallBudget;
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
  /**
   * The binding's record of its last complete Skill Install. Without these
   * the Manager remembers installs per binding in this process only.
   */
  installedSkills?(): Promise<InstalledSkillSet | null>;
  /** Compare-and-set on the bound Sandbox and the switch generation (see `SkillSetRecordOutcome`). */
  recordSkillsInstalled?(installed: InstalledSkillSet): Promise<SkillSetRecordOutcome>;
}

/** Told of each Skill Install a session runs for a Turn, which records them (ADR-0022). */
export interface SkillInstallObserver {
  /** An install of `skills` starts: the binding does not record them for its Sandbox. */
  started(skills: SkillSet): void;
  /**
   * It ended: with its report, or with its error, a SkillInstallError, or
   * the Turn signal's reason when the Turn cancelled it.
   */
  ended(outcome: { report: SkillInstallReport } | { error: unknown }): void;
}

/** What a Turn hands the preparation of its session. */
export interface PrepareOptions {
  /**
   * The Turn's signal. Aborting it cancels an install still running for the
   * Turn: it is not retried, the binding records nothing, and the Turn's
   * operations waiting for it reject with the signal's reason.
   */
  signal?: AbortSignal;
  /** Told of every install the session runs until the next prepare, a cold Sandbox's included. */
  skillInstalls?: SkillInstallObserver;
}

export interface SandboxSession {
  executionSettled?(): boolean;
  readonly fileSystem: ToolFileSystem;
  exec(command: string[], opts?: ExecOptions): AsyncIterable<ExecOutputChunk>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  list(globOrDir?: string): Promise<FileListEntry[]>;
  /**
   * Recheck an existing mount and decide whether the Sandbox must install
   * `skills`: it does unless the binding records them for this Sandbox.
   * Resolves once that is known, a skipped install fully prepared; an install
   * runs on beside the Turn (ADR-0022). Every operation waits for it, so none
   * runs before it succeeded, and its failure (a SkillInstallError) or
   * cancellation fails each of them until the next prepare. Cold sessions
   * stay cold and install on creation, before their first operation.
   */
  prepare(skills?: SkillSet, options?: PrepareOptions): Promise<void>;
  /** Availability check only: never scans files or claims all open handles were saved. */
  checkWorkspace(): Promise<void>;
  /** Close execution resources. Completed writes already belong to the Workspace. */
  dispose(): Promise<void>;
}

export class DefaultSandboxManager implements SandboxManager {
  /** Shared by every session this manager opens: one install per binding at a time. */
  private readonly skillInstaller: SkillInstaller;
  constructor(private readonly deps: SandboxManagerDeps) {
    this.skillInstaller = new SkillInstaller({ client: deps.sandboxClient, bundles: deps.skillBundleStore, ...deps.skillInstallBudget });
  }
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
    return new SandboxSessionImpl(this.deps, this.skillInstaller, spec, binding);
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
  private skills: SkillSet;
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
  /** The Turn the session was last prepared for. */
  private turn: PrepareOptions = {};
  /**
   * The install prepare() left running. Operations wait for it; once it
   * failed or was cancelled, they rethrow its error until the next prepare.
   */
  private installing?: Promise<void>;

  constructor(
    private readonly deps: SandboxManagerDeps,
    private readonly skillInstaller: SkillInstaller,
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
    this.skills = spec.skills ?? EMPTY_SKILL_SET;

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
    // Latch what the client recorded as ending without an outcome before a
    // sibling's preparation can reset its shared flag.
    if (this.deps.sandboxClient.hasUncertainExecution(id)) this.uncertainTurn = true;
    if (error instanceof ExecAbortedBeforeStartError) throw error;
    // A cancellation is passed on, not taken as an unknown outcome: a native
    // filesystem operation rejects with it only before it starts or once its
    // outcome is known. exec latches a command cancelled without exit evidence.
    if (error instanceof Error && error.name === 'AbortError') throw error;
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
      if (!id) return { sandboxId: null, value: null };
      const state = await this.deps.sandboxClient.state(id);
      if (state === 'missing') {
        this.sandboxId = undefined;
        return { sandboxId: null, value: null };
      }
      // Never replace Running or unknown resources. Refresh a Running handle
      // only after an exception; ordinary tools do not perform this I/O.
      await this.attach(id);
      return { sandboxId: id, value: id };
    };
    const id = this.binding ? await this.binding.withLock(restore) : (await restore(failedId)).value;
    // A known missing environment stays cold until the next tool requests it.
    if (id) await this.finishPreparation(id);
  }

  async prepare(skills: SkillSet = this.skills, options: PrepareOptions = {}): Promise<void> {
    this.assertOpen();
    if (this.ensuring) await this.ensuring;
    if (this.recovering) await this.recovering;
    this.skills = skills;
    this.turn = options;
    this.installing = undefined;
    this.prepared = false;
    this.uncertainTurn = false;
    const refresh = async (id: string | null, creationPending = false) => {
      await this.assertExecutable();
      if (creationPending) throw new Error('Sandbox creation is unconfirmed; automatic replacement is disabled');
      this.sandboxId = id ?? undefined;
      if (!id) return { sandboxId: null, value: null };
      if (!await this.deps.sandboxClient.reconnect(id, this.metadata())) {
        this.sandboxId = undefined;
        return { sandboxId: null, value: null };
      }
      this.deps.sandboxClient.resetExecutionUncertainty(id);
      await this.attach(id, false);
      return { sandboxId: id, value: id };
    };
    const id = await this.withPreparationLock(refresh);
    if (!id) return;
    // Reconnecting, verifying the mount and deciding the install block the
    // Turn as before; the install itself runs beside it (ADR-0022).
    const install = await this.beginInstall(id);
    if (!install) { this.markPrepared(id); return; }
    this.installing = install.settled.then(() => this.markPrepared(id));
    // Each operation rethrows a failure; until one asks, it is not unhandled.
    this.installing.catch(() => {});
  }
  /** Reattach an existing Sandbox under binding coordination: its mount is verified again. */
  private async attach(id: string, connect = true): Promise<void> {
    if (connect && !await this.deps.sandboxClient.reconnect(id, this.metadata())) {
      throw new Error('Sandbox disappeared during preparation; retry a subsequent tool');
    }
    await this.verify(id);
    this.sandboxId = id;
  }
  /**
   * Make the verified Sandbox hold the current Skill Set and mark it usable:
   * a cold Sandbox's creation and recovery, on behalf of an operation that
   * waits for both.
   */
  private async finishPreparation(id: string): Promise<void> {
    await (await this.beginInstall(id))?.settled;
    this.markPrepared(id);
  }
  /**
   * Decide whether the verified Sandbox must install the current Skill Set
   * and start installing it, outside binding coordination: the install holds
   * no database lock or pooled client, and the binding records it by its own
   * compare-and-set. Resolves undefined when nothing is to be installed,
   * otherwise the install, which the Turn's observer hears about.
   */
  private async beginInstall(id: string): Promise<{ settled: Promise<void> } | undefined> {
    const { signal, skillInstalls } = this.turn;
    const skills = this.skills;
    let started = false;
    const pending = await this.skillInstaller.begin(this.binding?.id ?? this.binding ?? this, this.skillLedger(),
      { sandboxId: id, tenantId: this.spec.tenantId }, skills, {
        signal, onStart: () => { started = true; skillInstalls?.started(skills); },
      });
    if (!pending) return undefined;
    return { settled: pending.settled.then(
      (report) => { if (started && report) skillInstalls?.ended({ report }); },
      (error: unknown) => { if (started) skillInstalls?.ended({ error }); throw error; },
    ) };
  }
  private markPrepared(id: string): void {
    this.assertOpen();
    this.sandboxId = id;
    this.prepared = true;
    this.generation++;
  }
  private skillLedger(): SkillInstallLedger | undefined {
    const binding = this.binding;
    if (!binding?.installedSkills || !binding.recordSkillsInstalled) return undefined;
    return { installed: () => binding.installedSkills!(), record: installed => binding.recordSkillsInstalled!(installed) };
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
    // No business operation runs before the Turn's install succeeded.
    if (this.installing) await this.installing;
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
          await this.attach(id, false);
          return { sandboxId: id, value: id };
        }
      }
      return { sandboxId: null, creationPending: true, value: null };
    };
    let existing: string | null;
    try { existing = await this.withPreparationLock(reserve); }
    catch (error) { this.prepared = false; throw error; }
    if (existing) {
      await this.finishPreparation(existing);
      return existing;
    }
    this.creationUnconfirmed = true;
    const handle = await this.deps.sandboxClient.create({
      image: this.spec.image, env: this.spec.env,
      timeoutSeconds: SANDBOX_RUNNING_SECONDS, metadata: this.metadata(),
    }).catch(() => { throw new Error('Sandbox creation response is unconfirmed; automatic replacement is disabled. The platform retains a finite lifetime for any allocated resource.'); });
    const initialize = async (id: string | null) => {
      await this.assertExecutable();
      if (id && id !== handle.id) throw new Error('Sandbox binding changed during creation');
      let failure: unknown;
      try { await this.verify(handle.id); } catch (error) { failure = error; }
      // Retain a known finite-lived resource even on preparation failure. The
      // next Turn can retry preparation, not allocate an untracked replacement.
      return { sandboxId: handle.id, creationPending: false, value: failure };
    };
    const failure = this.binding ? await this.binding.withLock(initialize) : (await initialize(null)).value;
    this.sandboxId = handle.id;
    this.creationUnconfirmed = false;
    if (failure) throw failure;
    this.assertOpen();
    // A brand-new Sandbox installs once its mount is verified.
    await this.finishPreparation(handle.id);
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
