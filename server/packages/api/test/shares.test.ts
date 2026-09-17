import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { createApp } from "../src/app.js";

beforeEach(() => { vi.stubEnv("AUTH_DISABLED", "false"); });

async function setup() {
  const stores = createMemoryStores();
  Object.assign(stores.artifactStore, { createSignedReadUrl: vi.fn(async (_tenant: string, _workspace: string, path: string) => `https://storage.example.test/${path}`) });
  const key = await stores.apiKeyStore.create("owner", "test");
  const headers = { "x-api-key": key.rawKey, "content-type": "application/json" };
  const app = createApp(stores);
  const agent = await stores.agentStore.create({ tenantId: "owner", name: "Writer", model: "test", system: "PRIVATE_SYSTEM", runtime: "mock", sandbox: { env: { SECRET: "PRIVATE_ENV" } } });
  const response = await app.request("/v1/sessions", { method: "POST", headers, body: JSON.stringify({ agent: agent.id }) });
  const session = await response.json();
  return { app, stores, headers, session };
}

describe("Session sharing HTTP boundary", () => {
  it("creates one unpredictable share per Session even across concurrent retries and app restarts", async () => {
    const { app, stores, headers, session } = await setup();
    const responses = await Promise.all(Array.from({ length: 12 }, () => app.request(`/v1/sessions/${session.id}/share`, { method: "POST", headers })));
    expect(responses.map((r) => r.status)).toEqual(Array(12).fill(200));
    const shares = await Promise.all(responses.map((r) => r.json()));
    expect(new Set(shares.map((s) => s.id)).size).toBe(1);
    expect(shares[0].id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const retry = await createApp(stores).request(`/v1/sessions/${session.id}/share`, { method: "POST", headers });
    expect(await retry.json()).toEqual(shares[0]);
  });
  it("resolves anonymously, exposes only display fields, and reads every page of durable history", async () => {
    const { app, stores, headers, session } = await setup();
    const share = await (await app.request(`/v1/sessions/${session.id}/share`, { method: "POST", headers })).json();
    const access = { "x-session-share": share.id };
    const resolved = await app.request(`/v1/shares/${share.id}`, { headers: access });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toEqual({ sessionId: session.id, workspaceId: session.workspaceId });
    const detail = await app.request(`/v1/sessions/${session.id}`, { headers: { ...headers, ...access } });
    expect(await detail.json()).toEqual({ id: session.id, workspaceId: session.workspaceId, status: "idle", agent: { name: "Writer" }, createdAt: session.createdAt });
    for (const type of ["user.message", "agent.thinking", "agent.tool_use", "agent.tool_result", "agent.message"]) {
      await stores.eventLogStore.append(session.id, { type, data: { content: [{ type: "text", text: "Original history" }] }, sessionThreadId: "turn_1" });
    }
    const first = await (await app.request(`/v1/sessions/${session.id}/events?limit=2`, { headers: access })).json();
    expect(first.has_more).toBe(true);
    const rest = await (await app.request(`/v1/sessions/${session.id}/events?after_seq=${first.data.at(-1).seq}`, { headers: access })).json();
    expect([...first.data, ...rest.data].map((event: { type: string }) => event.type)).toEqual(["user.message", "agent.thinking", "agent.tool_use", "agent.tool_result", "agent.message"]);
  });

  it("denies forged credentials, other resources, SSE and every mutation even with owner credentials", async () => {
    const { app, stores, headers, session } = await setup();
    const share = await (await app.request(`/v1/sessions/${session.id}/share`, { method: "POST", headers })).json();
    const access = { ...headers, "x-session-share": share.id };
    const other = await stores.sessionStore.create({ tenantId: "owner", agentId: session.agentId, agent: session.agent, workspaceId: session.workspaceId });
    const cross = await stores.sessionStore.create({ tenantId: "other", agentId: session.agentId, agent: session.agent, workspaceId: "cross_workspace" });
    const child = await stores.sessionStore.create({ tenantId: "owner", agentId: session.agentId, agent: session.agent, workspaceId: session.workspaceId, delegation: { parentSessionId: session.id } as never });
    for (const path of ["/v1/sessions", "/v1/workspaces", "/v1/agents", "/v1/skills", "/v1/mcp-catalog", "/v1/unknown", `/v1/agents/${session.agentId}/files`, `/v1/sessions/${session.id}/pending`, `/v1/sessions/${session.id}/delegations`, ...[other, cross, child].flatMap((s) => [`/v1/sessions/${s.id}`, `/v1/sessions/${s.id}/events`])]) {
      expect((await app.request(path, { headers: access })).status, path).toBe(403);
    }
    for (const accept of ["text/event-stream", "text/event-stream, application/json", "TEXT/EVENT-STREAM"]) {
      expect((await app.request(`/v1/sessions/${session.id}/events`, { headers: { ...access, accept } })).status).toBe(403);
    }
    for (const [method, path, body] of [
      ["POST", `/v1/sessions/${session.id}/share`, {}],
      ["POST", `/v1/sessions/${session.id}/events`, { events: [{ type: "user.message", data: { content: [{ type: "text", text: "execute" }] } }] }],
      ["POST", `/v1/sessions/${session.id}/events`, { events: [{ type: "user.interrupt", data: {} }] }],
      ["POST", `/v1/sessions/${session.id}`, { title: "changed", deleted: true }],
      ["DELETE", `/v1/sessions/${session.id}`, {}],
      ["POST", "/auth/register", {}],
    ] as const) {
      expect((await app.request(path, { method, headers: access, body: JSON.stringify(body) })).status).toBe(403);
    }
    const ownerDetail = await (await app.request(`/v1/sessions/${session.id}`, { headers })).json();
    expect(ownerDetail.status).toBe("idle");
    expect(ownerDetail.agent.system).toBe("PRIVATE_SYSTEM");
    expect((await (await app.request(`/v1/sessions/${session.id}/events`, { headers })).json()).data).toEqual([]);
    expect((await (await app.request(`/v1/sessions/${session.id}/pending`, { headers })).json()).count).toBe(0);
    for (const id of ["", session.id, "x".repeat(43), share.id.slice(1)]) {
      expect((await app.request(`/v1/sessions/${session.id}`, { headers: { ...headers, "x-session-share": id } })).status).toBe(404);
    }
    expect((await app.request(`/v1/sessions/${session.id}/share`, { method: "POST" })).status).toBe(401);
    const key = await stores.apiKeyStore.create("other", "other");
    expect((await app.request(`/v1/sessions/${session.id}/share`, { method: "POST", headers: { "x-api-key": key.rawKey } })).status).toBe(404);
    vi.stubEnv("AUTH_DISABLED", "true");
    expect((await app.request("/v1/sessions", { headers: access })).status).toBe(403);
  });

  it("reads current Workspace files and rejects scope escapes and all write methods without changing files", async () => {
    const { app, stores, headers, session } = await setup();
    const share = await (await app.request(`/v1/sessions/${session.id}/share`, { method: "POST", headers })).json();
    const access = { ...headers, "x-session-share": share.id };
    const base = `/v1/workspaces/${session.workspaceId}`;
    await stores.artifactStore.put({ tenantId: "owner", workspaceId: session.workspaceId, path: "a.txt", body: "before" });
    for (const tenantId of ["owner", "other"]) {
      const workspace = await stores.workspaceStore.create({ tenantId, id: `workspace_${tenantId}` });
      for (const suffix of ["files", "files/a.txt"]) {
        expect((await app.request(`/v1/workspaces/${workspace.id}/${suffix}`, { headers: access })).status).toBe(403);
      }
    }
    expect(await (await app.request(`${base}/files/a.txt`, { headers: access })).json()).toMatchObject({ path: "a.txt", size: 6, url: "https://storage.example.test/a.txt" });
    for (const [method, path, body] of [
      ["PUT", "files/content", { path: "a.txt", content: "changed" }],
      ["PUT", "files/content", { path: "new/.oma-directory", content: "" }],
      ["DELETE", "files/content?path=a.txt", {}],
      ["POST", "files/rename", { from: "a.txt", to: "changed.txt" }],
      ["POST", "files/upload", {}], ["PATCH", "files/a.txt", {}],
      ["POST", "", { deleted: true }], ["DELETE", "", {}],
    ] as const) expect((await app.request(`${base}/${path}`, { method, headers: access, body: JSON.stringify(body) })).status).toBe(403);
    for (const path of ["files?prefix=../", "files?prefix=%2e%2e%2f", "files/%252e%252e/secret", "files/%2e%2e%2fsecret", "files/%5c..%5csecret", "files/.oma-workspace-checks/probe"]) {
      expect((await app.request(`${base}/${path}`, { headers: access })).status, path).toBeGreaterThanOrEqual(400);
    }
    expect(await (await app.request(`${base}/files/a.txt`, { headers: access })).json()).toMatchObject({ path: "a.txt", size: 6, url: "https://storage.example.test/a.txt" });
    expect((await (await app.request(`${base}/files`, { headers: access })).json()).data.map((f: {path: string}) => f.path)).toEqual(["a.txt"]);
    // Owner file operations remain available, and the same share reads updates.
    expect((await app.request(`${base}/files/content`, { method: "PUT", headers, body: JSON.stringify({ path: "a.txt", content: "after" }) })).status).toBe(200);
    expect(await (await app.request(`${base}/files/a.txt?download=1`, { headers: access })).json()).toMatchObject({ path: "a.txt", size: 5 });
    expect(stores.artifactStore.createSignedReadUrl).toHaveBeenLastCalledWith("owner", session.workspaceId, "a.txt", 600, expect.objectContaining({ download: true }));
  });

  it.each(["session", "workspace"])("keeps terminated history readable but invalidates all reads when the %s is deleted", async (deleted) => {
    const { app, headers, session } = await setup();
    const share = await (await app.request(`/v1/sessions/${session.id}/share`, { method: "POST", headers })).json();
    const access = { "x-session-share": share.id };
    await app.request(`/v1/sessions/${session.id}`, { method: "DELETE", headers });
    expect((await app.request(`/v1/sessions/${session.id}/events`, { headers: access })).status).toBe(200);
    const resource = deleted === "session" ? `sessions/${session.id}` : `workspaces/${session.workspaceId}`;
    expect((await app.request(`/v1/${resource}`, { method: deleted === "session" ? "POST" : "DELETE", headers, body: JSON.stringify({ deleted: true }) })).status).toBe(200);
    for (const path of [`shares/${share.id}`, `sessions/${session.id}`, `sessions/${session.id}/events`, `workspaces/${session.workspaceId}/files`, `workspaces/${session.workspaceId}/files/a.txt`]) {
      expect((await app.request(`/v1/${path}`, { headers: access })).status).toBe(404);
    }
  });

});
