import { afterAll, describe, expect, it, vi } from "vitest";
import { SANDBOX_WORKSPACE_ROOT } from "@open-managed-agents/adapter-core";
import type { Agent, DelegationStore, SandboxBindingRow, BindingLockResult, PendingEventFence, Session, SessionStore } from "@oma-server/store";
import { DefaultSandboxManager, SandboxSessionClosed, SandboxUnavailable } from "../src/sandbox-manager.js";
import { FakeSandboxClient } from "../src/fake-sandbox-client.js";
import { CREATE_REQUEST_MS, INTENT_DEADLINE_SECONDS, SANDBOX_RUNNING_SECONDS, SandboxCreateRejected, type SandboxClient, type SandboxCreateOptions } from "../src/sandbox-client.js";
import { SANDBOX_BINDING_LABEL, SANDBOX_ENVIRONMENT_LABEL } from "../src/sandbox-sweep.js";
import { EMPTY_SKILL_SET, skillSetOf, type SkillSet } from "../src/skill-install.js";
import { DefaultTurnSandboxes, type SandboxLease, type TurnSandboxesDeps } from "../src/turn-sandboxes.js";
import { workspaceMountMetadata } from "../src/workspace-mount.js";
import { BINDING_REREAD_MS, type SandboxSignals } from "../src/sandbox-signals.js";
import { databaseClock, signalBus } from "./bindings.js";
import { Bundles, TENANT, text } from "./skill-bundles.js";
import type { TurnSandboxStores } from "./turn-sandboxes-contract.js";

/** The stores every Runner shares, and control over the clock binding intents are judged by. */
export interface ReconciliationStores extends TurnSandboxStores {
  /** Let `seconds` pass for the creation intents' deadlines, as the database clock judges them. */
  elapse(seconds: number): Promise<void>;
  /** Leave the binding Creating since the epoch, as migration 0024 turns a pending row. */
  legacyPending(bindingId: string): Promise<void>;
}

/**
 * Where a Runner is lost while it creates its binding's Sandbox: the edges of
 * ADR-0023's state diagram. Lost as kill -9 loses it: from then on none of
 * its calls settle and its claim lapses.
 */
export type LossPoint =
  /** The intent committed; create never sent. */
  | "after-intent"
  /** Create sent; the gateway completes the claim, but its answer reaches nobody. */
  | "during-create"
  /** Create sent; the gateway cancels the claim with the dropped connection. */
  | "during-create-cancelled"
  /** Create answered; the binding write never sent. */
  | "after-create"
  /** The binding write sent; it never commits. */
  | "during-write"
  /** The binding write committed; its answer reaches nobody. */
  | "during-write-committed"
  /** The Sandbox recorded; the Skill Install runs. */
  | "during-skill-install";

