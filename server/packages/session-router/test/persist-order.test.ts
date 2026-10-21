import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import type { Adapter, SessionEvent } from "@open-managed-agents/adapter-core";
import { SessionRouter } from "../src/session-router.js";

const event = (type: string, data: object = {}) => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("SessionRouter complete-event publication", () => {
  it("publishes commit-barrier and iterator writes in seq order", async () => {
    const stores = createMemoryStores();
    const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test", runtime: "pi-agent", sandbox: { enabled: false } });
    const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
    const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
    // A slow barrier commit returns after its seq is allocated, as PG would.
    const append = stores.eventLogStore.append.bind(stores.eventLogStore);
    stores.eventLogStore.append = async (sessionId, input) => {
      const stored = await append(sessionId, input);
      if (input.type === "agent.context_entry") await sleep(30);
      return stored;
    };
    const hub = new InProcessEventStreamHub();
    const published: number[] = [];
    const publish = hub.publish.bind(hub);
    hub.publish = (sessionId, stored) => { published.push(stored.seq); publish(sessionId, stored); };
    const entry = event("agent.context_entry", { sdk: "pi@0.83.0",
      entry: { id: "assistant1", type: "message", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
      presentation: { version: 1, blocks: [{ type: "agent.message", index: 0 }] } });
    const adapter: Adapter = { async *run(input) {
      const barrier = input.persistContext!([entry]);
      yield event("span.model_request_end", { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
      await barrier;
      yield entry;
    } };
    const router = new SessionRouter({ ...stores, eventStreamHub: hub, resolveAdapter: () => adapter });
    await stores.pendingEventStore.enqueue(session.id, { type: "user.message", data: { content: [{ type: "text", text: "go" }] }, sessionThreadId: "sthr_primary" });
    await router.handleNewEvent(session.id, agent);

    const types = (await stores.eventLogStore.getEvents(session.id, { limit: 100 })).data.map(stored => stored.type);
    expect(types).toEqual(expect.arrayContaining(["agent.context_entry", "span.model_request_end", "session.turn_completed"]));
    expect(types).not.toContain("session.error");
    // SSE drops a seq at or below its cursor, so first publications must ascend.
    const first = published.filter((seq, index) => published.indexOf(seq) === index);
    expect(first.length).toBeGreaterThan(3);
    expect(first).toEqual([...first].sort((a, b) => a - b));
  });
});
