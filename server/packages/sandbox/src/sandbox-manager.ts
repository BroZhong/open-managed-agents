import type {
  ExecOptions,
  ExecOutputChunk,
  FileListEntry,
  ToolExecutor,
  ToolFileSystem,
  ToolFileSystemOptions,
} from "@open-managed-agents/adapter-core";
import { SANDBOX_WORKSPACE_ROOT, ExecAbortedBeforeStartError, ToolEnvironmentError } from "@open-managed-agents/adapter-core";
import { INTENT_DEADLINE_SECONDS, SANDBOX_RUNNING_SECONDS, SANDBOX_IDLE_SECONDS, SandboxCreateRejected, intentExpired, intentExpiresAt } from "./sandbox-client.js";
import type { ListedSandbox, SandboxClient, SandboxHandle } from "./sandbox-client.js";
import { SANDBOX_BINDING_LABEL, SANDBOX_ENVIRONMENT_LABEL, byKeepPreference, type SandboxEnvironment } from "./sandbox-sweep.js";
import { killBindingSandboxes, killSandboxes } from "./sandbox-kill.js";
import { EnvironmentBindingChanged, type EnvironmentBinding, type EnvironmentLockResult, type EnvironmentTransition, type InstalledSkillSet, type SandboxActivity, type SandboxLifecycleStore, type SkillBundleStore, type SkillSetRecordOutcome } from '@oma-server/store';
import { BINDING_REREAD_MS, BindingChanges, signallingBinding, type EnvironmentSignals } from "./environment-signals.js";
import { EMPTY_SKILL_SET, SkillInstallError, SkillInstaller, type SkillInstallBudget, type SkillInstallLedger, type SkillInstallReport, type SkillSet } from "./skill-install.js";
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
  /**
   * Labels every Sandbox created (`oma.dev/environment`): each environment's
   * sweeper acts only on its own Sandboxes (ADR-0023).
   */
  environment: SandboxEnvironment;
  /** Signs the short-lived URLs a Skill Install downloads; required to install any Skill. */
  skillBundleStore?: Pick<SkillBundleStore, "createInstallUrl">;
  /** Skill Install budget calibration (ADR-0022): 20 MB/s with a 30 s floor by default. */
  skillInstallBudget?: SkillInstallBudget;
  /**
   * The bindings' `environment` hints across Runners (ADR-0023). Without them
   * a Turn waiting for a binding reads its row every 2 s alone.
   */
  environmentSignals?: EnvironmentSignals;
}
export interface SandboxDescriptor {
  sandboxId: string;
  tenantId: string;
  workspaceId: string;
  createdAtMs: number;
}
/** The Session was terminated: its Turn's Sandbox session runs nothing more. */
export class SandboxSessionClosed extends Error {
  constructor() {
    super("The Session was terminated: its Sandbox can no longer be used");
    this.name = "SandboxSessionClosed";
  }
}

const INTENT_DEADLINE_MS = INTENT_DEADLINE_SECONDS * 1000;
/**
 * The gateway's definite answers to a create: an invalid request (400), the
 * API key's quota (403), a conflict (409). It claimed nothing. Any other
 * failure, 5xx among them, is an unknown outcome: the gateway answers its
 * claim timeout, as any internal failure, with 500 (upstream
 * pkg/servers/e2b/create.go), whatever became of the claim.
 */
const DEFINITE_REJECTIONS: ReadonlySet<number> = new Set([400, 403, 409]);

/** Why the Session's Sandbox was not available to a tool call. */
export type SandboxUnavailableReason =
  /** The gateway definitely refused the create (`status`); the binding is Cold. */
  | "rejected"
  /** The call's creates, including the one more after reconciling an unknown outcome, did not complete. */
  | "unknown"
  /** The Sandbox's Workspace mount could not be verified. */
  | "mount"
  /** The Sandbox, the gateway or the binding could not be reached: connect, reconcile's list, the binding's row. */
  | "unreachable";

const UNAVAILABLE: Record<SandboxUnavailableReason, string> = {
  rejected: "The gateway rejected the Sandbox creation. A later tool call can retry.",
  unknown: "Sandbox creation did not complete. A later tool call can retry.",
  mount: new WorkspaceMountUnavailable().message,
  unreachable: "The Session's Sandbox could not be reached. The tool was not executed; a later tool call can retry.",
};

