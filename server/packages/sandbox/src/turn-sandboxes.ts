import type { Agent, DelegationStore, PendingEventFence, SandboxActivity, Session, SessionStore } from "@oma-server/store";
import { sandboxBindingId, workspaceObjectPrefix } from "@oma-server/store";
import type { ToolExecutor } from "@open-managed-agents/adapter-core";
import type { CommandVariables, EnvSpec, SandboxBinding, SandboxManager, SandboxPrepareObserver, SkillInstallObserver } from "./sandbox-manager.js";
import { PLATFORM_DEFAULT_ENV } from "./environment-variables.js";
import type { SkillSet } from "./skill-install.js";
import { turnExecutor, type TurnExecutorGuard } from "./turn-executor.js";
import { WORKSPACE_ENV } from "./workspace-environment.js";
import type { WorkspaceMountSpec } from "./workspace-mount.js";

/**
 * Sandbox is mandatory (issue #54): an Agent is sandboxed unless it *explicitly*
 * opts out with `sandbox.enabled === false`. A missing `sandbox` field therefore
 * means sandboxed — a legacy Agent with no sandbox config runs in a sandbox and
 * fails loud if none can be provisioned, which is the intended mandatory
 * behavior. Only an explicit `enabled: false` is treated as opted-out.
 */
export function isSandboxedAgent(agent: Pick<Agent, "sandbox">): boolean {
  return agent.sandbox?.enabled !== false;
}

/** What a Turn attempt hands the acquisition of its Sandbox lease. */
export interface SandboxLeaseRequest extends TurnExecutorGuard {
  /** The Turn's Session, as read under its claim. */
  session: Session;
  /** The Agent configuration the Turn runs with: whether it is sandboxed, and its env. */
  agent: Agent;
  /** The attempt's claim: the Turn's use of the binding is recorded under it. */
  fence: PendingEventFence;
  /**
   * The Turn's signal. It cancels a wait for admission, and an install still
   * running for the Turn: that install is not retried and the binding
   * records nothing (ADR-0022).
   */
  signal: AbortSignal;
  /** The Agent's equipped Skill Set, computed per attempt: a Resumed Turn installs the current one. */
  skills: SkillSet;
  /** Told of every Skill Install the Sandbox runs for the Turn, a cold Sandbox's included. */
  skillInstalls?: SkillInstallObserver;
  /** Told of every preparation of the Turn's Sandbox: the Turn-start connect and each operation's ensure. */
  sandboxPrepares?: SandboxPrepareObserver;
}

/**
 * The evidence a Turn's lease is released with: how its runtime ended. A
 * completed history marker, an expired lease or a bounded Interrupt wait is
 * not proof that the runtime ended.
 */
export type TurnSettlement =
  /** The runtime settled, or never started: nothing the Turn runs is left running. */
  | { settled: true }
  /**
   * The runtime may still run; `settles` resolves once it has. It is absent
   * for a Turn detached at the handoff deadline, which is not watched: its
   * Runner is exiting, and the next owner's admitted generation supersedes
   * the abandoned activity (ADR-0019).
   */
  | { settled: false; settles?: Promise<unknown> };

/**
 * One Turn attempt's use of its Session's Sandbox, from admission to release.
 * Its Sandbox session lives for the Turn: the binding row is the only state
 * a later Turn finds.
 */
export interface SandboxLease {
  /**
   * The Turn's executor (ADR-0005 §1), fenced by ownership of the Turn: a
   * fresh capability per Turn, so stale owners cannot start new Sandbox work.
   * Every operation waits for the Turn's preparation and Skill Install. A
   * Sandbox unavailability fails the operations that met it with a
   * SandboxUnavailable, a tool error the model can retry; it never ends the
   * Turn (ADR-0023).
   */
  readonly executor: ToolExecutor;
  /**
   * Resolves once the Turn-start preparation has ended, whatever its
   * outcome: the connect to the binding's Sandbox, its mount check and the
   * decision of its Skill Install. A Turn that ends before it waits for it,
   * so an install it starts is the Turn's (ADR-0022).
   */
  prepared(): Promise<void>;
  /** Availability check only: never scans files or claims all open handles were saved. */
  checkWorkspace(): Promise<void>;
  /**
   * End the Turn's use of the Sandbox, after its input was acknowledged: the
   * activity's idle decision sees whether input is still queued. Only
   * observed settlement ends it; without it, and while a Sandbox command
   * ended without exit evidence, the use stays (ADR-0019).
   */
  release(evidence: TurnSettlement): Promise<void>;
}

/**
 * The Turn side of the Sandbox protocol (ADR-0023): the Router acquires a
 * lease at Turn start and releases it at Turn end; termination reclaims
 * through the same module. Resource-use records, activity admission and
 * settlement, binding coordination and preparation stay behind it.
 */
