import { describe, expect, it } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import type { SandboxManager, SandboxSession } from "@oma-server/sandbox";
import type { Adapter } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter, type SessionRouterDeps } from "../src/session-router.js";

const answers: Adapter = { async run(input) {
  await journalWriter(input)({ id: "answer", timestamp: new Date().toISOString(), type: "agent.message", content: [{ type: "text", text: "done" }] });
  return "finished";
} };

/** A Sandbox that runs nothing; `fail` names the step that throws. */
function sandbox(fail: "prepare" | "checkWorkspace"): SandboxManager {
  const session: SandboxSession = {
    async *exec() { /* runs nothing */ },
    readFile: async () => "", writeFile: async () => {}, list: async () => [],
    prepare: async () => { if (fail === "prepare") throw new Error("mount refused"); },
    checkWorkspace: async () => { if (fail === "checkWorkspace") throw new Error("mount gone"); },
    dispose: async () => {},
  };
  return { open: () => session, list: async () => [], reclaim: async () => {} };
}

const workspaceMount = { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" };

describe("Errors the Router writes", () => {
  it.each<[code: string, sandboxed: boolean, deps: Partial<SessionRouterDeps>]>([
    ["unsupported_runtime", false, { resolveAdapter: () => undefined }],
    ["adapter_error", false, { resolveAdapter: () => ({ async run() { throw new Error("runtime crashed"); } }) }],
    ["sandbox_unavailable", true, {}],
    ["sandbox_prepare_failed", true, { sandboxManager: sandbox("prepare"), workspaceMount }],
    ["workspace_storage_error", true, { sandboxManager: sandbox("checkWorkspace"), workspaceMount }],
  ])("%s names the Turn it is written in", async (code, sandboxed, deps) => {
    const stores = createMemoryStores();
    const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test",
      runtime: "pi-agent", sandbox: { enabled: sandboxed } });
    const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
    const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
    const errors: unknown[] = [];
    const router = new SessionRouter({ ...stores, eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => answers,
      onDrainError: ({ error }) => errors.push(error), ...deps });
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
