import { afterAll, describe, expect, it, vi } from "vitest";
import type { DelegationStore, BindingTransition, SandboxActivity, SandboxLifecycleStore, SandboxSweepStore } from "@oma-server/store";
import { FakeSandboxClient } from "../src/fake-sandbox-client.js";
import { INTENT_DEADLINE_SECONDS, SANDBOX_IDLE_SECONDS, SANDBOX_RUNNING_SECONDS, type SandboxClient } from "../src/sandbox-client.js";
import { DefaultSandboxManager } from "../src/sandbox-manager.js";
import { SANDBOX_BINDING_LABEL, SANDBOX_ENVIRONMENT_LABEL, SWEEP_MAX_UNSETTLED } from "../src/sandbox-sweep.js";
import { SandboxSweeper, type SweepRound } from "../src/sandbox-sweeper.js";
import { signalBus } from "./bindings.js";

/** One Runner's stores: its own binding operations over the rows every Runner shares. */
export interface SweeperRunnerStores {
  bindings: Pick<DelegationStore, "withBindingLock">;
  facts: SandboxSweepStore;
  /** Turn admission and reclamation, as the Runner's Sandbox Manager uses them. */
  lifecycle: SandboxLifecycleStore;
}

/** The stores every Runner shares, and the facts a test arranges in them. */
export interface SweeperStores {
  /** Another Runner over the same rows: its binding operations queue only behind its own. */
  runner(): SweeperRunnerStores;
  /** A root Session; its id is its binding's. */
  session(): Promise<string>;
  /** Queue an input for the Session: its binding is in use. */
  queue(sessionId: string): Promise<void>;
  /** Queue an input for the Session and claim it as a Runner starting its Turn does: the activity the Turn's admission begins. */
  admit(sessionId: string): Promise<SandboxActivity>;
  /** Terminate the Session and discard its queue. */
  terminate(sessionId: string): Promise<void>;
  /** Terminate the binding's Session and claim its reclamation, which does not complete. */
  reclaiming(bindingId: string): Promise<void>;
  /** Let `seconds` pass for creation intents, as the database clock judges them. */
  elapse(seconds: number): Promise<void>;
  /** The row as stored, read without creating it; null when the binding has none. */
  row(bindingId: string): Promise<{ sandboxId: string | null; creatingSince: Date | null } | null>;
}

const ENVIRONMENT = "test";
/** A gateway whose every call first lets other work run: two Runners' rounds interleave at each step. */
function yielding(gateway: FakeSandboxClient): SandboxClient {
  return new Proxy(gateway, { get: (object, key) => {
    const value = Reflect.get(object, key);
    if (typeof value !== "function" || !["listSandboxes", "destroy", "setTimeout", "state"].includes(String(key))) return value;
    return async (...args: unknown[]) => {
      await new Promise((resolve) => setImmediate(resolve));
      return value.apply(object, args);
    };
  } });
}

/**
 * The sweeper (ADR-0023, "The sweeper", #291) over shared stores and one
 * gateway: what one round kills, adopts, shortens and leaves; two Runners'
 * rounds at once; each action decided again just before it is taken, and a
 * Turn starting meanwhile against the kill of its binding's Sandbox (by
 * reclamation) and the shorten (set back); reclamations left claimed; bindings
 * Creating past their deadline with nothing listed; the caps; failures; the
 * `sandbox_sweep` line.
 */