/** What a lost Runner's calls return: nothing, ever. */
const GONE = new Promise<never>(() => {});
const workspaceMount = { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" };
const agent: Agent = { id: "agent_sbx", tenantId: TENANT, name: "Sandboxed", model: "model", system: "", runtime: "pi-agent",
  sandbox: { enabled: true }, createdAt: new Date(), updatedAt: new Date() };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A create that ran into its client timeout, as the SDK's request signal fails it. */
const timedOut = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
/** A promise and whether it settled yet. */
function watch<T>(promise: Promise<T>) {
  const watched = { promise, settled: false };
  promise.then(() => { watched.settled = true; }, () => { watched.settled = true; });
  return watched;
}

/**
 * One Runner: its own Sandbox Manager and Turn side of the Sandbox protocol
 * over the shared stores, the shared gateway and the shared `sandbox`
 * hints. Lost at `loss`, every call it makes stops settling.
 */
class Runner {
  dead = false;
  readonly sandboxes: DefaultTurnSandboxes;
  constructor(stores: ReconciliationStores, gateway: FakeSandboxClient, bundles: Bundles, hints: SandboxSignals, readonly loss?: LossPoint,
    deps: Pick<TurnSandboxesDeps, "environments"> = {}) {
    const manager = new DefaultSandboxManager({ sandboxClient: this.client(gateway), skillBundleStore: bundles, environment: "test", sandboxSignals: hints,
      lifecycle: stores.lifecycle && this.alive(stores.lifecycle) });
    this.sandboxes = new DefaultTurnSandboxes({ manager, bindings: this.bindings(stores.delegationStore),
      sessions: this.alive(stores.sessionStore) as Pick<SessionStore, "getById">, workspaceMount, ...deps });
    if (loss === "during-skill-install") {
      // The install goes on in the Sandbox; the Runner never hears how it ended.
      gateway.skillInstallFault = (stage) => { if (stage === "download") this.dead = true; };
    }
  }
  /** Settles as `promise` does while the Runner lives. */
  private live<T>(promise: Promise<T>): Promise<T> {
    return promise.then((value) => this.dead ? GONE : value, (error: unknown) => this.dead ? GONE : Promise.reject(error));
  }
  private alive<T extends object>(target: T): T {
    return new Proxy(target, { get: (object, key) => {
      const value = Reflect.get(object, key);
      return typeof value === "function" ? (...args: unknown[]) => this.dead ? GONE : this.live(Promise.resolve(value.apply(object, args))) : value;
    } });
  }
  private bindings(store: DelegationStore): DelegationStore {
    const alive = this.alive(store);
    const withBindingLock = <T>(bindingId: string, work: (binding: SandboxBindingRow) => Promise<BindingLockResult<T>>): Promise<T> => {
      if (this.dead) return GONE;
      let committed: BindingLockResult<T>["next"];
      return this.live(store.withBindingLock(bindingId, async (binding) => {
        const result = await work(binding);
        if (this.loss === "during-write" && typeof result.next === "object") {
          // The write was sent and never committed: nothing moves.
          this.dead = true;
          throw new Error("Runner lost");
        }
        committed = result.next;
        return result;
      }).then((value) => {
        if ((this.loss === "after-intent" && committed === "creating")
          || (this.loss === "during-write-committed" && typeof committed === "object")) this.dead = true;
        return value;
      }));
    };
    return new Proxy(alive, { get: (object, key) => key === "withBindingLock" ? withBindingLock : Reflect.get(object, key) });
  }
  private client(gateway: FakeSandboxClient): SandboxClient {
    const alive = this.alive(gateway);
    const create = async (opts?: SandboxCreateOptions) => {
      if (this.dead) return GONE;
      if (this.loss === "during-create" || this.loss === "during-create-cancelled") {
        this.dead = true;
        if (this.loss === "during-create") void gateway.create(opts);
        return GONE;
      }
      const handle = await gateway.create(opts);
      if (this.loss === "after-create") this.dead = true;
      return this.live(Promise.resolve(handle));
    };
    return new Proxy(alive, { get: (object, key) => {
      if (key === "create") return create;
      // Synchronous bookkeeping of the client itself, and command streams.
      if (key === "hasUncertainExecution" || key === "resetExecutionUncertainty") return Reflect.get(gateway, key).bind(gateway);
      if (key === "exec") return (...args: Parameters<FakeSandboxClient["exec"]>) => this.dead ? (async function* () { await GONE; })() : gateway.exec(...args);
      return Reflect.get(object, key);
    } });
  }
}

/**
 * Crash injection into Sandbox creation (ADR-0023, #284): a Runner is lost at
 * each step of creating its binding's Sandbox, and the next Turn, on another
 * Runner, adopts or recreates the Sandbox once the intent's deadline has
 * passed and uses its tools. Creates the gateway fails (#285): a definite
 * rejection returns the binding to Cold at once; an unknown outcome is
 * reconciled within the same tool call, which creates once more at most.
 * Each Runner has its own Sandbox Manager; the stores and the gateway outlive
 * them. Time passes only as a test lets it.
 */
export function bindingReconciliationContract(name: string, createStores: () => Promise<ReconciliationStores>,
  options: {
    teardown?: () => Promise<void>;
    /**
     * `elapse` moves the database clock itself. PostgreSQL's now() is real
     * time: there `elapse` moves the recorded intents back instead, which a
     * creator still waiting for its create cannot tell from time passing.
     */
    clockMoves?: boolean;
  } = {}): void {
  describe(name, () => {
    if (options.teardown) afterAll(options.teardown);

    async function setup(deps: Pick<TurnSandboxesDeps, "environments"> = {}) {
      const stores = await createStores();
      const gatewayClock = databaseClock(new Date("2026-10-22T13:19:30Z"));
      const gateway = new FakeSandboxClient({ clock: gatewayClock.now });
      const bundles = new Bundles();
      const list = vi.spyOn(gateway, "listSandboxes");
      const hints = signalBus();
      const runner = (loss?: LossPoint) => new Runner(stores, gateway, bundles, hints, loss, deps);
      const session = (parent?: Session, environmentId?: string) => stores.sessionStore.create({
        tenantId: TENANT, agentId: agent.id, agent, workspaceId: "ws_1", ...(environmentId ? { environmentId } : {}),
        ...(parent ? { delegation: { parentSessionId: parent.id, parentTurnId: "turn_1_a1", parentToolUseId: "call_agent", sandboxSessionId: parent.id } } : {}),
      });
      /** Queue an input and claim it: a Turn attempt's fence. */
      const claim = async (target: Session): Promise<PendingEventFence> => {
        if (!await stores.pendingEventStore.count(target.id)) {
          await stores.pendingEventStore.enqueue(target.id, { type: "user.message", data: { content: [] }, sessionThreadId: "sthr_primary" });
        }
        const claimed = (await stores.pendingEventStore.claim(target.id, "runner", 60_000))!;
        return { eventId: claimed.event.id, ownerId: claimed.ownerId, generation: claimed.generation };
      };
      /** Terminate a Session as the API and its Router do: revoked, its queue discarded. */
      const terminate = async (target: Session) => {
        await stores.sessionStore.terminate(target.id);
        await stores.pendingEventStore.clear(target.id);
      };
      /** A lost Runner's claim lapses: the next Runner takes the input over. */
      const lapse = (target: Session, fence: PendingEventFence) => stores.pendingEventStore.releaseClaim(target.id, fence.eventId, fence);
      /** A Turn on `on`: its lease, taken under a fresh claim. */
      const turn = async (on: Runner, target: Session, skills: SkillSet = EMPTY_SKILL_SET,
        signal = new AbortController().signal): Promise<{ lease: SandboxLease; fence: PendingEventFence }> => {
        const fence = await claim(target);
        const lease = (await on.sandboxes.acquire({ session: target, agent, fence, signal, skills, skillInstallFailed: () => {} }))!;
        return { lease, fence };
      };
      /** Lose `loss`'s Runner in its Turn's first tool call; resolves once it is lost and its claim lapsed. */
      const lose = async (loss: LossPoint, target: Session, skills?: SkillSet) => {
        const lost = runner(loss);
        const { lease, fence } = await turn(lost, target, skills);
        void lease.executor!.writeFile("/tmp/lost-runner", "never confirmed");
        await vi.waitFor(() => expect(lost.dead).toBe(true));
        await lapse(target, fence);
      };
      /** The binding row as it is now. */
      const row = (bindingId: string) => stores.delegationStore.withBindingLock(bindingId, async ({ sandboxId, creatingSince }) => ({ value: { sandboxId, creatingSince } }));
      const elapse = async (seconds: number) => { gatewayClock.elapse(seconds); await stores.elapse(seconds); };
      /** The Sandboxes the gateway lists for a binding. */
      const listed = async (bindingId: string) => (await gateway.listSandboxes({ metadata: { [SANDBOX_BINDING_LABEL]: bindingId }, states: ["running", "paused"] }))
        .map((sandbox) => sandbox.sandboxId).sort();
      /** A Sandbox claimed for the binding as a lost create leaves it, with the labels and mount ensure creates it with. */
      const claimed = async (bindingId: string) => (await gateway.create({ timeoutSeconds: SANDBOX_RUNNING_SECONDS, metadata: {
        [SANDBOX_BINDING_LABEL]: bindingId, [SANDBOX_ENVIRONMENT_LABEL]: "test", "oma.dev/tenant": TENANT, "oma.dev/workspace": "ws_1",
        ...workspaceMountMetadata({ ...workspaceMount, prefix: `${TENANT}/ws_1/` }, SANDBOX_WORKSPACE_ROOT),
      } })).id;
      /** Write through a lease, then read back: the file is in the Sandbox the binding records. */
      const toolsWork = async (lease: SandboxLease, bindingId: string, marker = "/tmp/marker") => {
        await lease.executor!.writeFile(marker, `written for ${bindingId}`);
        expect(await lease.executor!.readFile(marker)).toBe(`written for ${bindingId}`);
        await lease.executor!.writeFile("saved.txt", "in the Workspace");
        const { sandboxId } = await row(bindingId);
        expect(gateway.filesOf(sandboxId!).get(marker)?.content).toBe(`written for ${bindingId}`);
        return sandboxId!;
      };
      return { stores, gateway, gatewayClock, bundles, list, runner, session, claim, terminate, lapse, turn, lose, row, elapse, listed, claimed, toolsWork };
    }
    type Harness = Awaited<ReturnType<typeof setup>>;

    /**
     * The next Turn finds the binding Creating: it starts without waiting,
     * its first tool waits for the intent's deadline, then the binding is
     * reconciled and the tool runs.
     */
    async function takeOver(h: Harness, target: Session) {
      h.list.mockClear();
      const { lease } = await h.turn(h.runner(), target);
      const tool = watch(h.toolsWork(lease, target.id));
      await sleep(250);
      expect(tool.settled).toBe(false);
      expect(h.list).not.toHaveBeenCalled();
      await h.elapse(INTENT_DEADLINE_SECONDS);
      return { lease, sandboxId: await tool.promise };
    }

    it("recreates the Sandbox after the deadline when the Runner was lost after committing the intent", async () => {
      const h = await setup();
      const session = await h.session();
      await h.lose("after-intent", session);
      const intent = await h.row(session.id);
      expect(intent).toEqual({ sandboxId: null, creatingSince: expect.any(Date) });
      // The Session API reports the intent its lost Runner left (#290).
      expect(await h.stores.delegationStore.sandbox(session.id)).toEqual({ state: "creating", since: intent.creatingSince, lastError: null });
      expect(h.gateway.created).toEqual([]);
      const { sandboxId } = await takeOver(h, session);
      expect(h.list).toHaveBeenCalledTimes(1);
      expect(h.gateway.created).toEqual([sandboxId]);
      expect(await h.row(session.id)).toEqual({ sandboxId, creatingSince: null });
      expect(await h.stores.delegationStore.sandbox(session.id)).toMatchObject({ state: "ready", lastError: null });
    });

    it("adopts the Sandbox the gateway claimed after the Runner was lost during create", async () => {
      const h = await setup();
      const session = await h.session();
      await h.lose("during-create", session);
      const [claimedId] = h.gateway.created;
      expect(await h.listed(session.id)).toEqual([claimedId]);
      const { sandboxId } = await takeOver(h, session);
      expect(sandboxId).toBe(claimedId);
      expect(h.gateway.created).toEqual([claimedId]);
      expect(h.gateway.destroyed).toEqual([]);
    });

    it("records for an adopted Sandbox the binding's Environment and the image its create asked for (ADR-0024)", async () => {
      const image = "registry.example/welltop/oma-environments@sha256:" + "e".repeat(64);
      const h = await setup({ environments: { image: async () => image, variables: async () => ({}) } });
      const session = await h.session(undefined, "env_tools");
      await h.lose("after-create", session);
      const [createdId] = h.gateway.created;
      const { sandboxId } = await takeOver(h, session);
      expect(sandboxId).toBe(createdId);
      expect(await h.stores.delegationStore.withBindingLock(session.id, async ({ environmentId, image: recorded }) => ({ value: { environmentId, image: recorded } })))
        .toEqual({ environmentId: "env_tools", image });
    });

    it("records no image for an adopted Sandbox whose listing does not show one", async () => {
      const h = await setup();
      const session = await h.session();
      const orphan = await h.claimed(session.id);
      await h.stores.legacyPending(session.id);
      const { lease } = await h.turn(h.runner(), session);
      expect(await h.toolsWork(lease, session.id)).toBe(orphan);
      expect(await h.stores.delegationStore.withBindingLock(session.id, async ({ environmentId, image }) => ({ value: { environmentId, image } })))
        .toEqual({ environmentId: null, image: null });
    });

    it("recreates the Sandbox when the claim died with the Runner during create", async () => {
      const h = await setup();
      const session = await h.session();
      await h.lose("during-create-cancelled", session);
      expect(h.gateway.created).toEqual([]);
      const { sandboxId } = await takeOver(h, session);
      expect(h.gateway.created).toEqual([sandboxId]);
    });

    it("adopts the created Sandbox when the Runner was lost after create returned, before the binding write", async () => {
      const h = await setup();
      const session = await h.session();
      await h.lose("after-create", session);
      const [createdId] = h.gateway.created;
      expect(await h.row(session.id)).toMatchObject({ sandboxId: null });
      const { sandboxId } = await takeOver(h, session);
      expect(sandboxId).toBe(createdId);
      expect(h.gateway.created).toHaveLength(1);
    });

    it("adopts the created Sandbox when the Runner was lost during the binding write", async () => {
      const h = await setup();
      const session = await h.session();
      await h.lose("during-write", session);
      const [createdId] = h.gateway.created;
      expect(await h.row(session.id)).toMatchObject({ sandboxId: null, creatingSince: expect.any(Date) });
      const { sandboxId } = await takeOver(h, session);
      expect(sandboxId).toBe(createdId);
      expect(h.gateway.created).toHaveLength(1);
    });

    it("connects without reconciling when the binding write committed and only its answer was lost", async () => {
      const h = await setup();
      const session = await h.session();
      await h.lose("during-write-committed", session);
      const [createdId] = h.gateway.created;
      expect(await h.row(session.id)).toEqual({ sandboxId: createdId, creatingSince: null });
      const { lease } = await h.turn(h.runner(), session);
      expect(await h.toolsWork(lease, session.id)).toBe(createdId);
      expect(h.list).not.toHaveBeenCalled();
    });

    it("installs the Skills again in the recorded Sandbox when the Runner was lost during the Skill Install", async () => {
      const h = await setup();
      const session = await h.session();
      const skills = skillSetOf([await h.bundles.add("writer", [text("SKILL.md", "v1")])]);
      await h.lose("during-skill-install", session, skills);
      h.gateway.skillInstallFault = undefined;
      const [createdId] = h.gateway.created;
      expect(await h.row(session.id)).toEqual({ sandboxId: createdId, creatingSince: null });
      const { lease } = await h.turn(h.runner(), session, skills);
      expect(await lease.executor!.readFile("/skills/writer/SKILL.md")).toBe("v1");
      expect(h.gateway.created).toEqual([createdId]);
      expect(h.list).not.toHaveBeenCalled();
    });

    it("replays 2026-10-22: the gateway created the Sandbox, the Runner was redeployed before the write, and the resumed Turn adopts that Sandbox", async () => {
      const h = await setup();
      const session = await h.session();
      // 21:19:30 (+08) the intent commits; the claim is Ready at 21:20:10.
      h.gateway.createFault = async (step) => { if (step === "claim") await h.elapse(40); };
      await h.lose("after-create", session);
      h.gateway.createFault = undefined;
      const [claimedId] = h.gateway.created;
      // The console redeploy at 21:22:35; the resumed Turn's first tool at 21:22:40, past the deadline (21:22:30).
      await h.elapse(145 + 5);
      const { lease } = await h.turn(h.runner(), session);
      expect(await h.toolsWork(lease, session.id)).toBe(claimedId);
      expect(h.gateway.created).toEqual([claimedId]);
      expect(h.list).toHaveBeenCalledTimes(1);
      const [adopted] = await h.gateway.listSandboxes({ metadata: { [SANDBOX_BINDING_LABEL]: session.id }, states: ["running"] });
      expect(adopted).toMatchObject({ sandboxId: claimedId, startedAt: new Date("2026-10-22T13:20:10Z"), metadata: { [SANDBOX_ENVIRONMENT_LABEL]: "test" } });
    });

    /** A Child Session's Turn shares its root's binding while the root's Runner still creates. */
    async function stalledCreator(h: Harness, step: "claim" | "respond") {
      const parent = await h.session();
      const child = await h.session(parent);
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let stalled = false;
      h.gateway.createFault = async (at) => { if (at === step && !stalled) { stalled = true; await released; } };
      const creator = await h.turn(h.runner(), parent);
      const late = watch(h.toolsWork(creator.lease, parent.id, "/tmp/late-creator"));
      await vi.waitFor(() => expect(stalled).toBe(true));
      return { parent, child, late, release };
    }

    it("kills the Sandbox of a late creator whose binding write finds the binding moved on, and runs its tool in the recorded one", async () => {
      const h = await setup();
      const { parent, child, late, release } = await stalledCreator(h, "claim");
      await h.elapse(INTENT_DEADLINE_SECONDS);
      // Past the deadline, the child reconciles (nothing claimed yet) and creates.
      const { lease } = await h.turn(h.runner(), child);
      const replacement = await h.toolsWork(lease, parent.id);
      expect(await h.row(parent.id)).toEqual({ sandboxId: replacement, creatingSince: null });
      release();
      expect(await late.promise).toBe(replacement);
      const lateId = h.gateway.created.find((id) => id !== replacement)!;
      expect(h.gateway.destroyed).toEqual([lateId]);
      expect(await h.listed(parent.id)).toEqual([replacement]);
      expect(await h.row(parent.id)).toEqual({ sandboxId: replacement, creatingSince: null });
    });

    it("keeps the Sandbox of a late creator that reconciliation adopted meanwhile", async () => {
      const h = await setup();
      const { parent, child, late, release } = await stalledCreator(h, "respond");
      const [claimedId] = h.gateway.created;
      await h.elapse(INTENT_DEADLINE_SECONDS);
      const { lease } = await h.turn(h.runner(), child);
      expect(await h.toolsWork(lease, parent.id)).toBe(claimedId);
      release();
      expect(await late.promise).toBe(claimedId);
      expect(h.gateway.created).toEqual([claimedId]);
      expect(h.gateway.destroyed).toEqual([]);
    });

    it("keeps a running Sandbox, else the earliest claimed, when reconciliation finds several, and kills the others", async () => {
      const h = await setup();
      const session = await h.session();
      const pausedEarliest = await h.claimed(session.id);
      h.gatewayClock.elapse(10);
      const runningEarlier = await h.claimed(session.id);
      h.gatewayClock.elapse(10);
      const runningLater = await h.claimed(session.id);
      h.gateway.pause(pausedEarliest);
      await h.stores.legacyPending(session.id);
      const { lease } = await h.turn(h.runner(), session);
      expect(await h.toolsWork(lease, session.id)).toBe(runningEarlier);
      expect(h.gateway.destroyed.sort()).toEqual([pausedEarliest, runningLater].sort());
      expect(await h.listed(session.id)).toEqual([runningEarlier]);

      // All paused: the earliest claimed is kept and resumed.
      const other = await h.session();
      const earliest = await h.claimed(other.id);
      h.gatewayClock.elapse(10);
      const later = await h.claimed(other.id);
      h.gateway.pause(earliest);
      h.gateway.pause(later);
      await h.stores.legacyPending(other.id);
      const next = await h.turn(h.runner(), other);
      expect(await h.toolsWork(next.lease, other.id)).toBe(earliest);
      expect(await h.listed(other.id)).toEqual([earliest]);
    });

    it("reconciles a binding left pending before the migration on its first use, without waiting", async () => {
      const h = await setup();
      const adopted = await h.session();
      const orphan = await h.claimed(adopted.id);
      await h.stores.legacyPending(adopted.id);
      const { lease } = await h.turn(h.runner(), adopted);
      expect(await h.toolsWork(lease, adopted.id)).toBe(orphan);

      const cold = await h.session();
      await h.stores.legacyPending(cold.id);
      const next = await h.turn(h.runner(), cold);
      const created = await h.toolsWork(next.lease, cold.id);
      expect(h.gateway.created).toEqual([orphan, created]);
    });

    it.each([400, 403, 409])("returns the binding to Cold at once when the gateway rejects the create with HTTP %i: no reconcile, no retry", async (status) => {
      const h = await setup();
      const session = await h.session();
      let creates = 0;
      h.gateway.createFault = (step) => { if (step === "claim") { creates++; throw new SandboxCreateRejected(status); } };
      const { lease } = await h.turn(h.runner(), session);
      const failure = await lease.executor!.writeFile("a.txt", "x").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SandboxUnavailable);
      expect(failure).toMatchObject({ code: "sandbox_unavailable", reason: "rejected", status,
        message: "The gateway rejected the Sandbox creation. A later tool call can retry." });
      expect(creates).toBe(1);
      expect(h.list).not.toHaveBeenCalled();
      expect(await h.row(session.id)).toEqual({ sandboxId: null, creatingSince: null });
      // The Session API reports the failure until the Sandbox is created (#290).
      await vi.waitFor(async () => expect(await h.stores.delegationStore.sandbox(session.id))
        .toMatchObject({ state: "unavailable", lastError: { code: "sandbox_unavailable", reason: "rejected" } }));
      // Cold: the next tool creates at once, with no deadline to wait for.
      h.gateway.createFault = undefined;
      const sandboxId = await h.toolsWork(lease, session.id);
      expect(h.gateway.created).toEqual([sandboxId]);
      expect(h.list).not.toHaveBeenCalled();
      expect(await h.stores.delegationStore.sandbox(session.id)).toMatchObject({ state: "ready", lastError: null });
    });

    it("waits for the deadline after a create whose answer was lost, then adopts the Sandbox the gateway did create, in the same tool call", async () => {
      const h = await setup();
      const session = await h.session();
      let lost = false;
      h.gateway.createFault = (step) => { if (step === "respond" && !lost) { lost = true; throw timedOut(); } };
      const { lease } = await h.turn(h.runner(), session);
      const tool = watch(h.toolsWork(lease, session.id));
      await vi.waitFor(() => expect(lost).toBe(true));
      const [claimedId] = h.gateway.created;
      await sleep(250);
      expect(tool.settled).toBe(false);
      expect(h.list).not.toHaveBeenCalled();
      expect(await h.row(session.id)).toMatchObject({ sandboxId: null, creatingSince: expect.any(Date) });
      await h.elapse(INTENT_DEADLINE_SECONDS);
      expect(await tool.promise).toBe(claimedId);
      expect(h.list).toHaveBeenCalledTimes(1);
      expect(h.gateway.created).toEqual([claimedId]);
    });

    it.each([
      ["a gateway 500 (the claim timeout among them)", () => new SandboxCreateRejected(500)],
      ["a connection lost before any answer", () => new TypeError("fetch failed")],
    ])("waits for the deadline after %s, reconciles, and creates once more in the same tool call when the gateway holds none", async (_, failure) => {
      const h = await setup();
      const session = await h.session();
      let creates = 0;
      h.gateway.createFault = (step) => { if (step === "claim" && ++creates === 1) throw failure(); };
      const { lease } = await h.turn(h.runner(), session);
      const tool = watch(h.toolsWork(lease, session.id));
      await vi.waitFor(() => expect(creates).toBe(1));
      await sleep(250);
      expect(tool.settled).toBe(false);
      expect(h.list).not.toHaveBeenCalled();
      await h.elapse(INTENT_DEADLINE_SECONDS);
      const sandboxId = await tool.promise;
      expect(creates).toBe(2);
      expect(h.list).toHaveBeenCalledTimes(1);
      expect(h.gateway.created).toEqual([sandboxId]);
      expect(await h.row(session.id)).toEqual({ sandboxId, creatingSince: null });
    });

    it("ends a tool call whose creates both time out with a tool error and a Cold binding, two intent deadlines after its first intent", async () => {
      const h = await setup();
      const session = await h.session();
      const budget = CREATE_REQUEST_MS / 1000;
      let creates = 0;
      // Each create runs into its client timeout: the clock passes the request's budget, then the request aborts.
      h.gateway.createFault = async (step) => { if (step === "claim") { await h.elapse(budget); creates++; throw timedOut(); } };
      const { lease } = await h.turn(h.runner(), session);
      const tool = watch(lease.executor!.writeFile("a.txt", "x").catch((error: unknown) => error));
      await vi.waitFor(() => expect(creates).toBe(1));
      await sleep(250);
      expect(tool.settled).toBe(false);
      expect(h.list).not.toHaveBeenCalled();
      // The first intent's deadline: reconciled, none found, created once more,
      // at the call's next read of the binding.
      await h.elapse(INTENT_DEADLINE_SECONDS - budget);
      await vi.waitFor(() => expect(creates).toBe(2), { timeout: BINDING_REREAD_MS + 1000 });
      expect(h.list).toHaveBeenCalledTimes(1);
      await sleep(250);
      expect(tool.settled).toBe(false);
      // The second intent's deadline: reconciled, none found, the tool fails. Nothing is waited for after it.
      await h.elapse(INTENT_DEADLINE_SECONDS - budget);
      const failure = await tool.promise;
      expect(failure).toBeInstanceOf(SandboxUnavailable);
      expect(failure).toMatchObject({ code: "sandbox_unavailable", reason: "unknown",
        message: "Sandbox creation did not complete. A later tool call can retry." });
      expect(String(failure)).not.toMatch(/abort|timeout/i);
      expect(creates).toBe(2);
      expect(h.list).toHaveBeenCalledTimes(2);
      expect(h.gateway.created).toEqual([]);
      expect(await h.row(session.id)).toEqual({ sandboxId: null, creatingSince: null });
      await vi.waitFor(async () => expect(await h.stores.delegationStore.sandbox(session.id))
        .toMatchObject({ state: "unavailable", lastError: { code: "sandbox_unavailable", reason: "unknown" } }));
    }, 15_000);

    it("fails the tool at once, the binding Cold, when the create after reconciling is rejected", async () => {
      const h = await setup();
      const session = await h.session();
      let creates = 0;
      h.gateway.createFault = (step) => {
        if (step === "claim") throw ++creates === 1 ? new SandboxCreateRejected(503) : new SandboxCreateRejected(403);
      };
      const { lease } = await h.turn(h.runner(), session);
      const tool = watch(lease.executor!.writeFile("a.txt", "x").catch((error: unknown) => error));
      await vi.waitFor(() => expect(creates).toBe(1));
      await h.elapse(INTENT_DEADLINE_SECONDS);
      expect(await tool.promise).toMatchObject({ code: "sandbox_unavailable", reason: "rejected", status: 403 });
      expect(creates).toBe(2);
      expect(h.list).toHaveBeenCalledTimes(1);
      expect(await h.row(session.id)).toEqual({ sandboxId: null, creatingSince: null });
    });

    it("ends the wait after an unknown outcome with the Turn's signal, and keeps the intent for reconciliation", async () => {
      const h = await setup();
      const session = await h.session();
      h.gateway.createFault = (step) => { if (step === "claim") throw new SandboxCreateRejected(500); };
      const interrupt = new AbortController();
      const { lease } = await h.turn(h.runner(), session, EMPTY_SKILL_SET, interrupt.signal);
      const tool = watch(lease.executor!.writeFile("a.txt", "x").catch((error: unknown) => error));
      await sleep(250);
      expect(tool.settled).toBe(false);
      interrupt.abort(new Error("interrupted"));
      expect(await tool.promise).toMatchObject({ name: "AbortError" });
      expect(h.list).not.toHaveBeenCalled();
      expect(await h.row(session.id)).toMatchObject({ sandboxId: null, creatingSince: expect.any(Date) });
    });

    it.runIf(options.clockMoves)("kills the Sandbox of a late creator that returns while another intent is being created, and follows that one", async () => {
      const h = await setup();
      const { parent, child, late, release } = await stalledCreator(h, "claim");
      const first = (await h.row(parent.id)).creatingSince!;
      await h.elapse(INTENT_DEADLINE_SECONDS);
      // The child commits a fresh intent; its create stalls too.
      let releaseChild!: () => void;
      const childReleased = new Promise<void>((resolve) => { releaseChild = resolve; });
      h.gateway.createFault = async (at) => { if (at === "claim") await childReleased; };
      const { lease } = await h.turn(h.runner(), child);
      const childTool = watch(h.toolsWork(lease, parent.id));
      await vi.waitFor(async () => expect((await h.row(parent.id)).creatingSince!.getTime()).toBeGreaterThan(first.getTime()));
      h.gateway.createFault = undefined;
      // The late creator's create answers first, while the child's intent is fresh.
      release();
      await vi.waitFor(() => expect(h.gateway.destroyed).toHaveLength(1));
      const [lateId] = h.gateway.destroyed;
      expect(late.settled).toBe(false);
      releaseChild();
      const recorded = await childTool.promise;
      expect(recorded).not.toBe(lateId);
      expect(await late.promise).toBe(recorded);
      expect(await h.listed(parent.id)).toEqual([recorded]);
    });

    /** Termination reclaims by binding (ADR-0023, "Release and reclamation", #288). */
    describe("termination", () => {
      /** A tool call of `target`'s Turn on a fresh Runner whose create stalls in the gateway until released. */
      async function stalledCreate(h: Harness, target: Session) {
        let release!: () => void;
        const released = new Promise<void>((resolve) => { release = resolve; });
        let stalled = false;
        h.gateway.createFault = async (at) => { if (at === "claim" && !stalled) { stalled = true; await released; } };
        const { lease } = await h.turn(h.runner(), target);
        const tool = watch(lease.executor!.writeFile("a.txt", "never written"));
        await vi.waitFor(() => expect(stalled).toBe(true));
        return { tool, release };
      }

      it("kills the Sandbox a lost create left when its Session is terminated, though the binding never recorded it", async () => {
        const h = await setup();
        const session = await h.session();
        await h.lose("after-create", session);
        const [orphan] = h.gateway.created;
        await h.elapse(INTENT_DEADLINE_SECONDS);
        await h.terminate(session);
        expect(await h.runner().sandboxes.reclaim(session)).toBe(true);
        expect(h.gateway.destroyed).toEqual([orphan]);
        expect(await h.listed(session.id)).toEqual([]);
        expect(await h.row(session.id)).toEqual({ sandboxId: null, creatingSince: null });
      });

      it("replays the orphans of 2026-10-22: a terminated Session whose binding stayed Creating loses every Sandbox claimed for it, and no other binding's", async () => {
        const h = await setup();
        const session = await h.session();
        const other = await h.session();
        const first = await h.claimed(session.id);
        const second = await h.claimed(session.id);
        const othersOrphan = await h.claimed(other.id);
        await h.stores.legacyPending(session.id);
        await h.stores.legacyPending(other.id);
        await h.terminate(session);
        expect(await h.runner().sandboxes.reclaim(session)).toBe(true);
        expect(h.gateway.destroyed).toEqual([first, second]);
        expect(await h.listed(other.id)).toEqual([othersOrphan]);
        expect(await h.row(other.id)).toMatchObject({ sandboxId: null, creatingSince: new Date(0) });
      });

      it("retains the binding while a create may still be in flight on another Runner, and kills that create's Sandbox once retried past the deadline", async () => {
        const h = await setup();
        const session = await h.session();
        const { tool, release } = await stalledCreate(h, session);
        await h.terminate(session);
        const cleaner = h.runner();
        // Nothing listed yet: the intent is fresh, so the binding is retained.
        expect(await cleaner.sandboxes.reclaim(session)).toBe(false);
        expect(h.gateway.destroyed).toEqual([]);
        release();
        // The creator's tool fails: with the native lifecycle the claimed
        // reclamation refuses its binding write, a Sandbox unavailability the
        // tool reports (#287); without it the creator records its Sandbox,
        // and finds its Session terminated.
        const failure = await tool.promise.catch((error: unknown) => error);
        if (h.stores.lifecycle) expect(failure).toMatchObject({ name: "SandboxUnavailable", reason: "unreachable",
          cause: new Error("Sandbox reclamation in progress; retry input") });
        else expect(failure).toBeInstanceOf(SandboxSessionClosed);
        const [created] = h.gateway.created;
        expect(await h.listed(session.id)).toEqual([created]);
        await h.elapse(INTENT_DEADLINE_SECONDS);
        expect(await cleaner.sandboxes.reclaim(session)).toBe(true);
        expect(h.gateway.destroyed).toEqual([created]);
        expect(await h.listed(session.id)).toEqual([]);
        expect(await h.row(session.id)).toEqual({ sandboxId: null, creatingSince: null });
      });

      it("never lets a creator answering after reclamation record its Sandbox: it kills the Sandbox itself", async () => {
        const h = await setup();
        const session = await h.session();
        const { tool, release } = await stalledCreate(h, session);
        await h.terminate(session);
        const cleaner = h.runner();
        expect(await cleaner.sandboxes.reclaim(session)).toBe(false);
        await h.elapse(INTENT_DEADLINE_SECONDS);
        expect(await cleaner.sandboxes.reclaim(session)).toBe(true);
        expect(h.gateway.destroyed).toEqual([]);
        release();
        await expect(tool.promise).rejects.toThrow();
        const [late] = h.gateway.created;
        expect(h.gateway.destroyed).toEqual([late]);
        expect(await h.listed(session.id)).toEqual([]);
        expect(await h.row(session.id)).toEqual({ sandboxId: null, creatingSince: null });
      });

      it("retries a reclamation whose kill failed, and keeps the binding meanwhile", async () => {
        const h = await setup();
        const session = await h.session();
        const { lease } = await h.turn(h.runner(), session);
        const recorded = await h.toolsWork(lease, session.id);
        const extra = await h.claimed(session.id);
        await h.terminate(session);
        const cleaner = h.runner();
        vi.spyOn(h.gateway, "destroy").mockRejectedValueOnce(new Error("temporary gateway failure"));
        await expect(cleaner.sandboxes.reclaim(session)).rejects.toThrow("temporary gateway failure");
        expect(await h.listed(session.id)).toEqual([recorded]);
        expect(h.gateway.destroyed).toEqual([extra]);
        expect(await cleaner.sandboxes.reclaim(session)).toBe(true);
        expect(h.gateway.destroyed).toEqual([extra, recorded]);
        expect(await h.row(session.id)).toEqual({ sandboxId: null, creatingSince: null });
      });
    });
  });
}
