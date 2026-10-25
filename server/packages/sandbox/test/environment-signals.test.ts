import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import type { EnvironmentBinding, EnvironmentLockResult, SandboxActivity, SandboxLifecycleStore } from "@oma-server/store";
import { DefaultSandboxManager, type EnvSpec, type SandboxEnvironmentBinding } from "../src/sandbox-manager.js";
import { FakeSandboxClient } from "../src/fake-sandbox-client.js";
import { INTENT_DEADLINE_SECONDS } from "../src/sandbox-client.js";
import { BINDING_REREAD_MS } from "../src/environment-signals.js";
import { signalBus } from "./bindings.js";

const spec: EnvSpec = { tenantId: "t", workspaceId: "w", workspaceMount: {
  bucket: "agentry", prefix: "t/w/", agentName: "agent", pvName: "pv", credentialProviderName: "credentials",
} };
/** What a lost Runner's calls return: nothing, ever. */
const GONE = new Promise<never>(() => {});
/** Let every pending continuation run; no timer fires. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
/** A promise and whether it settled yet. */
function watch<T>(promise: Promise<T>) {
  const watched = { promise, settled: false };
  promise.then(() => { watched.settled = true; }, () => { watched.settled = true; });
  return watched;
}

/**
 * Runners sharing the stores, the gateway and the hints, as a fleet shares
 * PostgreSQL, the gateway and Redis; each has its own Sandbox Manager.
 */
function fleet() {
  const stores = createMemoryStores();
  const gateway = new FakeSandboxClient();
  const bus = signalBus();
  let reclaiming = false;
  /** Explicit termination's coordination over the shared binding rows: no Turn is admitted while it reclaims. */
  const lifecycle: SandboxLifecycleStore = {
    begin: vi.fn(async () => !reclaiming),
    finish: vi.fn(async () => {}),
    claimReclamation: vi.fn(async (bindingId: string) => {
      const row = await stores.delegationStore.withEnvironmentLock(bindingId, async ({ sandboxId, creatingSince, now }) => ({ value: { sandboxId, creatingSince, now } }));
      reclaiming = true;
      return { bindingId, ...row };
    }),
    completeReclamation: vi.fn(async ({ bindingId }) => {
      await stores.delegationStore.withEnvironmentLock(bindingId, async () => ({ next: "cold", value: undefined }));
      reclaiming = false;
    }),
  };
  /** A Runner; one without hints reads the rows it waits for on its own. */
  const runner = ({ hints = true } = {}) =>
    new DefaultSandboxManager({ sandboxClient: gateway, environment: "test", lifecycle, environmentSignals: hints ? bus : undefined });
  /** A Turn's binding on its Runner, counting the Turn's reads of the row. */
  const binding = (id = "root") => {
    const counted = {
      id, reads: 0,
      withLock<T>(work: (row: EnvironmentBinding) => Promise<EnvironmentLockResult<T>>): Promise<T> {
        counted.reads++;
        return stores.delegationStore.withEnvironmentLock(id, work);
      },
    };
    return counted satisfies SandboxEnvironmentBinding;
  };
  /** The next create stalls at the gateway's claim until released. */
  const stallCreate = () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let stalled = false;
    gateway.createFault = async (step) => { if (step === "claim" && !stalled) { stalled = true; await released; } };
    return release;
  };
  const row = (id = "root") => stores.delegationStore.withEnvironmentLock(id, async ({ sandboxId, creatingSince }) => ({ value: { sandboxId, creatingSince } }));
  return { gateway, bus, lifecycle, runner, binding, stallCreate, row };
}