/**
 * The environment failure of a tool call (ADR-0023): the Session's Sandbox
 * was not ready, so the operation did not run. It is a tool error the model
 * can retry, carrying `code` and `reason` in the result's details, never the
 * end of the Turn. The message is stable: SDK and provider diagnostics can
 * carry credentials, and the error they came with is kept as the cause.
 */
export class SandboxUnavailable extends ToolEnvironmentError {
  declare readonly code: "sandbox_unavailable";
  constructor(readonly reason: SandboxUnavailableReason, readonly status?: number, options?: ErrorOptions) {
    super("sandbox_unavailable", UNAVAILABLE[reason], { reason }, options);
    this.name = "SandboxUnavailable";
  }
}

/**
 * What the operations waiting for a failed preparation see: a create's own
 * classification, or the kind of step that failed.
 */
function environmentFailure(error: unknown): SandboxUnavailable {
  if (error instanceof SandboxUnavailable) return error;
  return new SandboxUnavailable(error instanceof WorkspaceMountUnavailable ? "mount" : "unreachable", undefined, { cause: error });
}

/** Thrown inside the binding lock to leave it without a write while another Turn creates the Sandbox. */
class CreationInProgress extends Error {
  constructor(readonly remainingMs: number) { super("Sandbox creation in progress"); }
}

/** A create whose outcome is unknown: its intent stays, and ensure reconciles it past its deadline. */
class CreateOutcomeUnknown extends Error {
  constructor() { super("Sandbox create outcome is unknown"); }
}

/** What ensure does next, decided from the binding row alone. */
type EnsureStep =
  | { kind: "ready"; sandboxId: string }
  /** A confirmed missing Sandbox moved the binding to Cold. */
  | { kind: "retry" }
  | { kind: "wait"; ms: number }
  /** Unresolved: Creating past its deadline since `creatingSince`. */
  | { kind: "reconcile"; creatingSince: Date }
  /** The intent is committed; the read that decided it was at `notBefore`, by the database clock. */
  | { kind: "create"; notBefore: Date };

/**
 * Whether the binding still holds the creation intent committed right after
 * the read at `notBefore`. Another intent can be committed only once that
 * one is resolved, which no other Runner does before its deadline, so an
 * intent that began within a deadline of `notBefore` is that one.
 */
function holdsIntent(binding: EnvironmentBinding, notBefore: Date): boolean {
  const since = binding.creatingSince?.getTime();
  return binding.sandboxId === null && since !== undefined
    && since >= notBefore.getTime() && since < intentExpiresAt(notBefore);
}

/** Creates independent Session resources; their OSS Workspace may be shared. */
export interface SandboxManager {
  beginActivity?(activity: SandboxActivity, signal?: AbortSignal): Promise<boolean>;
  finishActivity?(activity: SandboxActivity): Promise<void>;
  open(spec: EnvSpec, binding: SandboxEnvironmentBinding): SandboxSession;
  list(filter?: {
    tenantId?: string;
    workspaceId?: string;
  }): Promise<SandboxDescriptor[]>;
  /**
   * Reclaim a terminated Session's binding by binding (ADR-0023, "Release
   * and reclamation"). True once the binding records no Sandbox and no
   * creation intent: reclaimed, or Cold while another Session still uses it.
   * False while it is retained; the caller retries.
   */
  reclaim(binding: SandboxEnvironmentBinding): Promise<boolean>;
}

/**
 * Infrastructure capability supplied separately from the serializable recipe:
 * the durable binding row, the only state a Sandbox session reads (ADR-0023).
 */
