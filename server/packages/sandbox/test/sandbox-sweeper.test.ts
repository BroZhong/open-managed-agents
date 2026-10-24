import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentBindingChanged, type EnvironmentBinding, type EnvironmentLockResult, type SandboxBindingFacts } from "@oma-server/store";
import { FakeSandboxClient } from "../src/fake-sandbox-client.js";
import { SANDBOX_BINDING_LABEL, SANDBOX_ENVIRONMENT_LABEL } from "../src/sandbox-sweep.js";
import { SWEEP_INTERVAL_MS, SWEEP_JITTER_MS, SandboxSweeper, type SweepRound } from "../src/sandbox-sweeper.js";
import { sandboxSweeperContract, type SweeperRunnerStores, type SweeperStores } from "./sandbox-sweeper-contract.js";
import { databaseClock } from "./bindings.js";

interface FakeRow { sandboxId: string | null; creatingSince: Date | null; reclaiming: boolean }

/**
 * The rows and Session facts as PostgreSQL keeps them, in memory: each
 * Runner's binding operations queue only behind its own, take a snapshot, and
 * move the row by compare-and-set; a read under the lock creates the row; a
 * reclaiming binding rejects. Intents are written with the database clock.
 */
function fakeSweeperStores(): SweeperStores {
  const clock = databaseClock(new Date());
  const rows = new Map<string, FakeRow>();
  const sessions = new Map<string, { bindingId: string; terminated: boolean; queued: number }>();
  let sessionCount = 0;
  const reclaimingError = () => new Error("Sandbox reclamation in progress; retry input");
  const facts = (bindingId: string, row: FakeRow): SandboxBindingFacts => {
    const alive = [...sessions.values()].filter((s) => s.bindingId === bindingId && !s.terminated);
    return { ...row, inUse: alive.some((s) => s.queued > 0), allSessionsTerminated: alive.length === 0 };
  };
  const runner = (): SweeperRunnerStores => {
    const queues = new Map<string, Promise<unknown>>();
    return {
      bindings: {
        withEnvironmentLock<T>(bindingId: string, work: (binding: EnvironmentBinding) => Promise<EnvironmentLockResult<T>>): Promise<T> {
          const perform = async () => {
            if (!rows.has(bindingId)) rows.set(bindingId, { sandboxId: null, creatingSince: null, reclaiming: false });
            const read = { ...rows.get(bindingId)! };
            if (read.reclaiming) throw reclaimingError();
            const { value, next } = await work({ sandboxId: read.sandboxId, creatingSince: read.creatingSince, now: clock.now() });
            const row = rows.get(bindingId)!;
            if (row.reclaiming) throw reclaimingError();
            if (row.sandboxId !== read.sandboxId || row.creatingSince?.getTime() !== read.creatingSince?.getTime()) throw new EnvironmentBindingChanged(bindingId);
            if (next) Object.assign(row, next === "creating" ? { sandboxId: null, creatingSince: clock.now() }
              : { sandboxId: next === "cold" ? null : next.ready, creatingSince: null });
            return value;
          };
          const result = (queues.get(bindingId) ?? Promise.resolve()).then(perform, perform);
          queues.set(bindingId, result.catch(() => {}));
          return result;
        },
      },
      facts: {
        sweepFacts: async (bindingIds) => ({
          now: clock.now(),
          bindings: new Map([...new Set(bindingIds)].flatMap((id) => { const row = rows.get(id); return row ? [[id, facts(id, { ...row })] as const] : []; })),
        }),
      },
    };
  };
  const ofBinding = (bindingId: string) => [...sessions.values()].filter((s) => s.bindingId === bindingId);
  return {
    runner,
    session: async () => {
      const id = `sesn_${++sessionCount}`;
      sessions.set(id, { bindingId: id, terminated: false, queued: 0 });
      return id;
    },
    queue: async (id) => { sessions.get(id)!.queued++; },
    terminate: async (id) => { Object.assign(sessions.get(id)!, { terminated: true, queued: 0 }); },
    reclaiming: async (bindingId) => {
      for (const session of ofBinding(bindingId)) Object.assign(session, { terminated: true, queued: 0 });
      rows.get(bindingId)!.reclaiming = true;
    },
    elapse: async (seconds) => clock.elapse(seconds),
    row: async (bindingId) => {
      const row = rows.get(bindingId);
      return row ? { sandboxId: row.sandboxId, creatingSince: row.creatingSince } : null;
    },
  };
}