export function sandboxSweeperContract(name: string, createStores: () => Promise<SweeperStores>, options: {
  teardown?: () => Promise<void>;
  /**
   * Whether concurrent compare-and-sets of one row serialize, as PostgreSQL's
   * row locks make them. pg-mem takes none: two Runners' moves can both apply.
   */
  rowLocks?: boolean;
  /**
   * Whether the stores admit Turns and reclaim bindings. pg-mem parses
   * neither statement; real PostgreSQL runs every test.
   */
  reclamation?: boolean;
} = {}): void {
  describe(name, () => {
    if (options.teardown) afterAll(options.teardown);

    async function setup() {
      const stores = await createStores();
      const gateway = new FakeSandboxClient();
      const hints = signalBus();
      const lines: SweepRound[] = [];
      const sandbox = async (binding: string | null, shape: { environment?: string | null; deadline?: boolean; paused?: boolean } = {}) => {
        const { environment = ENVIRONMENT, deadline = true, paused = false } = shape;
        const { id } = await gateway.create({
          metadata: {
            ...(binding === null ? {} : { [SANDBOX_BINDING_LABEL]: binding }),
            ...(environment === null ? {} : { [SANDBOX_ENVIRONMENT_LABEL]: environment }),
            "oma.dev/tenant": "tenant_1",
          },
          ...(deadline ? { timeoutSeconds: SANDBOX_RUNNING_SECONDS } : {}),
        });
        if (paused) gateway.pause(id);
        return id;
      };
      const move = (bindingId: string, next: BindingTransition) =>
        stores.runner().bindings.withBindingLock(bindingId, async () => ({ next, value: undefined }));
      /** A Runner's Sandbox Manager: it admits that Runner's Turns and reclaims bindings. */
      const manager = (runner: SweeperRunnerStores, client: SandboxClient = gateway) =>
        new DefaultSandboxManager({ sandboxClient: client, environment: ENVIRONMENT, lifecycle: runner.lifecycle, sandboxSignals: hints });
      /**
       * A sweeper on its own Runner. `afterScan` runs once its round has read
       * the listed bindings, before any action; `afterRecheck` once the first
       * action has read its binding again, before it takes the binding's lock
       * or claims its reclamation.
       */
      const sweeper = (runner = stores.runner(), hooks: { afterScan?: () => Promise<void>; afterRecheck?: () => Promise<void>; client?: SandboxClient } = {}) => {
        let reads = 0;
        const facts: SandboxSweepStore = {
          sweepFacts: async (ids) => {
            const read = await runner.facts.sweepFacts(ids);
            reads++;
            await (reads === 1 ? hooks.afterScan : reads === 2 ? hooks.afterRecheck : undefined)?.();
            return read;
          },
          unsettled: (deadline, limit) => runner.facts.unsettled(deadline, limit),
        };
        const client = hooks.client ?? gateway;
        return new SandboxSweeper({ client, facts, bindings: runner.bindings, manager: manager(runner, client), environment: ENVIRONMENT,
          sandboxSignals: hints, logger: { info: (line: string) => lines.push(JSON.parse(line)) } });
      };
      const alive = async (id: string) => await gateway.state(id) !== "missing";
      const deadlineOf = async (id: string) => (await gateway.listSandboxes({ metadata: {}, states: ["running", "paused"] }))
        .find(({ sandboxId }) => sandboxId === id)?.endAt?.getTime();
      return { stores, gateway, hints, lines, sandbox, move, manager, sweeper, alive, deadlineOf };
    }
    type Setup = Awaited<ReturnType<typeof setup>>;

    /** One of every row in the sweeper's table, and what the gateway holds for each. */
    async function fleet({ stores, sandbox, move }: Setup) {
      const cold = await stores.session();
      await move(cold, "cold");
      const orphanOfCold = await sandbox(cold);
      // Created before the label: this environment's, since its binding has a row here.
      const unlabelledOfCold = await sandbox(cold, { environment: null });
      const orphanWithoutRow = await sandbox("sesn_of_another_schema");

      const terminated = await stores.session();
      const ofTerminated = await sandbox(terminated);
      await move(terminated, { ready: ofTerminated });
      await stores.terminate(terminated);

      const superseding = await stores.session();
      const recorded = await sandbox(superseding);
      const superseded = await sandbox(superseding);
      await move(superseding, { ready: recorded });

      const inUse = await stores.session();
      const used = await sandbox(inUse);
      await move(inUse, { ready: used });
      await stores.queue(inUse);

      const undying = await stores.session();
      const withoutDeadline = await sandbox(undying, { deadline: false });
      await move(undying, { ready: withoutDeadline });

      const unresolved = await stores.session();
      await move(unresolved, "creating");
      const duplicate = await sandbox(unresolved, { paused: true });
      const adoptable = await sandbox(unresolved);
      await stores.elapse(INTENT_DEADLINE_SECONDS);

      // Committed after the time passed: within its deadline.
      const creating = await stores.session();
      await move(creating, "creating");
      const beingCreated = await sandbox(creating);

      const reclaimed = await stores.session();
      const ofReclaimed = await sandbox(reclaimed);
      await move(reclaimed, { ready: ofReclaimed });
      await stores.reclaiming(reclaimed);

      const pausedBinding = await stores.session();
      const paused = await sandbox(pausedBinding, { paused: true });
      await move(pausedBinding, { ready: paused });

      const otherEnvironment = await sandbox("sesn_of_production", { environment: "production" });
      const unlabelledElsewhere = await sandbox("sesn_of_production_before_labels", { environment: null });
      const unbound = await sandbox(null);
      return {
        bindings: { cold, terminated, superseding, inUse, undying, unresolved, creating, reclaimed, pausedBinding },
        // A reclamation left claimed is resumed: it kills its Sandbox by binding.
        killed: [orphanOfCold, unlabelledOfCold, orphanWithoutRow, ofTerminated, superseded, withoutDeadline, duplicate, ofReclaimed],
        shortened: [recorded, adoptable],
        untouched: [used, beingCreated, paused, otherEnvironment, unlabelledElsewhere, unbound],
        adoptable,
      };
    }

    async function expectSwept(h: Setup, f: Awaited<ReturnType<typeof fleet>>, startedAt: number) {
      const { stores, gateway, alive, deadlineOf } = h;
      expect(new Set(gateway.destroyed)).toEqual(new Set(f.killed));
      expect(gateway.destroyed).toHaveLength(f.killed.length);
      for (const id of [...f.shortened, ...f.untouched]) expect(await alive(id)).toBe(true);
      for (const id of f.shortened) {
        const deadline = (await deadlineOf(id))!;
        expect(deadline).toBeGreaterThanOrEqual(startedAt + SANDBOX_IDLE_SECONDS * 1000);
        expect(deadline).toBeLessThanOrEqual(Date.now() + SANDBOX_IDLE_SECONDS * 1000);
      }
      expect(new Set(gateway.deadlines.map(({ id }) => id))).toEqual(new Set(f.shortened));
      expect(gateway.deadlines.every(({ seconds }) => seconds === SANDBOX_IDLE_SECONDS)).toBe(true);
      const { bindings: b } = f;
      expect(await stores.row(b.cold)).toEqual({ sandboxId: null, creatingSince: null });
      // A Sandbox the row recorded is killed by reclaiming the binding, which leaves it Cold.
      expect(await stores.row(b.terminated)).toEqual({ sandboxId: null, creatingSince: null });
      expect(await stores.row(b.undying)).toEqual({ sandboxId: null, creatingSince: null });
      expect(await stores.row(b.reclaimed)).toEqual({ sandboxId: null, creatingSince: null });
      expect(await stores.row(b.unresolved)).toEqual({ sandboxId: f.adoptable, creatingSince: null });
      expect(await stores.row(b.creating)).toMatchObject({ sandboxId: null, creatingSince: expect.any(Date) });
      expect(await stores.row("sesn_of_another_schema")).toBeNull();
      // The adoption and the reclamations told the bindings' waiting Turns.
      expect(new Set(h.hints.published)).toEqual(new Set([b.terminated, b.undying, b.reclaimed, b.unresolved]));
    }

    const reclaiming = it.skipIf(options.reclamation === false);

    reclaiming("kills this environment's orphans, adopts an unresolved binding, shortens unused running Sandboxes, leaves the rest and logs one line", async () => {
      const h = await setup();
      const f = await fleet(h);
      const startedAt = Date.now();
      const round = await h.sweeper().sweep();
      await expectSwept(h, f, startedAt);
      expect(h.lines).toEqual([round]);
      expect(h.hints.published).toHaveLength(4);
      expect(round).toEqual({
        msg: "sandbox_sweep", env: ENVIRONMENT, listed: 16,
        orphans: 6, unresolved: 1, unusedRunning: 2, noDeadline: 1, expired: 0,
        killed: 7, adopted: 1, cleared: 0, shortened: 2, restored: 0, reclaimed: 1, deferred: 0, skipped: 0, failed: 0, ms: expect.any(Number),
      });
    });

    it.skipIf(options.rowLocks === false || options.reclamation === false)("lets two Runners sweep at once: each effect happens once and nothing else is killed", async () => {
      const h = await setup();
      const f = await fleet(h);
      const startedAt = Date.now();
      const rounds = await Promise.all([1, 2].map(() => h.sweeper(h.stores.runner(), { client: yielding(h.gateway) }).sweep()));
      await expectSwept(h, f, startedAt);
      // One compare-and-set adopted; the other Runner skipped it.
      expect(rounds.map(({ adopted }) => adopted).sort()).toEqual([0, 1]);
      expect(rounds.every(({ failed, error }) => failed === 0 && error === undefined)).toBe(true);
      expect(h.gateway.deadlines.filter(({ id }) => id === f.adoptable)).toHaveLength(1);
      // A second round of either finds nothing left to do.
      const again = await h.sweeper().sweep();
      expect(again).toMatchObject({ orphans: 0, unresolved: 0, unusedRunning: 0, noDeadline: 0, expired: 0,
        killed: 0, adopted: 0, cleared: 0, shortened: 0, restored: 0, reclaimed: 0 });
    });

    it("decides again before each action: a Sandbox used or adopted after the scan is neither killed nor shortened", async () => {
      const h = await setup();
      const { stores, sandbox, move, alive, deadlineOf } = h;
      const usedLater = await stores.session();
      const withoutDeadline = await sandbox(usedLater, { deadline: false });
      await move(usedLater, { ready: withoutDeadline });
      const adoptedLater = await stores.session();
      await move(adoptedLater, "cold");
      const ofCold = await sandbox(adoptedLater);
      const shortenedLater = await stores.session();
      const idle = await sandbox(shortenedLater);
      await move(shortenedLater, { ready: idle });
      const idleDeadline = await deadlineOf(idle);
      const raced = await stores.session();
      await move(raced, "creating");
      const preferred = await sandbox(raced);
      const other = await sandbox(raced, { paused: true });
      await stores.elapse(INTENT_DEADLINE_SECONDS);

      const round = await h.sweeper(stores.runner(), { afterScan: async () => {
        await stores.queue(usedLater);
        await stores.queue(shortenedLater);
        // Another Runner's reconciliation adopts the Cold binding's Sandbox
        // once a new intent passed its deadline, and the raced binding's other one.
        await move(adoptedLater, "creating");
        await move(adoptedLater, { ready: ofCold });
        await move(raced, { ready: other });
      } }).sweep();
      // Planned: kill the Sandbox without a deadline and the Cold binding's, shorten the idle one, adopt `preferred` and kill `other`.
      expect(round).toMatchObject({ orphans: 2, unresolved: 1, unusedRunning: 2, noDeadline: 1, killed: 0, adopted: 0, shortened: 0, skipped: 4, failed: 0 });
      for (const id of [withoutDeadline, ofCold, idle, preferred, other]) expect(await alive(id)).toBe(true);
      expect(await deadlineOf(idle)).toBe(idleDeadline);
      expect(await stores.row(adoptedLater)).toEqual({ sandboxId: ofCold, creatingSince: null });
      expect(await stores.row(raced)).toEqual({ sandboxId: other, creatingSince: null });
      expect(h.hints.published).toEqual([]);

      // The next round follows the rows as they are now.
      const next = await h.sweeper().sweep();
      expect(next).toMatchObject({ killed: 1, adopted: 0, shortened: 1, skipped: 0 });
      expect(h.gateway.destroyed).toEqual([preferred]);
      expect(h.gateway.deadlines.map(({ id }) => id)).toEqual([ofCold]);
    });

    it("acts only while the binding's row is still the one it decided on", async () => {
      const h = await setup();
      const cold = await h.stores.session();
      await h.move(cold, "cold");
      const orphan = await h.sandbox(cold);
      // A Turn commits a creation intent between the sweeper's read and its lock.
      const round = await h.sweeper(h.stores.runner(), { afterRecheck: () => h.move(cold, "creating") }).sweep();
      expect(round).toMatchObject({ orphans: 1, killed: 0, skipped: 1, failed: 0 });
      expect(await h.alive(orphan)).toBe(true);
      expect(await h.stores.row(cold)).toMatchObject({ sandboxId: null, creatingSince: expect.any(Date) });
    });

    it("kills at most 50 Sandboxes a round, the running ones first, and the rest in the next round", async () => {
      const h = await setup();
      const running = [];
      for (let i = 0; i < 55; i++) running.push(await h.sandbox(`sesn_gone_${i}`));
      const paused = [];
      for (let i = 0; i < 5; i++) paused.push(await h.sandbox(`sesn_gone_paused_${i}`, { paused: true }));
      const first = await h.sweeper().sweep();
      expect(first).toMatchObject({ orphans: 60, killed: 50, deferred: 10, failed: 0 });
      expect(h.gateway.destroyed).toHaveLength(50);
      for (const id of paused) expect(await h.alive(id)).toBe(true);
      const second = await h.sweeper().sweep();
      expect(second).toMatchObject({ orphans: 10, killed: 10, deferred: 0 });
      expect(new Set(h.gateway.destroyed)).toEqual(new Set([...running, ...paused]));
    });

    it("counts a failed kill, goes on with the others and kills it in the next round; a failed list takes no action", async () => {
      const h = await setup();
      const [first, second] = [await h.sandbox("sesn_gone_1"), await h.sandbox("sesn_gone_2")];
      const destroy = vi.spyOn(h.gateway, "destroy").mockImplementationOnce(async () => { throw new TypeError("fetch failed: secret body"); });
      const round = await h.sweeper().sweep();
      expect(round).toMatchObject({ killed: 1, failed: 1, failures: [{ sandboxId: first, action: "kill", error: "TypeError" }] });
      expect(JSON.stringify(h.lines)).not.toContain("secret body");
      expect(await h.alive(first)).toBe(true);
      expect(await h.alive(second)).toBe(false);
      expect(await h.sweeper().sweep()).toMatchObject({ killed: 1, failed: 0 });
      expect(await h.alive(first)).toBe(false);

      destroy.mockClear();
      await h.sandbox("sesn_gone_3");
      vi.spyOn(h.gateway, "listSandboxes").mockRejectedValueOnce(new Error("Sandbox list answered HTTP 503"));
      const failed = await h.sweeper().sweep();
      expect(failed).toEqual({ msg: "sandbox_sweep", env: ENVIRONMENT, listed: 0, orphans: 0, unresolved: 0, unusedRunning: 0, noDeadline: 0, expired: 0,
        killed: 0, adopted: 0, cleared: 0, shortened: 0, restored: 0, reclaimed: 0, deferred: 0, skipped: 0, failed: 0,
        error: "Sandbox list answered HTTP 503", ms: expect.any(Number) });
      expect(destroy).not.toHaveBeenCalled();
    });

    /** A Ready binding whose Sandbox has no deadline: the sweeper kills it when no Turn uses it. */
    async function undying({ stores, sandbox, move }: Setup) {
      const session = await stores.session();
      const sandboxId = await sandbox(session, { deadline: false });
      await move(session, { ready: sandboxId });
      return { session, sandboxId };
    }

    reclaiming("kills a Sandbox its binding records only by reclaiming the binding: a Turn admitted after the recheck keeps it", async () => {
      const h = await setup();
      const { session, sandboxId } = await undying(h);
      const turn = h.stores.runner();
      const round = await h.sweeper(h.stores.runner(), { afterRecheck: async () => {
        // Its input is claimed and its use begun between the recheck and the kill.
        expect(await turn.lifecycle.begin(await h.stores.admit(session))).toBe(true);
      } }).sweep();
      expect(round).toMatchObject({ noDeadline: 1, killed: 0, skipped: 1, failed: 0 });
      expect(await h.alive(sandboxId)).toBe(true);
      expect(await h.stores.row(session)).toEqual({ sandboxId, creatingSince: null });
      expect(h.hints.published).toEqual([]);
    });

    reclaiming("makes a Turn that arrives while the binding is reclaimed wait, then start on the Cold binding", async () => {
      const h = await setup();
      const { session, sandboxId } = await undying(h);
      const turn = h.manager(h.stores.runner());
      const destroy = h.gateway.destroy.bind(h.gateway);
      let admission: Promise<boolean> | undefined;
      let admittedDuringKill: boolean | undefined;
      vi.spyOn(h.gateway, "destroy").mockImplementationOnce(async (id) => {
        // The reclamation is claimed: the Turn's admission waits for it.
        let admitted = false;
        admission = turn.beginActivity(await h.stores.admit(session)).finally(() => { admitted = true; });
        await new Promise((resolve) => setTimeout(resolve, 50));
        admittedDuringKill = admitted;
        return destroy(id);
      });
      const round = await h.sweeper().sweep();
      expect(round).toMatchObject({ noDeadline: 1, killed: 1, skipped: 0, failed: 0 });
      expect(admittedDuringKill).toBe(false);
      // Told by the reclamation's hint, not after its 2 s reread.
      const started = Date.now();
      expect(await admission).toBe(true);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(await h.alive(sandboxId)).toBe(false);
      expect(await h.stores.row(session)).toEqual({ sandboxId: null, creatingSince: null });
      expect(h.hints.published).toEqual([session]);
    });

    reclaiming("resumes a reclamation left claimed: a failed kill keeps the Session's Turns waiting until the next round completes it", async () => {
      const h = await setup();
      const { session, sandboxId } = await undying(h);
      vi.spyOn(h.gateway, "destroy").mockImplementationOnce(async () => { throw new TypeError("fetch failed"); });
      const first = await h.sweeper().sweep();
      expect(first).toMatchObject({ noDeadline: 1, killed: 0, failed: 1, failures: [{ sandboxId, action: "kill", error: "TypeError" }] });
      const turn = h.stores.runner();
      const activity = await h.stores.admit(session);
      expect(await turn.lifecycle.begin(activity)).toBe(false);

      const second = await h.sweeper().sweep();
      // Selection leaves the reclaiming binding's Sandbox to the reclamation, which the round resumes.
      expect(second).toMatchObject({ noDeadline: 0, orphans: 0, killed: 0, reclaimed: 1, skipped: 0, failed: 0 });
      expect(await h.alive(sandboxId)).toBe(false);
      expect(await h.stores.row(session)).toEqual({ sandboxId: null, creatingSince: null });
      expect(await turn.lifecycle.begin(activity)).toBe(true);
      expect(await h.sweeper().sweep()).toMatchObject({ reclaimed: 0, skipped: 0 });
    });

    it("sets a shortened deadline back to 24 hours when a Turn began using the Sandbox meanwhile", async () => {
      const h = await setup();
      const { stores, gateway, sandbox, move } = h;
      const session = await stores.session();
      const idle = await sandbox(session);
      await move(session, { ready: idle });
      const round = await h.sweeper(stores.runner(), { afterRecheck: async () => {
        // A Turn's input arrives and its connect sets 24 hours, before the shorten.
        await stores.queue(session);
        await gateway.setTimeout(idle, SANDBOX_RUNNING_SECONDS);
      } }).sweep();
      expect(round).toMatchObject({ unusedRunning: 1, shortened: 1, restored: 1, failed: 0 });
      expect(gateway.deadlines).toEqual([SANDBOX_RUNNING_SECONDS, SANDBOX_IDLE_SECONDS, SANDBOX_RUNNING_SECONDS].map((seconds) => ({ id: idle, seconds })));
      expect(await h.deadlineOf(idle)).toBeGreaterThan(Date.now() + (SANDBOX_RUNNING_SECONDS - 60) * 1000);
    });

    it("settles bindings Creating past their deadline that the listing showed no Sandbox for: Cold when the gateway holds none, else adopted", async () => {
      const h = await setup();
      const { stores, sandbox, move } = h;
      const empty = await stores.session();
      await move(empty, "creating");
      const late = await stores.session();
      await move(late, "creating");
      const fresh = await stores.session();
      await stores.elapse(INTENT_DEADLINE_SECONDS);
      await move(fresh, "creating");
      let created: string | undefined;
      // Created after the listing: only reconciliation's own list by binding finds it.
      const round = await h.sweeper(stores.runner(), { afterScan: async () => { created = await sandbox(late); } }).sweep();
      expect(round).toMatchObject({ listed: 0, unresolved: 0, expired: 2, adopted: 1, cleared: 1, killed: 0, skipped: 0, failed: 0 });
      expect(await stores.row(empty)).toEqual({ sandboxId: null, creatingSince: null });
      expect(await stores.row(late)).toEqual({ sandboxId: created, creatingSince: null });
      // Within its deadline: its creator may still record a Sandbox.
      expect(await stores.row(fresh)).toMatchObject({ sandboxId: null, creatingSince: expect.any(Date) });
      expect(new Set(h.hints.published)).toEqual(new Set([empty, late]));
      expect(await h.sweeper().sweep()).toMatchObject({ expired: 0, cleared: 0, adopted: 0 });
    });

    it(`settles at most ${SWEEP_MAX_UNSETTLED} such bindings a round, the oldest intents first, and the rest in the next round`, async () => {
      const h = await setup();
      const sessions: string[] = [];
      for (let i = 0; i < SWEEP_MAX_UNSETTLED + 2; i++) {
        const session = await h.stores.session();
        await h.move(session, "creating");
        sessions.push(session);
        // Each one older than the next.
        await h.stores.elapse(1);
      }
      await h.stores.elapse(INTENT_DEADLINE_SECONDS);
      expect(await h.sweeper().sweep()).toMatchObject({ expired: SWEEP_MAX_UNSETTLED, cleared: SWEEP_MAX_UNSETTLED, failed: 0 });
      for (const session of sessions.slice(-2)) expect(await h.stores.row(session)).toMatchObject({ creatingSince: expect.any(Date) });
      expect(await h.sweeper().sweep()).toMatchObject({ expired: 2, cleared: 2, failed: 0 });
      for (const session of sessions) expect(await h.stores.row(session)).toEqual({ sandboxId: null, creatingSince: null });
    });
  });
}