export interface SandboxEnvironmentBinding {
  /** The root Session's id, which every Sandbox of the binding carries as `oma.dev/binding`. */
  id: string;
  /** See `DelegationStore.withEnvironmentLock`. */
  withLock<T>(work: (binding: EnvironmentBinding) => Promise<EnvironmentLockResult<T>>): Promise<T>;
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

/** How one preparation of the Turn's environment ended (ADR-0023). */
export type SandboxPrepareOutcome =
  /** The Sandbox is connected, or created, and its mount verified. */
  | { outcome: "ready"; sandboxId: string }
  /**
   * The Turn-start connect found no Sandbox to connect: the recorded one is
   * gone, or the binding moved on. The first operation brings it to Ready.
   */
  | { outcome: "deferred" }
  /** An environment failure: each operation that waited for it fails with `error`. */
  | { outcome: "failed"; error: SandboxUnavailable }
  /** The Turn stopped waiting for it, or its Session was terminated, as `reason` says. */
  | { outcome: "aborted"; reason: unknown };

/**
 * Told of each preparation of the Turn's environment, which records them
 * (ADR-0023): the Turn-start connect of a Ready binding, and each operation's
 * ensure. One runs at a time.
 */
export interface SandboxPrepareObserver {
  started(): void;
  ended(outcome: SandboxPrepareOutcome): void;
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
  /** Told of every preparation of the environment until the next prepare. */
  sandboxPrepares?: SandboxPrepareObserver;
}

export interface SandboxSession {
  executionSettled?(): boolean;
  readonly fileSystem: ToolFileSystem;
  exec(command: string[], opts?: ExecOptions): AsyncIterable<ExecOutputChunk>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  list(globOrDir?: string): Promise<FileListEntry[]>;
  /**
   * Prepare the session for a Turn: connect to the Sandbox the binding
   * records, recheck its mount and decide whether it must install `skills`,
   * which it does unless the binding records them for this Sandbox. The Turn
   * does not wait for it (ADR-0023): every operation does, so none runs
   * before preparation and the install succeeded. Resolves once the install
   * is decided, a skipped install fully prepared; an install runs on beside
   * the Turn (ADR-0022). An environment failure (SandboxUnavailable)
   * fails the operations that waited for it, and the next one prepares
   * again; a failed install (a SkillInstallError) or a cancelled one fails
   * each of them until the next prepare. Cold sessions stay cold and install
   * on creation, before their first operation.
   */
  prepare(skills?: SkillSet, options?: PrepareOptions): Promise<void>;
  /** Availability check only: never scans files or claims all open handles were saved. */
  checkWorkspace(): Promise<void>;
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
    // No binding transition is waited for longer than a creation intent may
    // stay unresolved; termination's outbox retries a slower reclamation.
    const deadline = Date.now() + INTENT_DEADLINE_MS;
    // Heard from before the first attempt: the reclaimer's hint ends a wait at once.
    const changes = new BindingChanges(this.deps.environmentSignals, activity.bindingId);
    try {
      while (!await store.begin(activity)) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new Error('Sandbox termination cleanup is still pending; retry later');
        await changes.wait(Math.min(BINDING_REREAD_MS, remainingMs), signal);
      }
    } finally {
      changes.close();
    }
    return true;
  }
  async finishActivity(activity: SandboxActivity): Promise<void> {
    const store = this.deps.lifecycle;
    await store?.finish(activity, id => this.deps.sandboxClient.setTimeout(id, SANDBOX_IDLE_SECONDS));
  }
  open(spec: EnvSpec, binding: SandboxEnvironmentBinding): SandboxSession {
    return new SandboxSessionImpl(this.deps, this.skillInstaller, spec, signallingBinding(binding, this.deps.environmentSignals));
  }
  async list(_filter?: {
    tenantId?: string;
    workspaceId?: string;
  }): Promise<SandboxDescriptor[]> {
    return [];
  }
  reclaim(binding: SandboxEnvironmentBinding): Promise<boolean> {
    return reclaimBinding(this.deps, signallingBinding(binding, this.deps.environmentSignals));
  }
}

/**
 * Whether a create of the binding's creation intent may still be in flight:
 * until the intent's deadline, by the database clock, it can still produce a
 * Sandbox the gateway does not list yet.
 */
function creationMayBeInFlight({ creatingSince, now }: EnvironmentBinding): boolean {
  return creatingSince !== null && !intentExpired(creatingSince, now);
}

/**
 * Reclaim a terminated Session's binding (ADR-0023, "Release and
 * reclamation"). Once no other Session uses it (with the native lifecycle:
 * and no input is queued for it), kill the Sandbox it records and every one
 * the gateway lists for it, whether it records one, a creation intent or
 * nothing, and clear it to Cold only once all are confirmed missing. A failed
 * kill rejects and keeps the reclamation for the caller's retry.
 *
 * A binding Creating within its intent deadline stays retained after the
 * kills: its create may still produce a Sandbox the list did not show. With
 * the native lifecycle the reclamation stays claimed meanwhile, which refuses
 * the creator's binding write, and the first retry past the deadline, when no
 * create of the intent is in flight any more, lists and kills the Sandbox it
 * left. Without it, the creator records its Sandbox and that retry kills it
 * as the recorded one. A creator answering after the binding went Cold finds
 * no intent to record and kills its Sandbox itself; the sweeper (#291) kills
 * one whose kill failed.
 */