describe("Turns waiting for a binding follow its environment hint (ADR-0023)", () => {
  // Fake time: no wait ends on its timer unless a test lets time pass.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("continues a Child Session's waiting Turn on another Runner as soon as the parent's Runner records the Sandbox", async () => {
    const f = fleet();
    const release = f.stallCreate();
    const parent = watch(f.runner().open(spec, f.binding()).writeFile("parent.txt", "parent"));
    await settle();
    const child = f.binding();
    const tool = watch(f.runner().open(spec, child).writeFile("child.txt", "child"));
    await settle();
    expect(child.reads).toBe(1);
    expect(f.bus.subscribers()).toBe(2);

    release();
    await settle();
    // No time passed: the hint, not a re-read, ended the wait.
    expect(tool.settled).toBe(true);
    await Promise.all([parent.promise, tool.promise]);
    expect(child.reads).toBe(2);
    expect(f.gateway.created).toHaveLength(1);
    expect(f.gateway.filesOf(f.gateway.created[0]).get("/home/user/workspace/child.txt")?.content).toBe("child");
    expect(f.bus.published).toEqual(["root"]);
    // Each wait unsubscribed when it ended.
    expect(f.bus.subscribers()).toBe(0);
  });

  it("continues within 2 s when the hint is lost", async () => {
    const f = fleet();
    f.bus.losing = true;
    const release = f.stallCreate();
    void f.runner().open(spec, f.binding()).writeFile("parent.txt", "parent");
    await settle();
    const child = f.binding();
    const tool = watch(f.runner().open(spec, child).writeFile("child.txt", "child"));
    await settle();
    release();
    await settle();
    expect(f.bus.published).toEqual(["root"]);
    expect(tool.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(BINDING_REREAD_MS - 1);
    expect(tool.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(tool.settled).toBe(true);
    expect(child.reads).toBe(2);
  });

  it("re-reads every 2 s alone on a Runner without hints", async () => {
    const f = fleet();
    const release = f.stallCreate();
    void f.runner({ hints: false }).open(spec, f.binding()).writeFile("parent.txt", "parent");
    await settle();
    const child = f.binding();
    const tool = watch(f.runner({ hints: false }).open(spec, child).writeFile("child.txt", "child"));
    await settle();
    release();
    await vi.advanceTimersByTimeAsync(BINDING_REREAD_MS);
    await settle();
    expect(tool.settled).toBe(true);
    expect(child.reads).toBe(2);
    expect(f.bus.published).toEqual([]);
  });

  it("reads the row at most once per 2 s for each waiter, its parallel tool calls sharing one wait", async () => {
    const f = fleet();
    const release = f.stallCreate();
    void f.runner().open(spec, f.binding()).writeFile("parent.txt", "parent");
    await settle();
    const first = f.binding(), second = f.binding();
    const firstTurn = f.runner().open(spec, first);
    const tools = [
      firstTurn.writeFile("a.txt", "a"), firstTurn.writeFile("b.txt", "b"), firstTurn.list(),
      f.runner().open(spec, second).writeFile("c.txt", "c"),
    ].map((tool) => watch<unknown>(tool));
    await settle();
    expect([first.reads, second.reads]).toEqual([1, 1]);
    for (let period = 1; period <= 5; period++) {
      await vi.advanceTimersByTimeAsync(BINDING_REREAD_MS - 1);
      expect([first.reads, second.reads]).toEqual([period, period]);
      await vi.advanceTimersByTimeAsync(1);
      expect([first.reads, second.reads]).toEqual([period + 1, period + 1]);
    }
    expect(tools.some((tool) => tool.settled)).toBe(false);
    release();
    await Promise.all(tools.map((tool) => tool.promise));
    expect([first.reads, second.reads]).toEqual([7, 7]);
  });

  it("ends the wait with the Turn's signal as an aborted timer ends, and stops hearing hints", async () => {
    const f = fleet();
    f.stallCreate();
    void f.runner().open(spec, f.binding()).writeFile("parent.txt", "parent");
    await settle();
    const interrupt = new AbortController();
    const turn = f.runner().open(spec, f.binding());
    await turn.prepare(undefined, { signal: interrupt.signal });
    const tool = turn.writeFile("child.txt", "child").catch((error: unknown) => error);
    await settle();
    expect(f.bus.subscribers()).toBe(2);
    const reason = new DOMException("Session interrupted", "AbortError");
    interrupt.abort(reason);
    expect(await tool).toMatchObject({ name: "AbortError", cause: reason });
    expect(f.bus.subscribers()).toBe(1);
  });

  it("waits for a lost creator until the intent deadline, re-reading every 2 s, then reconciles", async () => {
    const f = fleet();
    // The creator's Runner is lost during create; the gateway never claims.
    f.gateway.createFault = (step) => step === "claim" ? GONE : undefined;
    void f.runner().open(spec, f.binding()).writeFile("lost.txt", "never confirmed");
    await settle();
    f.gateway.createFault = undefined;
    const list = vi.spyOn(f.gateway, "listSandboxes");
    const child = f.binding();
    const tool = watch(f.runner().open(spec, child).writeFile("child.txt", "child"));
    await settle();

    await vi.advanceTimersByTimeAsync(INTENT_DEADLINE_SECONDS * 1000 - 1);
    expect(tool.settled).toBe(false);
    expect(list).not.toHaveBeenCalled();
    // A read at the start and one every 2 s: at 0, 2, …, 178 s.
    expect(child.reads).toBe(INTENT_DEADLINE_SECONDS / 2);
    await vi.advanceTimersByTimeAsync(1);
    await tool.promise;
    expect(list).toHaveBeenCalledTimes(1);
    expect(await f.row()).toEqual({ sandboxId: f.gateway.created[0], creatingSince: null });
  });

  describe("admission while the binding is reclaimed", () => {
    const activity: SandboxActivity = { bindingId: "root", sessionId: "child", fence: { eventId: "pe_1", ownerId: "runner", generation: 1 } };
    /** A Ready binding whose termination, on another Runner, stalls in the gateway's kill until released. */
    async function reclaiming(f: ReturnType<typeof fleet>) {
      const reclaimer = f.runner();
      await reclaimer.open(spec, f.binding()).writeFile("saved.txt", "kept");
      f.bus.published.length = 0;
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const destroy = f.gateway.destroy.bind(f.gateway);
      vi.spyOn(f.gateway, "destroy").mockImplementationOnce(async (id) => { await released; await destroy(id); });
      const reclaimed = reclaimer.reclaim(f.binding());
      await settle();
      return { release, reclaimed };
    }

    it("admits a Turn as soon as the reclaimer's Runner finishes, and asks at most once per 2 s until then", async () => {
      const f = fleet();
      const { release, reclaimed } = await reclaiming(f);
      const admitted = watch(f.runner().beginActivity(activity));
      await settle();
      expect(f.lifecycle.begin).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3 * BINDING_REREAD_MS);
      expect(f.lifecycle.begin).toHaveBeenCalledTimes(4);
      expect(admitted.settled).toBe(false);

      release();
      await reclaimed;
      await settle();
      expect(admitted.settled).toBe(true);
      expect(await admitted.promise).toBe(true);
      expect(f.lifecycle.begin).toHaveBeenCalledTimes(5);
      expect(f.bus.published).toEqual(["root"]);
    });

    it("admits it within 2 s when the hint is lost, and gives up at the intent deadline", async () => {
      const f = fleet();
      f.bus.losing = true;
      const { release, reclaimed } = await reclaiming(f);
      const admitted = watch(f.runner().beginActivity(activity));
      release();
      await reclaimed;
      expect(admitted.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(BINDING_REREAD_MS);
      expect(await admitted.promise).toBe(true);

      const stuck = await reclaiming(f);
      const abandoned = f.runner().beginActivity(activity).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(INTENT_DEADLINE_SECONDS * 1000);
      expect(await abandoned).toMatchObject({ message: expect.stringMatching(/termination cleanup is still pending/) });
      stuck.release();
      await stuck.reclaimed;
    });
  });
});
