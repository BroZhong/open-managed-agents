import { afterEach, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { createApp } from "../src/app.js";

afterEach(() => vi.unstubAllEnvs());

it("an open SSE connection catches committed output when notification is lost", async () => {
  vi.stubEnv("AUTH_DISABLED", "true");
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "dev", name: "test", runtime: "mock", model: "mock-model", system: "Test Agent" });
  const workspace = await stores.workspaceStore.create({ tenantId: "dev" });
  const session = await stores.sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: workspace.id });
  const hub = new InProcessEventStreamHub();
  const app = createApp({ ...stores, eventStreamHub: hub, sseCatchupIntervalMs: 20 });
  const response = await app.request(`/v1/sessions/${session.id}/events?replay=1`, { headers: { accept: "text/event-stream" } });
  const reader = response.body!.getReader();
  const frames: string[] = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      frames.push(decoder.decode(value));
    }
  })();
  try {
    const message = await stores.eventLogStore.append(session.id, { type: "agent.message", data: { content: [{ type: "text", text: "durable answer" }] }, sessionThreadId: "sthr_primary" });
    await stores.eventLogStore.append(session.id, { type: "session.turn_completed", data: { turnId: "turn_1" }, sessionThreadId: "sthr_primary" });
    await vi.waitFor(() => expect(frames.join("")).toContain("session.turn_completed"), { timeout: 1000 });
    // Delayed duplicate notification after catch-up cannot render the answer again.
    hub.publish(session.id, message);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(frames.join("").match(/durable answer/g)).toHaveLength(1);
  } finally {
    await reader.cancel();
    await reading;
  }
});