export interface TurnSandboxes {
  /** The Turn's lease; null for an Agent that is not sandboxed. Rejects only when the Turn may not use the Sandbox at all. */
  acquire(request: SandboxLeaseRequest): Promise<SandboxLease | null>;
  /**
   * Reclaim a terminated Session's Sandbox: its binding is reclaimed, with
   * every Sandbox the gateway lists for it, once no other Session uses it.
   * True once the binding records no Sandbox and no creation intent; the
   * caller keeps its cleanup request until then.
   */
  reclaim(session: Session): Promise<boolean>;
  /** Record again the settlement evidence a failed write left unrecorded, of one Session or of all. */
  retrySettlements(sessionId?: string): Promise<void>;
}

/**
 * The Environments Sessions run in, as the Host resolves them for their
 * Sandboxes (ADR-0024). Each call reads the Environment as it is now,
 * deleted or not.
 */
export interface SandboxEnvironments {
  /** The image it serves; null when it serves none or the Tenant cannot see it. */
  image(tenantId: string, environmentId: string): Promise<string | null>;
  /**
   * Its variables as a command receives them: plain values, Tenant secrets
   * opened, platform secret references resolved. Empty when the Tenant
   * cannot see it.
   */
  variables(tenantId: string, environmentId: string): Promise<Record<string, string>>;
}

export interface TurnSandboxesDeps {
  /** The single owner of sandbox lifecycle (ADR-0005 §1, design doc §2/§6). */
  manager: SandboxManager;
  /** Durable Sandbox Bindings, the resource uses that protect them, and their Skill Install records. */
  bindings: Pick<DelegationStore, "withBindingLock" | "installedSkillSet" | "recordSkillSetInstall"
    | "acquireResourceUse" | "releaseResourceUse" | "hasResourceUsers">;
  /** A terminated Session's Turn prepares no Sandbox. */
  sessions: Pick<SessionStore, "getById">;
  /** Deployment-owned mount identity; the prefix derives from Session ownership. */
  workspaceMount: Omit<WorkspaceMountSpec, "prefix">;
  /**
   * The Environments Sessions run in (ADR-0024): a Session claims its
   * Sandboxes with the image its Environment serves, and runs every command
   * with its variables. Without them no Sandbox can be created.
   */
  environments?: SandboxEnvironments;
  /** Observe failures to record settlement off a Turn's path (a watched runtime's, a retry's) without unhandled rejections. */
  onError?: (failure: { sessionId: string; error: unknown }) => void;
}

export class DefaultTurnSandboxes implements TurnSandboxes {
  /**
   * Observed settlement whose recording failed. This holds exit evidence
   * only: if PG is temporarily down, scans retry recording it; owner loss
   * still leaves unknown activity safe.
   */
  private readonly unrecorded = new Map<string, SandboxActivity>();

  constructor(private readonly deps: TurnSandboxesDeps) {}

  async acquire(request: SandboxLeaseRequest): Promise<SandboxLease | null> {
    const { session, agent, fence, signal } = request;
    if (!isSandboxedAgent(agent)) return null;
    const { manager, bindings } = this.deps;
    const environmentId = environmentOf(session, agent);
    const image = environmentId ? await this.imageFor(session.tenantId, environmentId) : undefined;
    // `open` is cheap: it starts no Sandbox, the first filesystem or code
    // primitive does, so a pure-chat Turn spins nothing up.
    const spec = this.specFor(session, request.skills, environmentId, image);
    const sandbox = environmentId
      ? manager.open(spec, this.bindingFor(session), this.variablesFor(session.tenantId, environmentId))
      : manager.open(spec, this.bindingFor(session));
    const activity: SandboxActivity = { bindingId: sandboxBindingId(session), sessionId: session.id, fence };
    // The use protects the binding from reclamation while this claim owns
    // the Turn; an admitted activity keeps it until observed settlement.
    await bindings.acquireResourceUse(session.id, activity.bindingId, fence);
    let admitted: boolean;
    try {
      admitted = await manager.beginActivity?.(activity, signal) ?? false;
    } catch (error) {
      // Not admitted, the Turn runs nothing in the Sandbox: its use goes now.
      await bindings.releaseResourceUse(session.id, fence);
      throw error;
    }
    // Preparation connects to a Ready binding's Sandbox, verifies its mount
    // and decides the install beside the model's first request; the install
    // runs on beside inference. The first Sandbox operation waits for both
    // (ADR-0022, ADR-0023). Their failures reach the operations that wait for
    // them and the Turn's observers, never the Turn itself.
    const prepared = sandbox.prepare(request.skills, { signal, skillInstalls: request.skillInstalls, sandboxPrepares: request.sandboxPrepares })
      .catch(() => {});
    const settledInSandbox = () => sandbox.executionSettled?.() !== false;
    return {
      executor: turnExecutor(sandbox, { assertOwner: request.assertOwner, skillInstallFailed: request.skillInstallFailed,
        sandboxUnavailable: request.sandboxUnavailable }),
      prepared: () => prepared,
      checkWorkspace: () => sandbox.checkWorkspace(),
      release: async (evidence) => {
        if (!evidence.settled) {
          // Observe the runtime's natural end without blocking the Session.
          if (admitted && evidence.settles) void Promise.all([evidence.settles, prepared]).then(async () => {
            if (settledInSandbox()) await this.finish(activity);
          }).catch((error) => this.deps.onError?.({ sessionId: session.id, error }));
          return;
        }
        // Connecting renews the Sandbox's deadline: the Turn's use ends after it.
        await prepared;
        // A command that ended without exit evidence keeps the Turn's use:
        // unknown execution never requests idle.
        if (!settledInSandbox()) return;
        if (admitted) await this.finish(activity);
        else await bindings.releaseResourceUse(session.id, fence);
      },
    };
  }

