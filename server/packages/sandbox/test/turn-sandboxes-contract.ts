import { afterAll, describe, expect, it, vi } from "vitest";
import type { Agent, DelegationStore, PendingEventFence, PendingEventStore, SandboxLifecycleStore, Session, SessionStore } from "@oma-server/store";
import { CommandVariablesUnavailable, DefaultSandboxManager, SandboxUnavailable, type SandboxPrepareOutcome } from "../src/sandbox-manager.js";
import { FakeSandboxClient, type FakeSandboxClientOptions } from "../src/fake-sandbox-client.js";
import { EMPTY_SKILL_SET, SkillInstallError, skillSetOf, type SkillSet } from "../src/skill-install.js";
import { SANDBOX_IDLE_SECONDS } from "../src/sandbox-client.js";
import { DefaultTurnSandboxes, type SandboxEnvironments, type SandboxLeaseRequest, type TurnSandboxesDeps } from "../src/turn-sandboxes.js";
import { PLATFORM_DEFAULT_ENV } from "../src/environment-variables.js";
import { WORKSPACE_ENV } from "../src/workspace-environment.js";
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A promise and whether it has settled yet. */
function watch<T>(promise: Promise<T>) {
  const watched = { promise, settled: false };
  promise.then(() => { watched.settled = true; }, () => { watched.settled = true; });
  return watched;
}

