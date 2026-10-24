import { describe, expect, it } from "vitest";
import { createMemoryStores, type MemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { DefaultTurnSandboxes, SandboxUnavailable, SkillInstallError, type SandboxManager, type SandboxSession } from "@oma-server/sandbox";
import type { Adapter } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter, type SessionRouterDeps } from "../src/session-router.js";

const answers: Adapter = { async run(input) {
  await journalWriter(input)({ id: "answer", timestamp: new Date().toISOString(), type: "agent.message", content: [{ type: "text", text: "done" }] });
  return "finished";
} };
/** Reads a file through the Turn's executor, then answers: a read that fails is a tool error. */
const readsThenAnswers: Adapter = { async run(input) {
  await input.toolExecutor!.readFile("note.txt").catch(() => {});
  return answers.run(input);
} };

/** A Sandbox that runs nothing; `fail` names the step that fails. */
function sandbox(fail: "connect" | "install" | "checkWorkspace"): SandboxManager {
  const unreachable = new SandboxUnavailable("unreachable");
  const session: SandboxSession = {
    fileSystem: {} as SandboxSession["fileSystem"],
    async *exec() { /* runs nothing */ },
    // An operation that waited for the failed connect fails with it.
    readFile: async () => { if (fail === "connect") throw unreachable; return ""; },
    writeFile: async () => {}, list: async () => [],
    prepare: async (skills, options) => {
      if (fail === "connect") {
        options?.sandboxPrepares?.started();
        options?.sandboxPrepares?.ended({ outcome: "failed", error: unreachable });
        throw unreachable;
      }
      if (fail === "install") {
        options?.skillInstalls?.started(skills!);
        options?.skillInstalls?.ended({ error: new SkillInstallError("download", "HTTP 403, curl exit 0 for bundle 0123456789ab") });
      }
    },
    checkWorkspace: async () => { if (fail === "checkWorkspace") throw new Error("mount gone"); },
  };
  return { open: () => session, list: async () => [], reclaim: async () => true };
}

const workspaceMount = { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" };
/** The Turn Sandboxes over a failing Sandbox and the test's stores. */
const sandboxes = (fail: Parameters<typeof sandbox>[0]) => (stores: MemoryStores): Partial<SessionRouterDeps> => ({
  sandboxes: new DefaultTurnSandboxes({ manager: sandbox(fail), bindings: stores.delegationStore, sessions: stores.sessionStore, workspaceMount }),
});

describe("Errors the Router writes", () => {
  it.each<[code: string, sandboxed: boolean, deps: (stores: MemoryStores) => Partial<SessionRouterDeps>]>([
    ["unsupported_runtime", false, () => ({ resolveAdapter: () => undefined })],
    ["adapter_error", false, () => ({ resolveAdapter: () => ({ async run() { throw new Error("runtime crashed"); } }) })],
    ["sandbox_unavailable", true, () => ({})],
    ["sandbox_unavailable", true, (stores) => ({ ...sandboxes("connect")(stores), resolveAdapter: () => readsThenAnswers })],
    ["skills_install_failed", true, sandboxes("install")],
    ["workspace_storage_error", true, sandboxes("checkWorkspace")],
  ])("%s names the Turn it is written in", async (code, sandboxed, deps) => {
    const stores = createMemoryStores();
    const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test",
      runtime: "pi-agent", sandbox: { enabled: sandboxed } });
    const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
    const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
    const errors: unknown[] = [];
    const router = new SessionRouter({ ...stores, eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => answers,
      onDrainError: ({ error }) => errors.push(error), ...deps(stores) });
    await stores.pendingEventStore.enqueue(session.id, { type: "user.message",
      data: { content: [{ type: "text", text: "go" }] }, sessionThreadId: "sthr_primary" });

    await router.handleNewEvent(session.id, agent);

    const log = (await stores.eventLogStore.getEvents(session.id, { limit: 100 })).data;
    expect(log.filter((stored) => stored.type === "session.error").map((stored) => stored.data))
      .toEqual([{ turnId: "turn_1_a1", error: expect.objectContaining({ code }) }]);
    expect(log.filter((stored) => stored.type === "session.turn_completed").map((stored) => stored.data))
      .toEqual([expect.objectContaining({ turnId: "turn_1_a1" })]);
    // A Turn's events, Router errors included, are what a turnId-scoped read returns.
    expect((await stores.eventLogStore.getEvents(session.id, { turnId: "turn_1_a1", limit: 100 })).data.map((stored) => stored.type))
      .toContain("session.error");
    expect(errors).toEqual([]);
  });
});