  async reclaim(session: Session): Promise<boolean> {
    // By binding: shared users are rechecked under its coordination, and a
    // confirmed missing resource can also clear an obsolete pointer despite
    // old unknown use.
    return this.deps.manager.reclaim(this.bindingFor(session));
  }

  async retrySettlements(sessionId?: string): Promise<void> {
    for (const activity of this.unrecorded.values()) {
      if (sessionId && activity.sessionId !== sessionId) continue;
      try { await this.finish(activity); }
      catch (error) { this.deps.onError?.({ sessionId: activity.sessionId, error }); }
    }
  }

  /** Record observed settlement: the activity ends, and with it the Turn's use. */
  private async finish(activity: SandboxActivity): Promise<void> {
    const key = JSON.stringify([activity.bindingId, activity.sessionId, activity.fence]);
    this.unrecorded.set(key, activity);
    await this.deps.manager.finishActivity?.(activity);
    await this.deps.bindings.releaseResourceUse(activity.sessionId, activity.fence);
    this.unrecorded.delete(key);
  }

  /**
   * The Session's durable Sandbox Binding, as its Sandbox session
   * coordinates through it. A Child Session shares its root's, and so its
   * Skill Install record.
   */
  private bindingFor(session: Session): SandboxBinding {
    const bindingId = sandboxBindingId(session);
    const { bindings, sessions } = this.deps;
    return {
      id: bindingId,
      withLock: (work) => bindings.withBindingLock(bindingId, work),
      canReclaim: async () => !await bindings.hasResourceUsers(bindingId),
      canExecute: async () => (await sessions.getById(session.id))?.status !== "terminated",
      installedSkills: () => bindings.installedSkillSet(bindingId),
      recordSkillsInstalled: (installed) => bindings.recordSkillSetInstall(bindingId, installed),
    };
  }

  /**
   * The image the Turn's Sandbox is created with, should it create one
   * (ADR-0024): the one the Environment serves now, deleted or not, so
   * Sandboxes created after a rebuild run the new image while running ones
   * keep theirs until reclaimed. None for an Environment that cannot be read
   * or never served one: its create is rejected, never run on another image.
   */
  private async imageFor(tenantId: string, environmentId: string): Promise<string | undefined> {
    return await this.deps.environments?.image(tenantId, environmentId) ?? undefined;
  }

  /**
   * What each command runs with (ADR-0024), lowest first: the platform
   * defaults, the Environment's variables read for that command, so a
   * change applies from the next one, then the Workspace variables. One
   * primary-key read per command: an edit is made on an API pod and must
   * reach every Runner's next command, which no process-local cache can
   * promise without a read.
   */
  private variablesFor(tenantId: string, environmentId: string): CommandVariables {
    const { environments } = this.deps;
    return async () => ({ ...PLATFORM_DEFAULT_ENV, ...await environments?.variables(tenantId, environmentId), ...WORKSPACE_ENV });
  }

  /**
   * Compute the complete recipe the SandboxManager needs for this Session
   * (design doc §1/§6). A **value**, no I/O: the tenant/workspace binding, the
   * Environment and its image, and the Skill Set to install at
   * `/skills/<skill-name>` outside the persistent Workspace. The Sandbox is
   * created with the Workspace variables only: paths, no secret, so its
   * creation (and its Sandbox CR) carries none of the Environment's
   * variables, and Host-internal commands see the same paths as every
   * command. Commands receive the rest (see variablesFor).
   */
  private specFor(session: Session, skills: SkillSet, environmentId: string | undefined, image: string | undefined): EnvSpec {
    return {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId,
      workspaceMount: { ...this.deps.workspaceMount, prefix: workspaceObjectPrefix(session.tenantId, session.workspaceId) },
      ...(environmentId ? { environmentId } : {}),
      image,
      env: { ...WORKSPACE_ENV },
      skills,
    };
  }
}

/**
 * The Environment a Turn's Sandbox is created from (ADR-0024): the one its
 * Session froze at creation; for a Session created while its Agent ran
 * without a Sandbox, which froze none, the Agent's now.
 */
function environmentOf(session: Session, agent: Agent): string | undefined {
  return session.environmentId ?? agent.environmentId;
}
