import { afterEach, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { SessionRouter } from "@oma-server/session-router";
import { MockAdapter } from "@open-managed-agents/adapter-mock";
import { createApp } from "../src/app.js";
import { runtimeAdapters } from "../src/lib/runtime-adapters.js";

afterEach(() => vi.unstubAllEnvs());

interface Frame { seq?: number; type: string; data: Record<string, unknown> }

/** Every SSE frame the response carries, parsed; a durable frame has a seq. */
function collectFrames(response: Response): { frames: Frame[]; stop(): Promise<void> } {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = "";
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const fields = Object.fromEntries(buffer.slice(0, end).split("\n")
          .map(line => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
        buffer = buffer.slice(end + 2);
        if (fields.event) frames.push({ type: fields.event, data: JSON.parse(fields.data), ...(fields.id ? { seq: Number(fields.id) } : {}) });
      }
    }
  })();
  return { frames, stop: async () => { await reader.cancel(); await reading; } };
}

it("streams the mock runtime's Deltas on the block of the Complete Event that replaces them", async () => {
  vi.stubEnv("AUTH_DISABLED", "true");
  // Wired as the memory dev server wires the mock runtime.
  const stores = createMemoryStores();
  const eventStreamHub = new InProcessEventStreamHub();
  const sessionRouter = new SessionRouter({ ...stores, eventStreamHub,
    resolveAdapter: runtimeAdapters({ mock: new MockAdapter({ delayMs: 5 }) }) });
  const app = createApp({ ...stores, eventStreamHub, sessionRouter });
  const json = (body: object) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const created = await app.request("/v1/agents", json({ name: "Echo", model: "mock-model", system: "Echo.", runtime: "mock", sandbox: { enabled: false } }));
  expect(created.status).toBe(201);
  const agent = await created.json();
  const opened = await app.request("/v1/sessions", json({ agent: agent.id }));
  expect(opened.status).toBe(201);
  const session = await opened.json();
  const stream = collectFrames(await app.request(`/v1/sessions/${session.id}/events?include=chunks`, { headers: { accept: "text/event-stream" } }));
  try {
    const sent = await app.request(`/v1/sessions/${session.id}/events`, json({ events: [{ type: "user.message", data: { content: [{ type: "text", text: "hi" }] } }] }));
    expect(sent.status).toBeLessThan(300);
    await vi.waitFor(() => expect(stream.frames.map(frame => frame.type)).toContain("session.status_idle"), { timeout: 2000 });
  } finally {
    await stream.stop();
  }

  const message = stream.frames.find(frame => frame.type === "agent.message")!;
  expect(message).toMatchObject({ seq: expect.any(Number), data: { content: [{ type: "text", text: "Hello, world!" }], blockIndex: 0 } });
  const turnId = message.data.turnId;
  expect(turnId).toEqual(expect.any(String));
  const deltas = stream.frames.filter(frame => frame.seq === undefined);
  expect(deltas.map(({ type, data }) => [type, data.turnId, data.blockIndex])).toEqual([
    ["agent.message_stream_start", turnId, 0],
    ["agent.message_chunk", turnId, 0],
    ["agent.message_chunk", turnId, 0],
    ["agent.message_chunk", turnId, 0],
    ["agent.message_stream_end", turnId, 0],
  ]);
  // Every Delta went out before the Complete Event that replaces it.
  expect(stream.frames.indexOf(message)).toBeGreaterThan(stream.frames.indexOf(deltas.at(-1)!));
});