const workspaceMount = { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" };
const agent: Agent = { id: "agent_sbx", tenantId: TENANT, name: "Sandboxed", model: "model", system: "", runtime: "pi-agent",
  sandbox: { enabled: true }, createdAt: new Date(), updatedAt: new Date() };

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

    async function setup(deps: Partial<TurnSandboxesDeps> = {}, gateway: FakeSandboxClientOptions = {}) {
      const stores = await createStores();
      const client = new FakeSandboxClient(gateway);
      const bundles = new Bundles();
      const manager = new DefaultSandboxManager({ sandboxClient: client, skillBundleStore: bundles, lifecycle: stores.lifecycle, environment: "test" });
      const open = vi.spyOn(manager, "open");
      const errors: Array<{ sessionId: string; error: unknown }> = [];
      const sandboxes = new DefaultTurnSandboxes({ manager, bindings: stores.delegationStore, sessions: stores.sessionStore,
        workspaceMount, onError: (failure) => errors.push(failure), ...deps });
      /** A Session; a Child of `parent` has its Environment, as the delegation store gives it. */
      const session = (overrides: Partial<Agent> = {}, parent?: Session, environmentId?: string) => stores.sessionStore.create({
        tenantId: TENANT, agentId: agent.id, agent: { ...agent, ...overrides }, workspaceId: "ws_1",
        environmentId: parent ? parent.environmentId : environmentId,
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
      /** What the binding records of its Sandbox (ADR-0024). */
      const origin = (bindingId: string) => stores.delegationStore.withBindingLock(bindingId,
        async ({ sandboxId, environmentId, image }) => ({ value: { sandboxId, environmentId, image } }));
      return { stores, client, bundles, manager, open, errors, sandboxes, session, claim, ack, acquire, turn, users, origin };
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

    it("acquires the lease without waiting for the Turn-start connect, which the first operation and the release wait for", async () => {
      const h = await setup();
      const { begin, finish } = trackActivity(h.manager);
      const session = await h.session();
      await h.turn(session, (executor) => executor!.writeFile("saved.txt", "x"));
      let connected!: () => void;
      const connecting = new Promise<void>((resolve) => { connected = resolve; });
      const reconnect = h.client.reconnect.bind(h.client);
      vi.spyOn(h.client, "reconnect").mockImplementation(async (id, metadata) => { await connecting; return reconnect(id, metadata); });
      const fence = await h.claim(session);
      const lease = (await h.acquire(session, fence))!;
      expect(begin).toHaveBeenCalledTimes(2);
      const read = watch(lease.executor.readFile("saved.txt"));
      await h.ack(session, fence);
      const released = watch(lease.release({ settled: true }));
      await sleep(20);
      expect(read.settled).toBe(false);
      expect(released.settled).toBe(false);
      expect(finish).toHaveBeenCalledTimes(1);
      connected();
      expect(await read.promise).toBe("x");
      await released.promise;
      expect(finish).toHaveBeenCalledTimes(2);
    });

    it("fails the operations that met a Sandbox unavailability with sandbox_unavailable, tells the Turn of the preparation and the operation, and prepares again on the next one", async () => {
      const h = await setup();
      const session = await h.session();
      await h.turn(session, (executor) => executor!.writeFile("saved.txt", "x"));
      const [id] = h.client.created;
      h.client.setMountFailure(id, "storage offline");
      const prepares: SandboxPrepareOutcome[] = [];
      // The Turn hears of each operation that met the failure, after the preparation that failed.
      const heard: string[] = [];
      const sandboxPrepares = { started: vi.fn(), ended: (outcome: SandboxPrepareOutcome) => { prepares.push(outcome); heard.push(`preparation ${outcome.outcome}`); } };
      const sandboxUnavailable = (error: SandboxUnavailable) => { heard.push(`operation failed: ${error.reason}`); };
      const fence = await h.claim(session);
      const lease = (await h.acquire(session, fence, { sandboxPrepares, sandboxUnavailable }))!;
      const failure = await lease.executor.readFile("saved.txt").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SandboxUnavailable);
      expect(failure).toMatchObject({ code: "sandbox_unavailable", reason: "mount", details: { reason: "mount" },
        message: new WorkspaceMountUnavailable().message });
      expect(prepares).toEqual([{ outcome: "failed", error: failure }]);
      expect(heard).toEqual(["preparation failed", "operation failed: mount"]);
      expect(await h.users(session.id)).toBe(true);
      h.client.setMountFailure(id);
      expect(await lease.executor.readFile("saved.txt")).toBe("x");
      expect(prepares).toEqual([{ outcome: "failed", error: failure }, { outcome: "ready", sandboxId: id }]);
      expect(heard).toEqual(["preparation failed", "operation failed: mount", "preparation ready"]);
      expect(sandboxPrepares.started).toHaveBeenCalledTimes(2);
      expect(h.client.created).toEqual([id]);
      await h.ack(session, fence);
      await lease.release({ settled: true });
      expect(await h.users(session.id)).toBe(false);
    });

    it("fails the Turn's operations with skills_install_failed when deciding its Skill Install failed, and tells the Turn of it as of a failed install", async () => {
      const h = await setup();
      const session = await h.session();
      await h.turn(session, (executor) => executor!.writeFile("saved.txt", "x"));
      vi.spyOn(h.stores.delegationStore, "installedSkillSet").mockRejectedValueOnce(new Error("connection reset"));
      const skills = skillSetOf([await h.bundles.add("writer", [text("SKILL.md", "v1")])]);
      const failed: SkillInstallError[] = [];
      const skillInstalls = { started: vi.fn(), ended: vi.fn() };
      const lease = (await h.acquire(session, await h.claim(session), { skills, skillInstalls, skillInstallFailed: (error) => failed.push(error) }))!;
      const message = "Skill Install failed at check: cannot read what the binding installed: connection reset";
      await expect(lease.executor.readFile("saved.txt")).rejects.toThrow(`skills_install_failed: ${message}. The tool was not executed.`);
      expect(failed).toEqual([expect.objectContaining({ stage: "check", message })]);
      expect(skillInstalls.started).toHaveBeenCalledExactlyOnceWith(skills);
      expect(skillInstalls.ended).toHaveBeenCalledExactlyOnceWith({ error: failed[0] });
      // Like a failed install, it fails each operation of the Turn.
      await expect(lease.executor.readFile("saved.txt")).rejects.toThrow(/^skills_install_failed: /);
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
      const binding = vi.spyOn(h.stores.delegationStore, "withBindingLock");
      await expect(h.acquire(session, await h.claim(session))).rejects.toThrow("cleanup is still pending");
      // Opened, which starts nothing, but never prepared.
      expect(binding).not.toHaveBeenCalled();
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

    describe("a Session in an Environment (ADR-0024)", () => {
      const digest = (n: number) => "registry.example/welltop/oma-environments@sha256:" + String(n).repeat(64);
      /**
       * The Environments as the Host resolves them: their serving images, read
       * when a Turn begins (a rebuild replaces one), and their resolved
       * variables, read for each command (an edit replaces them).
       */
      function served(images: Record<string, string | null>, variables: Record<string, Record<string, string>> = {}) {
        const reads: string[][] = [];
        const variableReads: string[] = [];
        const environments: SandboxEnvironments = {
          image: async (tenantId, id) => {
            reads.push([id]);
            return tenantId === TENANT && id in images ? images[id]! : null;
          },
          variables: async (tenantId, id) => {
            variableReads.push(id);
            return tenantId === TENANT ? { ...variables[id] } : {};
          },
        };
        return { images, variables, reads, variableReads, environments };
      }

      it("claims with the image its Environment serves when the Turn begins: a rebuild reaches new Sandboxes, a running one keeps its own", async () => {
        const store = served({ env_video: digest(2) });
        const h = await setup({ environments: store.environments });
        const prepares: SandboxPrepareOutcome[] = [];
        const sandboxPrepares = { started: () => {}, ended: (outcome: SandboxPrepareOutcome) => { prepares.push(outcome); } };
        const first = await h.session({}, undefined, "env_video");
        await h.turn(first, (executor) => executor!.writeFile("a.txt", "1"), { sandboxPrepares });
        const [original] = h.client.created;
        expect(h.client.createOptsOf(original).image).toBe(digest(2));
        expect(await h.origin(first.id)).toEqual({ sandboxId: original, environmentId: "env_video", image: digest(2) });
        // The claim the preparation reports, for span.sandbox_prepare_end, names the Environment.
        expect(prepares.filter((outcome) => outcome.outcome === "ready")).toEqual([
          { outcome: "ready", sandboxId: original, claim: { environmentId: "env_video", image: digest(2), claimMs: expect.any(Number) } },
        ]);

        // A rebuild succeeds: the running Sandbox keeps its image, and its Child shares it.
        store.images.env_video = digest(3);
        expect(await h.turn(first, (executor) => executor!.readFile("a.txt"))).toBe("1");
        const child = await h.session({}, first);
        expect(await h.turn(child, (executor) => executor!.readFile("a.txt"))).toBe("1");
        expect(h.client.created).toEqual([original]);
        expect(await h.origin(first.id)).toEqual({ sandboxId: original, environmentId: "env_video", image: digest(2) });

        // A new Session's Sandbox runs the new image.
        const second = await h.session({}, undefined, "env_video");
        await h.turn(second, (executor) => executor!.writeFile("b.txt", "2"));
        expect(h.client.createOptsOf(h.client.created[1]).image).toBe(digest(3));
        expect(await h.origin(second.id)).toEqual({ sandboxId: h.client.created[1], environmentId: "env_video", image: digest(3) });

        // Once the old Sandbox is gone, the first Session's next one runs the new image too.
        h.client.reclaim(original);
        await h.turn(first, (executor) => executor!.writeFile("c.txt", "3"));
        expect(h.client.created).toHaveLength(3);
        expect(h.client.createOptsOf(h.client.created[2]).image).toBe(digest(3));
        expect(await h.origin(first.id)).toEqual({ sandboxId: h.client.created[2], environmentId: "env_video", image: digest(3) });
        expect(store.reads.every((ids) => ids.length === 1 && ids[0] === "env_video")).toBe(true);
      });

      it("claims with no image for a Session whose Environment serves none, and reads none without one", async () => {
        const store = served({ env_unbuilt: null });
        const h = await setup({ environments: store.environments });
        for (const environmentId of ["env_unbuilt", "env_unknown"]) {
          const session = await h.session({}, undefined, environmentId);
          await h.turn(session, (executor) => executor!.writeFile("x.txt", "x"));
        }
        // The gateway rejects a create without an image (ADR-0024); the fake records the request.
        expect(h.client.created.map((id) => h.client.createOptsOf(id).image)).toEqual([undefined, undefined]);
        // A Session of an Agent without an Environment (one that ran without a Sandbox) reads none.
        const plain = await h.session({ environmentId: undefined });
        await h.turn(plain, async () => {});
        expect(store.reads).toEqual([["env_unbuilt"], ["env_unknown"]]);
        // An opted-out Agent reads nothing either.
        const optedOut = await h.session({ sandbox: { enabled: false } }, undefined, "env_unbuilt");
        expect(await h.acquire(optedOut, await h.claim(optedOut))).toBeNull();
        expect(store.reads).toHaveLength(2);
      });

      /** What `printenv` prints of `names` in the Turn's Sandbox, one value per line. */
      const printenv = async (executor: { exec(command: string[]): AsyncIterable<{ text: string }> }, ...names: string[]) => {
        let out = "";
        for await (const chunk of executor.exec(["printenv", ...names])) out += chunk.text;
        return out.split("\n").slice(0, -1);
      };
      const CANARY = "sk-canary-" + "9f3c".repeat(8);

      it("runs every command with the platform defaults < the Environment's variables < the Workspace variables, and creates the Sandbox with neither", async () => {
        const store = served({ env_vars: digest(2) }, {
          env_vars: { PIP_INDEX_URL: "https://pypi.example/simple", API_TOKEN: CANARY, HOME: "/elsewhere" },
        });
        const h = await setup({ environments: store.environments });
        const session = await h.session({}, undefined, "env_vars");
        const seen = await h.turn(session, (executor) => printenv(executor!, "PIP_INDEX_URL", "NPM_CONFIG_REGISTRY", "API_TOKEN", "HOME", "WORKSPACE_DIR"));
        expect(seen).toEqual(["https://pypi.example/simple", PLATFORM_DEFAULT_ENV.NPM_CONFIG_REGISTRY, CANARY, WORKSPACE_ENV.HOME, WORKSPACE_ENV.WORKSPACE_DIR]);
        // The creation, and so the Sandbox CR, carries the Workspace paths and nothing of the Environment's.
        const created = h.client.createOptsOf(h.client.created[0]);
        expect(created.env).toEqual(WORKSPACE_ENV);
        expect(JSON.stringify(created)).not.toContain(CANARY);
        expect(store.variableReads).toEqual(["env_vars"]);
      });

      it("applies a changed variable from the next command of a running Sandbox", async () => {
        const store = served({ env_vars: digest(2) }, { env_vars: { MODE: "first" } });
        const h = await setup({ environments: store.environments });
        const session = await h.session({}, undefined, "env_vars");
        const fence = await h.claim(session);
        const lease = (await h.acquire(session, fence))!;
        expect(await printenv(lease.executor!, "MODE")).toEqual(["first"]);
        store.variables.env_vars = { MODE: "second" };
        expect(await printenv(lease.executor!, "MODE")).toEqual(["second"]);
        delete store.variables.env_vars;
        expect(await printenv(lease.executor!, "MODE")).toEqual([]);
        expect(h.client.created).toHaveLength(1);
        await h.ack(session, fence);
        await lease.release({ settled: true });
      });

      it("keeps injected values over the image's profile defaults, which apply to names it does not inject", async () => {
        const store = served({ env_vars: digest(2) }, { env_vars: { REGION: "from-environment" } });
        // The init script wrote `export REGION="${REGION:-image-default}"` and `export TOOL_HOME="${TOOL_HOME:-/opt/tool}"`.
        const h = await setup({ environments: store.environments },
          { profile: { REGION: "image-default", TOOL_HOME: "/opt/tool" } });
        const session = await h.session({}, undefined, "env_vars");
        expect(await h.turn(session, (executor) => printenv(executor!, "REGION", "TOOL_HOME"))).toEqual(["from-environment", "/opt/tool"]);
      });

      it("runs Host-internal commands without the Environment's variables, and fails a command whose variables cannot be read without running it", async () => {
        const store = served({ env_vars: digest(2) }, { env_vars: { API_TOKEN: CANARY } });
        const h = await setup({ environments: store.environments });
        const session = await h.session({}, undefined, "env_vars");
        const skills = skillSetOf([await h.bundles.add("reviewer", [text("SKILL.md", "Review")])]);
        await h.turn(session, async (executor) => { await executor!.writeFile("x.txt", "x"); await printenv(executor!, "API_TOKEN"); }, { skills });
        const install = h.client.execs.filter((run) => run.user === "root");
        expect(install).not.toHaveLength(0);
        expect(JSON.stringify(install)).not.toContain(CANARY);
        expect(h.client.execs.filter((run) => JSON.stringify(run).includes(CANARY)).map((run) => run.command)).toEqual([["printenv", "API_TOKEN"]]);
        // A command never carries its variables in argv.
        expect(h.client.execs.every((run) => !run.command.join(" ").includes(CANARY))).toBe(true);

        const failing = served({ env_vars: digest(2) });
        failing.environments.variables = async () => { throw new Error(`database said ${CANARY}`); };
        const g = await setup({ environments: failing.environments });
        const other = await g.session({}, undefined, "env_vars");
        const fence = await g.claim(other);
        const lease = (await g.acquire(other, fence))!;
        const failure = await printenv(lease.executor!, "API_TOKEN").catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(CommandVariablesUnavailable);
        expect(String((failure as Error).message)).not.toContain(CANARY);
        expect(g.client.execs.filter((run) => run.command[0] === "printenv")).toEqual([]);
        await g.ack(other, fence);
        await lease.release({ settled: true });
      });

      it("runs a Session that froze no Environment, created while its Agent ran without a Sandbox, in its Agent's now", async () => {
        const store = served({ env_vars: digest(2) }, { env_vars: { MODE: "agent's" } });
        const h = await setup({ environments: store.environments });
        const session = await h.session({ environmentId: "env_vars" });
        expect(await h.turn(session, (executor) => printenv(executor!, "MODE"))).toEqual(["agent's"]);
        expect(h.client.createOptsOf(h.client.created[0]).image).toBe(digest(2));
        expect(await h.origin(session.id)).toMatchObject({ environmentId: "env_vars", image: digest(2) });
      });
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
      expect(await h.stores.delegationStore.withBindingLock(session.id, async ({ sandboxId, creatingSince }) => ({ value: { sandboxId, creatingSince } })))
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
