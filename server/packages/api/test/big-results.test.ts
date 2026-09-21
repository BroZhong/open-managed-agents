import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { BIG_RESULT_BYTES } from "@oma-server/store";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { createApp } from "../src/app.js";

beforeEach(() => { vi.stubEnv("AUTH_DISABLED", "false"); });

async function setup() {
  const stores = createMemoryStores();
  const headers = { "x-api-key": (await stores.apiKeyStore.create("owner", "test")).rawKey };
  const agent = await stores.agentStore.create({ tenantId: "owner", name: "Agent", model: "mock", system: "", runtime: "mock" });
  const workspace = await stores.workspaceStore.create({ tenantId: "owner" });
  const session = await stores.sessionStore.create({ tenantId: "owner", agentId: agent.id, agent, workspaceId: workspace.id });
  const hub = new InProcessEventStreamHub();
  const app = createApp({ ...stores, eventStreamHub: hub });
  const data = { toolUseId: "call1", isError: true, content: [{ type: "text", text: "BIG_RESULT_".repeat(BIG_RESULT_BYTES) }] };
  const event = await stores.eventLogStore.append(session.id, { type: "agent.tool_result", data, sessionThreadId: "primary" });
  return { stores, headers, session, hub, app, data, event };
}

it("returns references in JSON, SSE replay and live SSE, and loads the exact result only at the detail endpoint", async () => {
  const { app, headers, session, data, event, hub } = await setup();
  const base = `/v1/sessions/${session.id}/events`;
  const history = await (await app.request(base, { headers })).text();
  expect(history).toContain('"payloadRef"');
  expect(history).not.toContain("BIG_RESULT_");
  expect(history.length).toBeLessThan(1000);
  const detail = await app.request(`${base}/${event.seq}/data`, { headers });
  expect(await detail.json()).toEqual({ data });
  expect(detail.headers.get("cache-control")).toBe("no-store");
  const response = await app.request(base, { headers: { ...headers, accept: "text/event-stream", "last-event-id": "0" } });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let replay = "";
  while (!replay.includes("payloadRef")) replay += decoder.decode((await reader.read()).value);
  expect(replay).not.toContain("BIG_RESULT_");
  hub.publish(session.id, { type: event.type, seq: event.seq + 1, data });
  const live = decoder.decode((await reader.read()).value);
  expect(live).toContain("payloadRef");
  expect(live).not.toContain("BIG_RESULT_");
  await reader.cancel();
});

it("scopes lazy reads to the owner or exact share and refuses reads after deletion", async () => {
  const { app, headers, session, stores, data } = await setup();
  const path = `/v1/sessions/${session.id}/events/1/data`;
  const other = { "x-api-key": (await stores.apiKeyStore.create("other", "test")).rawKey };
  expect((await app.request(path, { headers: other })).status).toBe(404);
  const share = await stores.sessionShareStore.getOrCreate(session.id);
  const access = { "x-session-share": share.id };
  expect(await (await app.request(path, { headers: access })).json()).toEqual({ data });
  expect((await app.request("/v1/sessions/unrelated/events/1/data", { headers: access })).status).toBe(403);
  expect((await app.request(`/v1/sessions/${session.id}/events/999/data`, { headers })).status).toBe(404);
  await stores.workspaceStore.softDelete("owner", session.workspaceId);
  expect((await app.request(path, { headers })).status).toBe(404);
  expect((await app.request(path, { headers: access })).status).toBe(404);
});

it("returns a retriable, sanitized error if result hydration fails", async () => {
  const { app, headers, session, stores } = await setup();
  vi.spyOn(stores.eventLogStore, "getEvents").mockRejectedValue(new Error("internal OSS secret detail"));
  const response = await app.request(`/v1/sessions/${session.id}/events/1/data`, { headers });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("secret");
});

it("keeps history, lazy detail and SSE cursors compatible when display events come from one native row", async () => {
  const { app, headers, session, stores, hub } = await setup();
  const native = { id: "pi_entry_n", type: "agent.context_entry", sdk: "pi@0.83.0", turnId: "t1", timestamp: new Date().toISOString(),
    entry: { id: "n", type: "message", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] } },
    presentation: { version: 1, blocks: [{ type: "agent.message", index: 0 }, { type: "agent.message", index: 1 }] } };
  const row = await stores.eventLogStore.append(session.id, { type: native.type, data: native, sessionThreadId: "primary" });
  expect(row.seq).toBe(4);
  const base = `/v1/sessions/${session.id}/events`;
  const page1 = await (await app.request(`${base}?after_seq=1&limit=1`, { headers })).json();
  expect(page1).toMatchObject({ data: [{ seq: 2, type: "agent.message", data: { content: [{ type: "text", text: "first" }] } }], has_more: true });
  const page2 = await (await app.request(`${base}?after_seq=2&limit=1`, { headers })).json();
  expect(page2).toMatchObject({ data: [{ seq: 3, type: "agent.message", data: { content: [{ type: "text", text: "second" }] } }], has_more: true });
  const detail = await (await app.request(`${base}/3/data`, { headers })).json();
  expect(detail).toMatchObject({ data: { type: "agent.message", content: [{ type: "text", text: "second" }] } });
  const response = await app.request(base, { headers: { ...headers, accept: "text/event-stream", "last-event-id": "2" } });
  const reader = response.body!.getReader(); const decoder = new TextDecoder();
  let replay = "";
  while (!replay.includes("event: agent.context_entry")) replay += decoder.decode((await reader.read()).value);
  expect(replay).toContain("id: 3\n"); expect(replay).toContain("id: 4\n"); expect(replay).not.toContain("id: 2\n");
  await reader.cancel();
  const live = hub.subscribe(session.id); const liveReader = live.stream.getReader();
  hub.publish(session.id, { type: row.type, seq: row.seq, data: row.data });
  const frames = [];
  for (let i = 0; i < 3; i++) frames.push((await liveReader.read()).value!);
  expect(frames.map(f => /id: (\d+)/.exec(f)![1])).toEqual(["2", "3", "4"]);
  expect(frames.slice(1).join("")).toBe(replay.replace(/^retry: 1000\n\n/, ""));
  await liveReader.cancel();
});

it("serves a native image result through its display cursor for both owner and share", async () => {
  const { app, headers, session, stores } = await setup();
  const image = { type: "image", mimeType: "image/png", data: "A".repeat(100000) };
  const native = { id: "pi_image", type: "agent.context_entry", sdk: "pi@0.83.0", turnId: "t1",
    entry: { id: "image", parentId: null, type: "message", message: { role: "toolResult", toolCallId: "read1", toolName: "read", isError: false, content: [image] } },
    presentation: { version: 1, blocks: [{ type: "agent.tool_result" }] } };
  const row = await stores.eventLogStore.append(session.id, { type: native.type, data: native, sessionThreadId: "primary" });
  const base = `/v1/sessions/${session.id}/events`;
  const history = await (await app.request(`${base}?after_seq=1`, { headers })).json();
  expect(JSON.stringify(history).length).toBeLessThan(2500);
  expect(history.data[0]).toMatchObject({ seq: row.seq - 1, type: "agent.tool_result", data: { toolUseId: "read1", payloadRef: { version: 1 } } });
  const share = await stores.sessionShareStore.getOrCreate(session.id);
  for (const auth of [headers, { "x-session-share": share.id }]) {
    const detail = await (await app.request(`${base}/${row.seq - 1}/data`, { headers: auth })).json();
    expect(detail).toMatchObject({ data: { type: "agent.tool_result", content: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: image.data } }] } });
  }
});