sandboxSweeperContract("the Sandbox sweeper over stores that behave as PostgreSQL's", async () => fakeSweeperStores());

describe("the sweeper on a Runner: rounds every 10 minutes with jitter, stopped by shutdown", () => {
  afterEach(() => { vi.useRealTimers(); });

  async function runner(random: () => number) {
    const stores = fakeSweeperStores();
    const gateway = new FakeSandboxClient();
    const lines: SweepRound[] = [];
    const { bindings, facts } = stores.runner();
    const sweeper = new SandboxSweeper({ client: gateway, facts, bindings, environment: "test", random,
      logger: { info: (line: string) => lines.push(JSON.parse(line)) } });
    const orphan = () => gateway.create({ metadata: { [SANDBOX_BINDING_LABEL]: `sesn_gone_${gateway.created.length}`, [SANDBOX_ENVIRONMENT_LABEL]: "test" } })
      .then(({ id }) => id);
    return { gateway, lines, sweeper, orphan };
  }

  it("starts at a random point of the first period, then sweeps every 10 minutes give or take 2", async () => {
    vi.useFakeTimers();
    const draws = [0.25, 0, 0.9999, 0.5];
    const r = await runner(() => draws.shift() ?? 0.5);
    r.sweeper.start();
    r.sweeper.start(); // Idempotent: one schedule.
    const at = async (ms: number, rounds: number) => {
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(r.lines).toHaveLength(rounds - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(r.lines).toHaveLength(rounds);
    };
    await at(0.25 * SWEEP_INTERVAL_MS, 1);
    await at(SWEEP_INTERVAL_MS - SWEEP_JITTER_MS, 2);
    await at(Math.ceil(SWEEP_INTERVAL_MS + 0.9998 * SWEEP_JITTER_MS), 3);
    await r.sweeper.stop();
    await vi.advanceTimersByTimeAsync(2 * SWEEP_INTERVAL_MS);
    expect(r.lines).toHaveLength(3);
  });

  it("stops a round in flight before its next action, starts no other, and resolves once the action ended", async () => {
    vi.useFakeTimers();
    const r = await runner(() => 0);
    const [first, second] = [await r.orphan(), await r.orphan()];
    let release!: () => void;
    const destroy = r.gateway.destroy.bind(r.gateway);
    let entered!: () => void;
    const inFlight = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(r.gateway, "destroy").mockImplementationOnce(async (id) => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      return destroy(id);
    });
    r.sweeper.start();
    await vi.advanceTimersByTimeAsync(0);
    await inFlight;
    let stopped = false;
    const stopping = r.sweeper.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(r.gateway.destroyed).toEqual([first]);
    expect(await r.gateway.state(second)).toBe("running");
    expect(r.lines).toEqual([expect.objectContaining({ killed: 1, aborted: true })]);
    await vi.advanceTimersByTimeAsync(2 * SWEEP_INTERVAL_MS);
    expect(r.lines).toHaveLength(1);
  });

  it("starts no round once stopped before the first", async () => {
    vi.useFakeTimers();
    const r = await runner(() => 0.5);
    r.sweeper.start();
    await r.sweeper.stop();
    r.sweeper.start();
    await vi.advanceTimersByTimeAsync(2 * SWEEP_INTERVAL_MS);
    expect(r.lines).toEqual([]);
  });
});