async function reclaimBinding({ lifecycle, sandboxClient: client, environmentSignals: signals }: SandboxManagerDeps, binding: SandboxEnvironmentBinding): Promise<boolean> {
  if (lifecycle) {
    const ticket = await lifecycle.claimReclamation(binding.id);
    if (!ticket) return binding.withLock<boolean>(async ({ sandboxId: id, creatingSince }) => {
      // Unknown business users may retain a pointer beyond native expiry.
      // Control-plane NotFound is sufficient to clear that vanished resource;
      // a Running/Paused resource remains untouched and is never resumed.
      if (id && await client.state(id) === 'missing') return { next: "cold", value: true };
      return { value: id === null && creatingSince === null };
    });
    await killBindingSandboxes(client, binding.id, ticket.sandboxId);
    if (creationMayBeInFlight(ticket)) return false;
    await lifecycle.completeReclamation(ticket);
    // Turns waiting for admission while it was reclaimed ask again now.
    signals?.publish(binding.id);
    return true;
  }
  try {
    return await binding.withLock<boolean>(async (row) => {
      if (binding.canReclaim && !await binding.canReclaim()) return { value: row.sandboxId === null && row.creatingSince === null };
      await killBindingSandboxes(client, binding.id, row.sandboxId);
      if (creationMayBeInFlight(row)) return { value: false };
      return { next: "cold", value: true };
    });
  } catch (error) {
    // A creator recorded its Sandbox meanwhile: the retry kills it as the recorded one.
    if (error instanceof EnvironmentBindingChanged) return false;
    throw error;
  }
}

/**
 * Converge an Unresolved binding, Creating since `creatingSince` and past its
 * deadline, on what the gateway holds for it (ADR-0023, "reconcile"): ensure's
 * and the sweeper's one transition. Past the deadline no create of the intent
 * is in flight: none found → Cold; one → adopt it; several → keep a running
 * one, else the earliest claimed. The list runs outside the binding's lock;
 * the move is a compare-and-set on the intent. Resolves the Sandbox kept
 * (undefined when it went Cold) and the others found, for the caller to kill;
 * null when the row no longer held that intent: another Runner reconciled it
 * first, or it moved on, and the caller follows the row.
 */
export async function reconcileBinding(client: Pick<SandboxClient, "listSandboxes">,
  binding: Pick<SandboxEnvironmentBinding, "id" | "withLock">, creatingSince: Date): Promise<{ kept?: ListedSandbox; duplicates: ListedSandbox[] } | null> {
  // By binding alone: its id is a Session id, unique across environments,
  // and a Sandbox created before the environment label is adopted too.
  const found = await client.listSandboxes({ metadata: { [SANDBOX_BINDING_LABEL]: binding.id }, states: ["running", "paused"] });
  const [kept, ...duplicates] = [...found].sort(byKeepPreference);
  const converged = await binding.withLock<boolean>(async (row) => {
    if (row.sandboxId !== null || row.creatingSince?.getTime() !== creatingSince.getTime()) return { value: false };
    return { next: kept ? { ready: kept.sandboxId } : "cold", value: true };
  });
  return converged ? { kept, duplicates } : null;
}

/**
 * The binding's row as a session last read it, or as a move it committed
 * left it; unknown after a move to Creating, whose time it does not learn.
 */
type KnownRow = Pick<EnvironmentBinding, "sandboxId" | "creatingSince">;

/** `binding`, telling `known` of each row the session reads and each move it commits. */
function knownBinding(binding: SandboxEnvironmentBinding, known: (row: KnownRow | undefined) => void): SandboxEnvironmentBinding {
  return {
    ...binding,
    withLock: async (work) => {
      let next: EnvironmentTransition | undefined;
      const value = await binding.withLock(async (row) => {
        known({ sandboxId: row.sandboxId, creatingSince: row.creatingSince });
        const result = await work(row);
        next = result.next;
        return result;
      });
      if (next) known(next === "creating" ? undefined : { sandboxId: next === "cold" ? null : next.ready, creatingSince: null });
      return value;
    },
  };
}

