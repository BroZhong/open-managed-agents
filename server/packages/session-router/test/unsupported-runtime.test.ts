import { describe, expect, it } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import type { Runtime } from "@oma-server/store";
import type { Adapter, SessionEvent } from "@open-managed-agents/adapter-core";
import { SessionRouter } from "../src/session-router.js";

// Agents created before claude-code and codex were removed keep that runtime;
// they are not migrated, so the store can still return it.
const retiredRuntime: string = "codex";

describe("Agents with an unsupported runtime", () => {
  it("end their Turn with unsupported_runtime and acknowledge the input without affecting other Sessions", async () => {
    const stores = createMemoryStores();
    let mockRuns = 0;
    const mock: Adapter = {
      async *run(): AsyncIterable<SessionEvent> {
        mockRuns += 1;
        yield { id: "evt_reply", timestamp: new Date().toISOString(), type: "agent.message",
          content: [{ type: "text", text: "still running" }] };
      },
    };
    const router = new SessionRouter({ ...stores, eventStreamHub: new InProcessEventStreamHub(),
      resolveAdapter: runtime => runtime === "mock" ? mock : undefined, pendingClaimRetryMinMs: 10 });
    const createSession = async (runtime: Runtime) => {
      const agent = await stores.agentStore.create({ tenantId: "t", name: runtime, model: "m", system: "s",
        runtime, sandbox: { enabled: false } });
      const session = await stores.sessionStore.create({ tenantId: "t", agentId: agent.id, agent, workspaceId: "ws" });
      await stores.pendingEventStore.enqueue(session.id, { type: "user.message",
        data: { content: [{ type: "text", text: "hi" }] }, sessionThreadId: "sthr_primary" });
      return session;
    };
    const retired = await createSession(retiredRuntime as Runtime);
    const healthy = await createSession("mock");

    await Promise.all([
      router.handleNewEvent(retired.id, retired.agent),
      router.handleNewEvent(healthy.id, healthy.agent),
    ]);

    const retiredEvents = (await stores.eventLogStore.getEvents(retired.id)).data;
    expect(retiredEvents.map(event => event.type)).toEqual([
      "user.message", "session.status_running", "session.error", "session.turn_completed", "session.status_idle",
    ]);
    expect(retiredEvents[2]?.data).toEqual({ error: {
      code: "unsupported_runtime", message: 'Agent runtime "codex" is not supported',
    } });
    expect(await stores.pendingEventStore.count(retired.id)).toBe(0);
    expect((await stores.sessionStore.getById(retired.id))?.status).toBe("idle");

    const healthyEvents = (await stores.eventLogStore.getEvents(healthy.id)).data;
    expect(healthyEvents.map(event => event.type)).toContain("agent.message");
    expect(mockRuns).toBe(1);
    expect((await stores.sessionStore.getById(healthy.id))?.status).toBe("idle");

    // Nothing is left for a claim retry or a recovery scan to pick up again.
    expect(await router.waitForIdle(0)).toBe(true);
    expect((await router.recoverPendingEvents()).recovered).toEqual([]);
  });
});
