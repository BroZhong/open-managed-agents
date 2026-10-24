import { afterAll, describe, expect, it, vi } from "vitest";
import type { Agent, DelegationStore, PendingEventFence, PendingEventStore, SandboxLifecycleStore, Session, SessionStore } from "@oma-server/store";
import { DefaultSandboxManager } from "../src/sandbox-manager.js";
import { FakeSandboxClient } from "../src/fake-sandbox-client.js";
import { EMPTY_SKILL_SET, SkillInstallError, skillSetOf, type SkillSet } from "../src/skill-install.js";
import { SANDBOX_IDLE_SECONDS } from "../src/sandbox-client.js";
import { DefaultTurnSandboxes, type SandboxLeaseRequest, type TurnSandboxesDeps } from "../src/turn-sandboxes.js";
import { WorkspaceMountUnavailable } from "../src/workspace-mount.js";
import { Bundles, TENANT, text } from "./skill-bundles.js";

/** The stores a Turn's Sandbox protocol reaches, all from one backend. */
export interface TurnSandboxStores {
  sessionStore: SessionStore;
  pendingEventStore: PendingEventStore;
  delegationStore: DelegationStore;
  /** The native lifecycle store, where the backend has one. */
  lifecycle?: SandboxLifecycleStore;
}

const workspaceMount = { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" };
const agent: Agent = { id: "agent_sbx", tenantId: TENANT, name: "Sandboxed", model: "model", system: "", runtime: "pi-agent",
  sandbox: { enabled: true, image: "ubuntu:22.04" }, createdAt: new Date(), updatedAt: new Date() };

/**
 * The Turn side of the Sandbox protocol (ADR-0023, #281): a Turn attempt
 * acquires a lease on its Session's Sandbox and releases it with its
 * settlement evidence; termination reclaims through the same module. Run
 * against each store backend: the binding row, the resource uses and the
 * Skill Install record are the only state a lease leaves behind.
 */
export function turnSandboxesContract(name: string, createStores: () => Promise<TurnSandboxStores>,
  options: { teardown?: () => Promise<void>; /** The stores include the native lifecycle store. */ lifecycle?: boolean } = {}): void {
  describe(name, () => {
    if (options.teardown) afterAll(options.teardown);

    async function setup(deps: Partial<TurnSandboxesDeps> = {}) {
      const stores = await createStores();
      const client = new FakeSandboxClient();
      const bundles = new Bundles();
      const manager = new DefaultSandboxManager({ sandboxClient: client, skillBundleStore: bundles, lifecycle: stores.lifecycle, environment: "test" });
      const open = vi.spyOn(manager, "open");
      const errors: Array<{ sessionId: string; error: unknown }> = [];
      const sandboxes = new DefaultTurnSandboxes({ manager, bindings: stores.delegationStore, sessions: stores.sessionStore,
        workspaceMount, onError: (failure) => errors.push(failure), ...deps });
      const session = (overrides: Partial<Agent> = {}, parent?: Session) => stores.sessionStore.create({
        tenantId: TENANT, agentId: agent.id, agent: { ...agent, ...overrides }, workspaceId: "ws_1",
        ...(parent ? { delegation: { parentSessionId: parent.id, parentTurnId: "turn_1_a1", parentToolUseId: "call_agent", sandboxSessionId: parent.id } } : {}),
      });
      /** Queue an input and claim it: the Turn attempt's fence. */
      const claim = async (target: Session): Promise<PendingEventFence> => {
        await stores.pendingEventStore.enqueue(target.id, { type: "user.message", data: { content: [] }, sessionThreadId: "sthr_primary" });
        const claimed = (await stores.pendingEventStore.claim(target.id, "runner", 60_000))!;
        return { eventId: claimed.event.id, ownerId: claimed.ownerId, generation: claimed.generation };
      };
      const ack = (target: Session, fence: PendingEventFence) => stores.pendingEventStore.ack(target.id, fence.eventId, fence);
      const acquire = (target: Session, fence: PendingEventFence, request: Partial<SandboxLeaseRequest> = {}) => sandboxes.acquire({
        session: target, agent: target.agent, fence, signal: new AbortController().signal, skills: EMPTY_SKILL_SET,
        skillInstallFailed: () => {}, ...request,
      });
      /** One whole Turn: claim, lease, `work` with the executor, acknowledgement, settled release. */
      const turn = async <T>(target: Session, work: (executor: NonNullable<Awaited<ReturnType<typeof acquire>>>["executor"]) => Promise<T>,
        request: Partial<SandboxLeaseRequest> = {}): Promise<T> => {
        const fence = await claim(target);
        const lease = (await acquire(target, fence, request))!;
        const result = await work(lease.executor);
        await ack(target, fence);
        await lease.release({ settled: true });
        return result;
      };
      const users = (bindingId: string) => stores.delegationStore.hasResourceUsers(bindingId);
      return { stores, client, bundles, manager, open, errors, sandboxes, session, claim, ack, acquire, turn, users };
    }

    /** A Sandbox claimed for the binding that nothing recorded, as a lost create leaves one. */
    const claimedFor = async (h: Awaited<ReturnType<typeof setup>>, bindingId: string) =>
      (await h.client.create({ metadata: { "oma.dev/binding": bindingId, "oma.dev/environment": "test" } })).id;

    /** Admission and its end are observed, as the native lifecycle store's are. */
    function trackActivity(manager: DefaultSandboxManager) {
      const begin = vi.spyOn(manager, "beginActivity").mockResolvedValue(true);
      const finish = vi.spyOn(manager, "finishActivity").mockResolvedValue();
      return { begin, finish };
    }

    it("acquires no lease for an Agent that opted out of the Sandbox, and records no use of its binding", async () => {
      const h = await setup();
      const optedOut = await h.session({ sandbox: { enabled: false } });
      const fence = await h.claim(optedOut);
      expect(await h.acquire(optedOut, fence)).toBeNull();
      expect(h.open).not.toHaveBeenCalled();
      expect(await h.users(optedOut.id)).toBe(false);
    });

    it("records a Child Turn's use of its root's binding until its settled release, and runs it in the root's Sandbox", async () => {
      const h = await setup();
      const parent = await h.session();
      const child = await h.session({}, parent);
      await h.turn(parent, (executor) => executor!.writeFile("shared.txt", "from parent"));
      const fence = await h.claim(child);
      const lease = (await h.acquire(child, fence))!;
      expect(await h.users(parent.id)).toBe(true);
      expect(await lease.executor!.readFile("shared.txt")).toBe("from parent");
      expect(h.client.created).toHaveLength(1);
      expect(h.client.createOptsOf(h.client.created[0]).metadata).toMatchObject({ "oma.dev/binding": parent.id });
      await lease.release({ settled: true });
      expect(await h.users(parent.id)).toBe(false);
    });

    it("opens one Sandbox session per Turn and keeps the Sandbox in the binding across Turns", async () => {
      const h = await setup();
      const session = await h.session();
      await h.turn(session, (executor) => executor!.writeFile("carry.txt", "turn 1"));
      expect(await h.turn(session, (executor) => executor!.readFile("carry.txt"))).toBe("turn 1");
      expect(h.open).toHaveBeenCalledTimes(2);
      expect(h.client.created).toHaveLength(1);
      // A pure-chat Turn opens a lease without starting anything.
      await h.turn(session, async () => {});
      expect(h.client.created).toHaveLength(1);
    });

    it("keeps a Turn's unconfirmed operation out of the next Turn's Workspace check", async () => {
      const h = await setup();
      const session = await h.session();
      const fence = await h.claim(session);
      const lease = (await h.acquire(session, fence))!;
      await lease.executor!.writeFile("saved.txt", "once");
      h.client.pause(h.client.created[0]);
      await expect(lease.executor!.writeFile("saved.txt", "twice")).rejects.toThrow(/not replayed/);
      await expect(lease.checkWorkspace()).rejects.toBeInstanceOf(WorkspaceMountUnavailable);
      await h.ack(session, fence);
      await lease.release({ settled: true });
      const next = await h.claim(session);
      const nextLease = (await h.acquire(session, next))!;
      expect(await nextLease.executor!.readFile("saved.txt")).toBe("once");
      await expect(nextLease.checkWorkspace()).resolves.toBeUndefined();
    });

    it("reports a failed preparation on the lease, which still holds the Turn's use until its release", async () => {
      const h = await setup();
      const session = await h.session();
      await h.turn(session, (executor) => executor!.writeFile("saved.txt", "x"));
      h.client.setMountFailure(h.client.created[0], "storage offline");
      const fence = await h.claim(session);
      const lease = (await h.acquire(session, fence))!;
      expect(lease.failure).toEqual({ code: "sandbox_prepare_failed", message: new WorkspaceMountUnavailable().message });
      expect(lease.executor).toBeUndefined();
      expect(await h.users(session.id)).toBe(true);
      await lease.release({ settled: true });
      expect(await h.users(session.id)).toBe(false);
    });

    it("names a Skill Install that failed while preparation decided it", async () => {
      const h = await setup();
      const session = await h.session();
      await h.turn(session, (executor) => executor!.writeFile("saved.txt", "x"));
      vi.spyOn(h.stores.delegationStore, "installedSkillSet").mockRejectedValueOnce(new Error("connection reset"));
      const skills = skillSetOf([await h.bundles.add("writer", [text("SKILL.md", "v1")])]);
      const lease = (await h.acquire(session, await h.claim(session), { skills }))!;
      expect(lease.failure).toEqual({ code: "skills_install_failed", message: "Skill Install failed at check: cannot read what the binding installed: connection reset" });
    });

    it("ends an operation that waited for a failed Skill Install without running it, and tells the Turn", async () => {
      const h = await setup();
      const session = await h.session();
      h.client.skillInstallFault = (stage) => { if (stage === "switch") throw new Error("No space left on device"); };
      const failed: SkillInstallError[] = [];
      const skills: SkillSet = skillSetOf([await h.bundles.add("writer", [text("SKILL.md", "v1")])]);
      const lease = (await h.acquire(session, await h.claim(session), { skills, skillInstallFailed: (error) => failed.push(error) }))!;
      await expect(lease.executor!.writeFile("never.txt", "x")).rejects.toThrow(/^skills_install_failed: Skill Install failed at switch: No space left on device\. The tool was not executed\.$/);
      expect(failed).toEqual([expect.any(SkillInstallError)]);
      expect(h.client.workspaceContents(`${TENANT}/ws_1/`).has("never.txt")).toBe(false);
    });

    it("sends the Sandbox nothing for an attempt that no longer owns its Turn", async () => {
      const h = await setup();
      const session = await h.session();
      const lost = new Error("claim lost");
      const lease = (await h.acquire(session, await h.claim(session), { assertOwner: async () => { throw lost; } }))!;
      await expect(lease.executor!.writeFile("never.txt", "x")).rejects.toBe(lost);
      const commands = vi.spyOn(h.client, "exec");
      await expect((async () => { for await (const _ of lease.executor!.exec(["true"])) { /* nothing runs */ } })()).rejects.toBe(lost);
      expect(commands).not.toHaveBeenCalled();
      expect(h.client.created).toEqual([]);
    });

    it("releases the use of a Turn whose admission failed before rejecting", async () => {
      const h = await setup();
      vi.spyOn(h.manager, "beginActivity").mockRejectedValue(new Error("Sandbox termination cleanup is still pending; retry later"));
      const session = await h.session();
      await expect(h.acquire(session, await h.claim(session))).rejects.toThrow("cleanup is still pending");
      expect(h.open).not.toHaveBeenCalled();
      expect(await h.users(session.id)).toBe(false);
    });

    it("finishes an admitted activity on settled release, and only once the runtime's exit is observed", async () => {
      const h = await setup();
      const { begin, finish } = trackActivity(h.manager);
      const session = await h.session();
      const signal = new AbortController().signal;
      const settledFence = await h.claim(session);
      const settled = (await h.acquire(session, settledFence, { signal }))!;
      expect(begin).toHaveBeenCalledExactlyOnceWith({ bindingId: session.id, sessionId: session.id, fence: settledFence }, signal);
      await h.ack(session, settledFence);
      await settled.release({ settled: true });
      expect(finish).toHaveBeenCalledExactlyOnceWith({ bindingId: session.id, sessionId: session.id, fence: settledFence });

      // An expired lease or a bounded Interrupt wait: the runtime may still run.
      let exit!: () => void;
      const runtime = new Promise<void>((resolve) => { exit = resolve; });
      const watchedFence = await h.claim(session);
      const watched = (await h.acquire(session, watchedFence))!;
      await h.ack(session, watchedFence);
      await watched.release({ settled: false, settles: runtime });
      expect(finish).toHaveBeenCalledTimes(1);
      exit();
      await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(2));
      expect(finish.mock.calls[1][0].fence).toEqual(watchedFence);

      // Detached at the handoff deadline: not watched, the next owner's admission supersedes it.
      const detachedFence = await h.claim(session);
      await (await h.acquire(session, detachedFence))!.release({ settled: false });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(finish).toHaveBeenCalledTimes(2);
      expect(h.errors).toEqual([]);
    });

    it("never finishes the activity of a Turn whose Sandbox command ended without exit evidence", async () => {
      const h = await setup();
      const { finish } = trackActivity(h.manager);
      const session = await h.session();
      const fence = await h.claim(session);
      const lease = (await h.acquire(session, fence))!;
      await lease.executor!.writeFile("saved.txt", "x");
      vi.spyOn(h.client, "hasUncertainExecution").mockReturnValue(true);
      await h.ack(session, fence);
      await lease.release({ settled: true });
      // Nor once a watched runtime ends: its command's outcome is still unknown.
      const watchedFence = await h.claim(session);
      const watched = (await h.acquire(session, watchedFence))!;
      await watched.executor!.writeFile("saved.txt", "y");
      await h.ack(session, watchedFence);
      await watched.release({ settled: false, settles: Promise.resolve() });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(finish).not.toHaveBeenCalled();
    });

    it.skipIf(options.lifecycle)("finishes no activity for a Turn no lifecycle admitted, settled or watched", async () => {
      const h = await setup();
      const finish = vi.spyOn(h.manager, "finishActivity");
      const session = await h.session();
      const settledFence = await h.claim(session);
      const settled = (await h.acquire(session, settledFence))!;
      await h.ack(session, settledFence);
      await settled.release({ settled: true });
      const watchedFence = await h.claim(session);
      const watched = (await h.acquire(session, watchedFence))!;
      await h.ack(session, watchedFence);
      await watched.release({ settled: false, settles: Promise.resolve() });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(finish).not.toHaveBeenCalled();
    });

    it("retries recording an observed settlement that failed, for its own Session only", async () => {
      const h = await setup();
      const { finish } = trackActivity(h.manager);
      finish.mockRejectedValueOnce(new Error("temporary PG outage")).mockRejectedValueOnce(new Error("still down"));
      const session = await h.session();
      const other = await h.session();
      const fence = await h.claim(session);
      const lease = (await h.acquire(session, fence))!;
      await h.ack(session, fence);
      await expect(lease.release({ settled: true })).rejects.toThrow("temporary PG outage");
      await h.sandboxes.retrySettlements(other.id);
      expect(finish).toHaveBeenCalledTimes(1);
      // A retry that fails again is reported, not thrown, and stays to be retried.
      await h.sandboxes.retrySettlements(session.id);
      expect(h.errors).toEqual([{ sessionId: session.id, error: new Error("still down") }]);
      await h.sandboxes.retrySettlements();
      expect(finish).toHaveBeenCalledTimes(3);
      expect(finish.mock.calls.map(([activity]) => activity)).toEqual(Array(3).fill({ bindingId: session.id, sessionId: session.id, fence }));
      await h.sandboxes.retrySettlements();
      expect(finish).toHaveBeenCalledTimes(3);
    });

    it("reports a watched runtime's settlement that could not be recorded, and retries it", async () => {
      const h = await setup();
      const { finish } = trackActivity(h.manager);
      finish.mockRejectedValueOnce(new Error("temporary PG outage"));
      const session = await h.session();
      const lease = (await h.acquire(session, await h.claim(session)))!;
      await lease.release({ settled: false, settles: Promise.resolve() });
      await vi.waitFor(() => expect(h.errors).toEqual([{ sessionId: session.id, error: new Error("temporary PG outage") }]));
      await h.sandboxes.retrySettlements(session.id);
      expect(finish).toHaveBeenCalledTimes(2);
    });

    it("builds the Sandbox from the Session's Workspace and the Agent's image and env, under deployment policy", async () => {
      const h = await setup({
        defaultSandboxEnv: { VFS_TOKEN: "default", SHARED: "yes" },
        managedSandboxEnvByAgentId: { [agent.id]: { OPENGROVE_WW_ACCESS_TOKEN: "managed" }, agent_other: { OTHER: "no" } },
      });
      const session = await h.session({ sandbox: { enabled: true, image: "custom:1", env: { VFS_TOKEN: "agent", OPENGROVE_WW_ACCESS_TOKEN: "agent", OWN: "1" } } });
      await h.turn(session, (executor) => executor!.writeFile("saved.txt", "x"));
      const created = h.client.createOptsOf(h.client.created[0]);
      expect(created.image).toBe("custom:1");
      expect(created.env).toMatchObject({ VFS_TOKEN: "agent", SHARED: "yes", OWN: "1", OPENGROVE_WW_ACCESS_TOKEN: "managed", HOME: "/home/user" });
      expect(created.env).not.toHaveProperty("OTHER");
      expect(h.client.workspaceContents(`${TENANT}/ws_1/`).get("saved.txt")?.content).toBe("x");
    });

    it("reclaims a terminated Session's Sandbox once no other Session uses its binding", async () => {
      const h = await setup();
      const parent = await h.session();
      const child = await h.session({}, parent);
      await h.turn(parent, (executor) => executor!.writeFile("saved.txt", "kept"));
      const [id] = h.client.created;
      const extra = await claimedFor(h, parent.id);
      const fence = await h.claim(child);
      const childLease = (await h.acquire(child, fence))!;
      await h.stores.sessionStore.terminate(parent.id);
      expect(await h.sandboxes.reclaim(parent)).toBe(false);
      expect(h.client.destroyed).toEqual([]);
      await h.ack(child, fence);
      await childLease.release({ settled: true });
      // A failed kill rejects; the others are attempted, and the retry finishes.
      vi.spyOn(h.client, "destroy").mockRejectedValueOnce(new Error("temporary gateway failure"));
      await expect(h.sandboxes.reclaim(parent)).rejects.toThrow("temporary gateway failure");
      expect(h.client.destroyed).toEqual([extra]);
      expect(await h.sandboxes.reclaim(parent)).toBe(true);
      expect(h.client.destroyed).toEqual([extra, id]);
      expect(h.client.workspaceContents(`${TENANT}/ws_1/`).get("saved.txt")?.content).toBe("kept");
    });

    it("kills the recorded Sandbox and every other one the gateway lists for a terminated Session's binding, and no other binding's", async () => {
      const h = await setup();
      const session = await h.session();
      const other = await h.session();
      await h.turn(session, (executor) => executor!.writeFile("saved.txt", "kept"));
      await h.turn(other, (executor) => executor!.writeFile("other.txt", "theirs"));
      const [recorded, othersSandbox] = h.client.created;
      // Left by lost creates: claimed for the binding, recorded by none.
      const extra = await claimedFor(h, session.id);
      const pausedExtra = await claimedFor(h, session.id);
      h.client.pause(pausedExtra);
      const othersExtra = await claimedFor(h, other.id);
      const list = vi.spyOn(h.client, "listSandboxes");
      await h.stores.sessionStore.terminate(session.id);
      expect(await h.sandboxes.reclaim(session)).toBe(true);
      expect(h.client.destroyed).toEqual([recorded, extra, pausedExtra]);
      expect(list).toHaveBeenCalledExactlyOnceWith({ metadata: { "oma.dev/binding": session.id }, states: ["running", "paused"] });
      expect((await list.mock.results[0].value).map(({ sandboxId }: { sandboxId: string }) => sandboxId)).toEqual([extra, pausedExtra]);
      expect(await h.client.state(othersExtra)).toBe("running");
      expect(await h.stores.delegationStore.withEnvironmentLock(session.id, async ({ sandboxId, creatingSince }) => ({ value: { sandboxId, creatingSince } })))
        .toEqual({ sandboxId: null, creatingSince: null });
      // The other Session goes on in its own Sandbox.
      expect(await h.turn(other, (executor) => executor!.readFile("other.txt"))).toBe("theirs");
      expect(h.client.created).toEqual([recorded, othersSandbox, extra, pausedExtra, othersExtra]);
    });

    it.skipIf(!options.lifecycle)("kills nothing while input is queued for a Child Session of the binding", async () => {
      const h = await setup();
      const parent = await h.session();
      const child = await h.session({}, parent);
      await h.turn(parent, (executor) => executor!.writeFile("saved.txt", "kept"));
      const [id] = h.client.created;
      const extra = await claimedFor(h, parent.id);
      await h.stores.pendingEventStore.enqueue(child.id, { type: "delegation_input", data: {}, sessionThreadId: "sthr_primary" });
      await h.stores.sessionStore.terminate(parent.id);
      expect(await h.sandboxes.reclaim(parent)).toBe(false);
      expect(h.client.destroyed).toEqual([]);
      await h.stores.pendingEventStore.clear(child.id);
      expect(await h.sandboxes.reclaim(parent)).toBe(true);
      expect(h.client.destroyed).toEqual([id, extra]);
    });

    it.skipIf(!options.lifecycle)("shortens an admitted Turn's Sandbox deadline after its settled release, never before observed exit", async () => {
      const h = await setup();
      const session = await h.session();
      const fence = await h.claim(session);
      const lease = (await h.acquire(session, fence))!;
      await lease.executor!.writeFile("saved.txt", "x");
      const [id] = h.client.created;
      let exit!: () => void;
      await h.ack(session, fence);
      await lease.release({ settled: false, settles: new Promise<void>((resolve) => { exit = resolve; }) });
      expect(h.client.deadlines.filter((deadline) => deadline.seconds === SANDBOX_IDLE_SECONDS)).toEqual([]);
      exit();
      await vi.waitFor(() => expect(h.client.deadlines).toContainEqual({ id, seconds: SANDBOX_IDLE_SECONDS }));
    });
  });
}