class SandboxSessionImpl implements SandboxSession {
  executionSettled(): boolean {
    return !this.uncertainTurn && (!this.sandboxId || !this.deps.sandboxClient.hasUncertainExecution(this.sandboxId));
  }
  readonly fileSystem: ToolFileSystem;
  private readonly target: WorkspaceMountTarget;
  private skills: SkillSet;
  /** The Sandbox this Turn's operations use; the binding row decides it. */
  private sandboxId?: string;
  /** Only an in-flight ensure is shared; failed provisioning can be retried. */
  private ensuring?: Promise<string>;
  /** The Turn-start connect prepare() runs beside the Turn; operations wait for it. */
  private connecting?: Promise<void>;
  private prepared = false;
  private generation = 0;
  private uncertainTurn = false;
  private recovering?: Promise<void>;
  /** The Turn the session was last prepared for. */
  private turn: PrepareOptions = {};
  /**
   * The install prepare() left running. Operations wait for it; once it
   * failed or was cancelled, they rethrow its error until the next prepare.
   */
  private installing?: Promise<void>;
  private readonly binding: SandboxEnvironmentBinding;
  /** What an environment failure is recorded against (see recordFailure). */
  private known?: KnownRow;

  constructor(
    private readonly deps: SandboxManagerDeps,
    private readonly skillInstaller: SkillInstaller,
    private readonly spec: EnvSpec,
    binding: SandboxEnvironmentBinding,
  ) {
    this.binding = knownBinding(binding, (row) => { this.known = row; });
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
        this.recovering = this.recover().finally(() => { this.recovering = undefined; });
      }
      await this.recovering;
      recovered = this.prepared;
    } catch { /* Unknown control-plane outcomes cannot justify replacement. */ }
    throw new Error(`Sandbox operation outcome is unconfirmed and may have side effects. The original operation was not replayed. ${recovered ? 'The environment is available for subsequent tools.' : 'Environment recovery is unconfirmed; a subsequent tool may retry preparation.'} Inspect files or external effects before deciding whether to request the operation again.`);
  }
  private async recover(): Promise<void> {
    const id = await this.binding.withLock<string | null>(async ({ sandboxId: id }) => {
      await this.assertExecutable();
      this.sandboxId = id ?? undefined;
      // Creating or Cold: the next tool's ensure follows the binding.
      if (!id) return { value: null };
      if (await this.deps.sandboxClient.state(id) === 'missing') {
        this.sandboxId = undefined;
        return { next: "cold", value: null };
      }
      // Never replace Running or unknown resources. Refresh a Running handle
      // only after an exception; ordinary tools do not perform this I/O.
      await this.attach(id);
      return { value: id };
    });
    // A known missing environment stays cold until the next tool requests it.
    if (id) await this.finishPreparation(id);
  }

  async prepare(skills: SkillSet = this.skills, options: PrepareOptions = {}): Promise<void> {
    if (this.ensuring) await this.ensuring;
    if (this.recovering) await this.recovering;
    this.skills = skills;
    this.turn = options;
    this.installing = undefined;
    this.prepared = false;
    this.uncertainTurn = false;
    // Set before prepare first yields: an operation the Turn starts meanwhile waits for it.
    const connecting = this.connect();
    this.connecting = connecting;
    try { await connecting; }
    finally { if (this.connecting === connecting) this.connecting = undefined; }
  }
  /**
   * Connect to the Sandbox the binding records and verify its mount, under
   * binding coordination, then decide its install. A Creating, Unresolved or
   * Cold binding is left as it is: the first operation's ensure waits,
   * reconciles or creates (ADR-0023).
   */
  private async connect(): Promise<void> {
    const id = await this.preparation((begin) => this.binding.withLock<string | null>(async ({ sandboxId: id }) => {
      await this.assertExecutable();
      this.sandboxId = id ?? undefined;
      if (!id) return { value: null };
      begin();
      if (!await this.deps.sandboxClient.reconnect(id, this.metadata())) {
        this.sandboxId = undefined;
        return { next: "cold", value: null };
      }
      this.deps.sandboxClient.resetExecutionUncertainty(id);
      await this.attach(id, false);
      return { value: id, observed: "ready" };
    }).catch((error: unknown) => {
      // The row moved on meanwhile: the first operation follows it.
      if (error instanceof EnvironmentBindingChanged) return null;
      throw error;
    }));
    if (!id) return;
    let install: { settled: Promise<void> } | undefined;
    try {
      install = await this.beginInstall(id);
    } catch (error) {
      // Deciding the install failed: it fails each operation as a failed install does (ADR-0022).
      this.installing = Promise.reject(error);
      this.installing.catch(() => {});
      throw error;
    }
    if (!install) { this.markPrepared(id); return; }
    // The install runs on beside the Turn (ADR-0022).
    this.installing = install.settled.then(() => this.markPrepared(id));
    // Each operation rethrows a failure; until one asks, it is not unhandled.
    this.installing.catch(() => {});
  }
  /**
   * One preparation of the Turn's environment (ADR-0023): the Turn-start
   * connect, or an operation's ensure. `work` calls `begin` once there is a
   * Sandbox to prepare, and the Turn's observer hears of the preparation's
   * start and end. This is the one place an environment failure is
   * observed: every failure but a cancellation is one, and it reaches each
   * operation that waited for the preparation as a SandboxUnavailable,
   * a tool error the model can retry, and the binding as its last error. The
   * next operation prepares again; one that connects or creates the Sandbox
   * clears the error.
   */
  private async preparation<T extends string | null>(work: (begin: () => void) => Promise<T>): Promise<T> {
    const { signal, sandboxPrepares: observer } = this.turn;
    let begun = false;
    const begin = () => { if (!begun) { begun = true; observer?.started(); } };
    let id: T;
    try {
      id = await work(begin);
    } catch (error) {
      // The Turn stopped waiting, or its Session was terminated: no environment failure.
      if (error instanceof SandboxSessionClosed || signal?.aborted) {
        if (begun) observer?.ended({ outcome: "aborted", reason: error });
        throw error;
      }
      const failure = environmentFailure(error);
      this.recordFailure(failure);
      begin();
      observer?.ended({ outcome: "failed", error: failure });
      throw failure;
    }
    if (begun) observer?.ended(id === null ? { outcome: "deferred" } : { outcome: "ready", sandboxId: id });
    return id;
  }
  /**
   * Record an environment failure as the binding's last error, which the
   * Session API reports (ADR-0023), by its compare-and-set and only while
   * the row is as this session last read or left it: a move another Turn or
   * Runner made since (a new Sandbox or intent, Cold) began a state the
   * failure says nothing about. A connect another Turn completed on the
   * unmoved row meanwhile leaves no trace to compare with, so the record can
   * follow it; the next preparation that ends ready clears it. Not awaited:
   * one store serializes a binding's callers, so this session's next
   * preparation follows the record, and a lost write loses only the record.
   */
  private recordFailure(failure: SandboxUnavailable): void {
    const known = this.known;
    if (!known) return;
    this.binding.withLock<void>(async ({ sandboxId, creatingSince }) =>
      sandboxId === known.sandboxId && creatingSince?.getTime() === known.creatingSince?.getTime()
        ? { value: undefined, observed: { failure: { code: failure.code, reason: failure.reason } } }
        : { value: undefined })
      .catch(() => { /* Unreachable, reclaimed or moved on meanwhile: nothing is recorded. */ });
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
    let pending: Awaited<ReturnType<SkillInstaller["begin"]>>;
    try {
      pending = await this.skillInstaller.begin(this.binding.id, this.skillLedger(),
        { sandboxId: id, tenantId: this.spec.tenantId }, skills, {
          signal, onStart: () => { started = true; skillInstalls?.started(skills); },
        });
    } catch (error) {
      // Deciding the install failed (stage check): the Turn hears of it as of
      // an install that failed, and a Turn that used no tool ends with it.
      if (error instanceof SkillInstallError) { skillInstalls?.started(skills); skillInstalls?.ended({ error }); }
      throw error;
    }
    if (!pending) return undefined;
    return { settled: pending.settled.then(
      (report) => { if (started && report) skillInstalls?.ended({ report }); },
      (error: unknown) => { if (started) skillInstalls?.ended({ error }); throw error; },
    ) };
  }
  private markPrepared(id: string): void {
    this.sandboxId = id;
    this.prepared = true;
    this.generation++;
  }
  private skillLedger(): SkillInstallLedger | undefined {
    const binding = this.binding;
    if (!binding.installedSkills || !binding.recordSkillsInstalled) return undefined;
    return { installed: () => binding.installedSkills!(), record: installed => binding.recordSkillsInstalled!(installed) };
  }
  async checkWorkspace(): Promise<void> {
    // No probe at Turn end: this cannot prove that arbitrary open handles saved.
    if (this.uncertainTurn) throw new WorkspaceMountUnavailable();
  }
  private async assertExecutable(): Promise<void> {
    if (this.binding.canExecute && !await this.binding.canExecute()) throw new SandboxSessionClosed();
  }
  private async verify(id: string): Promise<void> {
    try {
      await this.deps.sandboxClient.verifyWorkspaceMount(id, this.target);
    } catch {
      throw new WorkspaceMountUnavailable();
    }
  }
  private async ensure(): Promise<string> {
    // A recovery that failed leaves the Sandbox unprepared: ensure prepares it.
    if (this.recovering) await this.recovering.catch(() => {});
    // The Turn-start connect: its failure fails the operations that waited for it.
    if (this.connecting) await this.connecting;
    // No business operation runs before the Turn's install succeeded.
    if (this.installing) await this.installing;
    if (this.prepared && this.sandboxId) return this.sandboxId;
    // Parallel tool calls of the Turn share one in-flight ensure, and so one wait.
    if (!this.ensuring) {
      // Heard from before its first read of the row: a change committed after
      // a read ends the wait that read decided.
      const changes = new BindingChanges(this.deps.environmentSignals, this.binding.id);
      this.ensuring = this.preparation(async (begin) => { begin(); return this.provision(changes); })
        .then(async (id) => { await this.finishPreparation(id); return id; })
        .finally(() => { changes.close(); this.ensuring = undefined; });
    }
    return this.ensuring;
  }
  /**
   * Bring the binding to Ready and verify its Sandbox's mount (ADR-0023,
   * "ensure"); ensure then installs Skills. Each step reads the row and acts
   * on it alone: Ready → connect, a confirmed missing Sandbox → Cold;
   * Creating → wait; Unresolved → reconcile; Cold → create. A wait ends on
   * the binding's `environment` hint, or after 2 s, when the row is read
   * again; it lasts until the intent deadline at most, so no outcome, known
   * or not, blocks the binding longer.
   *
   * A create the gateway rejected leaves the binding Cold and fails the call.
   * One with an unknown outcome keeps its intent: the call waits for its
   * deadline, reconciles, and creates once more if the gateway holds none;
   * that create's unknown outcome is waited for and reconciled too, then the
   * call fails. The call so leaves the binding Ready or Cold unless the
   * Turn's signal ends a wait. Alone on its binding, it has its Sandbox, or
   * fails, within two intent deadlines (a create is bounded by
   * CREATE_REQUEST_MS, inside its intent's deadline), two gateway lists and
   * the binding's reads and writes: about six minutes (ADR-0023,
   * Consequences). Preparing a Sandbox it got (mount, Skills) adds its own.
   */
  private async provision(changes: BindingChanges): Promise<string> {
    // One create per call, and one more after an unknown outcome was reconciled.
    let creates = 1;
    let retries = 1;
    for (;;) {
      let id: string | undefined;
      try {
        const step = await this.nextStep(creates > 0);
        if (step.kind === "ready") id = step.sandboxId;
        else if (step.kind === "wait") await changes.wait(step.ms, this.turn.signal);
        else if (step.kind === "reconcile") await this.reconcile(step.creatingSince);
        else if (step.kind === "create") {
          creates--;
          id = await this.create(step.notBefore);
        }
      } catch (error) {
        // Its intent stays: the next steps wait for the deadline and reconcile it.
        if (error instanceof CreateOutcomeUnknown) {
          if (retries > 0) { retries--; creates++; }
          continue;
        }
        // Another Runner moved the row on meanwhile: read it again and follow it.
        if (!(error instanceof EnvironmentBindingChanged)) throw error;
      }
      if (id) return id;
    }
  }
  /** Decide ensure's next step from the binding row, under its lock. */
  private async nextStep(mayCreate: boolean): Promise<EnsureStep> {
    try {
      return await this.binding.withLock<EnsureStep>(async (binding) => {
        await this.assertExecutable();
        const id = binding.sandboxId;
        if (id !== null) {
          if (await this.deps.sandboxClient.reconnect(id, this.metadata())) {
            await this.attach(id, false);
            return { value: { kind: "ready", sandboxId: id }, observed: "ready" };
          }
          this.sandboxId = undefined;
          return { next: "cold", value: { kind: "retry" } };
        }
        if (binding.creatingSince !== null) {
          const remainingMs = intentExpiresAt(binding.creatingSince) - binding.now.getTime();
          // Another Turn's create, or this call's own whose outcome is
          // unknown, may still produce the Sandbox.
          if (remainingMs > 0) throw new CreationInProgress(remainingMs);
          return { value: { kind: "reconcile", creatingSince: binding.creatingSince } };
        }
        if (!mayCreate) throw new SandboxUnavailable("unknown");
        // Commit the intent before create: a lost response, a lost Runner or a
        // lost binding write leaves an intent any Runner reconciles after its deadline.
        return { next: "creating", value: { kind: "create", notBefore: binding.now } };
      });
    } catch (error) {
      if (!(error instanceof CreationInProgress)) throw error;
      return { kind: "wait", ms: Math.min(BINDING_REREAD_MS, error.remainingMs) };
    }
  }
  /**
   * Create the Sandbox for the intent just committed and record it: CAS
   * Creating → Ready (ADR-0023, "create"). Resolves its id, or undefined when
   * the binding moved on meanwhile: the Sandbox is killed and ensure follows
   * the row.
   */
  private async create(notBefore: Date): Promise<string | undefined> {
    let handle: SandboxHandle;
    try {
      handle = await this.deps.sandboxClient.create({
        image: this.spec.image, env: this.spec.env,
        timeoutSeconds: SANDBOX_RUNNING_SECONDS, metadata: this.metadata(),
      });
    } catch (error) {
      throw await this.createFailed(error, notBefore);
    }
    if (!await this.record(handle.id, notBefore)) {
      // Ready with another Sandbox, Cold, or Creating anew: nothing will use this one.
      await this.deps.sandboxClient.destroy(handle.id).catch(() => { /* the sweeper kills an unrecorded Sandbox */ });
      return undefined;
    }
    this.sandboxId = handle.id;
    await this.assertExecutable();
    // A known Sandbox whose mount fails verification stays recorded: the
    // next tool retries its preparation, not its creation.
    await this.verify(handle.id);
    return handle.id;
  }
  /**
   * CAS Creating → Ready(id) while the binding holds the intent committed
   * after the read at `notBefore`. Recorded even for a Session terminated
   * meanwhile: reclamation finds a Sandbox the binding names. A claimed
   * reclamation refuses the write, and kills the Sandbox by binding. False
   * when the row moved on. A write whose outcome is unknown (the database
   * unreachable) rejects and leaves the intent, which reconciliation resolves
   * by adopting the Sandbox after the deadline.
   */
  private async record(id: string, notBefore: Date): Promise<boolean> {
    return this.decide<boolean>(async (binding) => {
      // A Runner that reconciled the intent past its deadline adopted it already.
      if (binding.sandboxId === id) return { value: true };
      if (!holdsIntent(binding, notBefore)) return { value: false };
      return { next: { ready: id }, value: true };
    });
  }
  /** Under the binding lock; a row that moved on between the read and the write is decided again as it is now. */
  private async decide<T>(work: (binding: EnvironmentBinding) => Promise<EnvironmentLockResult<T>>): Promise<T> {
    for (;;) {
      try {
        return await this.binding.withLock<T>(work);
      } catch (error) {
        if (!(error instanceof EnvironmentBindingChanged)) throw error;
      }
    }
  }
  /**
   * Classify a create that returned no Sandbox (ADR-0023, "create"). A
   * definite rejection claimed nothing: CAS Creating → Cold while the binding
   * holds the intent committed after the read at `notBefore`, and the tool
   * fails without reconciling or retrying. Any other failure is an unknown
   * outcome, whose intent stays for ensure to reconcile. Tools never see the
   * SDK's error: it can carry provider diagnostics.
   */
  private async createFailed(error: unknown, notBefore: Date): Promise<Error> {
    if (!(error instanceof SandboxCreateRejected) || !DEFINITE_REJECTIONS.has(error.status)) return new CreateOutcomeUnknown();
    await this.decide<void>(async (binding) => (holdsIntent(binding, notBefore) ? { next: "cold", value: undefined } : { value: undefined }))
      .catch(() => { /* Unwritten, the intent is reconciled past its deadline. */ });
    return new SandboxUnavailable("rejected", error.status);
  }
  /**
   * Reconcile the Unresolved binding (see {@link reconcileBinding}), then
   * kill the Sandboxes it does not keep. Ensure then connects, verifies the
   * mount and installs Skills as for any Ready binding.
   */
  private async reconcile(creatingSince: Date): Promise<void> {
    const outcome = await reconcileBinding(this.deps.sandboxClient, this.binding, creatingSince);
    // A failed kill leaves a superseded Sandbox, which the sweeper kills.
    if (outcome) await killSandboxes(this.deps.sandboxClient, outcome.duplicates.map(({ sandboxId }) => sandboxId));
  }
  private metadata(): Record<string, string> {
    return {
      [SANDBOX_BINDING_LABEL]: this.binding.id,
      [SANDBOX_ENVIRONMENT_LABEL]: this.deps.environment,
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
