import { describe, it, expect } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { createApp } from "../src/app.js";

async function setup() {
  process.env.AUTH_DISABLED = "true";
  const stores = createMemoryStores();
  const app = createApp({ ...stores, apiKeyStore: { async findByKeyHash() { return null; } } });
  const agent = await stores.agentStore.create({ tenantId: "dev", name: "A", model: "m", runtime: "pi-agent", system: "" });
  const workspace = await stores.workspaceStore.create({ tenantId: "dev", name: "W" });
  const session = await stores.sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: workspace.id });
  await stores.artifactStore.put({ tenantId: "dev", workspaceId: workspace.id, path: "keep.txt", body: "keep" });
  return { app, stores, agent, workspace, session };
}

const jsonPost = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("Sidebar mutations", () => {
  it("renames and soft-deletes a running Session without terminating it or deleting its files", async () => {
    const { app, stores, session, workspace } = await setup();
    await stores.sessionStore.updateStatus(session.id, "running");
    const renamed = await app.request(`/v1/sessions/${session.id}`, jsonPost({ title: "  New title  " }));
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).title).toBe("New title");
    expect((await app.request(`/v1/sessions/${session.id}`, jsonPost({ title: "  " }))).status).toBe(400);
    expect((await app.request(`/v1/sessions/${session.id}`, jsonPost({ deleted: true }))).status).toBe(200);
    expect((await stores.sessionStore.getById(session.id))).toMatchObject({ status: "running", title: "New title", deletedAt: expect.any(Date) });
    expect((await (await app.request("/v1/sessions")).json()).data).toEqual([]);
    expect(await stores.artifactStore.exists("dev", workspace.id, "keep.txt")).toBe(true);
  });

  it("hides a deleted Workspace's Sessions across Agents and preserves the underlying records", async () => {
    const { app, stores, workspace, session, agent } = await setup();
    const otherAgent = await stores.agentStore.create({ tenantId: "dev", name: "B", model: "m", runtime: "pi-agent", system: "" });
    await stores.sessionStore.create({ tenantId: "dev", agentId: otherAgent.id, agent: otherAgent, workspaceId: workspace.id, loopId: "loop" });
    const unrelated = await stores.workspaceStore.create({ tenantId: "dev", name: "Other" });
    const visible = await stores.sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: unrelated.id });
    expect((await app.request(`/v1/workspaces/${workspace.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await (await app.request("/v1/workspaces")).json()).data.map((w: { id: string }) => w.id)).toEqual([unrelated.id]);
    const sessions = await (await app.request("/v1/sessions?limit=1")).json();
    expect(sessions.data.map((s: { id: string }) => s.id)).toEqual([visible.id]);
    expect(sessions.has_more).toBe(false);
    expect((await (await app.request("/v1/sessions?loop_id=loop")).json()).data).toEqual([]);
    expect(await stores.sessionStore.getById(session.id)).toMatchObject({ status: "idle" });
    expect(await stores.workspaceStore.getById("dev", workspace.id)).toMatchObject({ deletedAt: expect.any(Date) });
    expect(await stores.artifactStore.exists("dev", workspace.id, "keep.txt")).toBe(true);
    expect((await app.request("/v1/sessions", jsonPost({ agent: agent.id, workspace_id: workspace.id }))).status).toBe(409);
  });

  it("combines soft deletion and child exclusion before paginating visible Sessions", async () => {
    const { app, stores, agent, workspace, session } = await setup();
    const input = { tenantId: "dev", agentId: agent.id, agent, workspaceId: workspace.id };
    await stores.sessionStore.softDelete(session.id);
    await stores.sessionStore.create({ ...input, delegation: {
      parentSessionId: session.id, parentTurnId: "turn", parentToolUseId: "tool", sandboxSessionId: session.id,
    } });
    const hiddenWorkspace = await stores.workspaceStore.create({ tenantId: "dev" });
    await stores.sessionStore.create({ ...input, workspaceId: hiddenWorkspace.id });
    await stores.workspaceStore.softDelete("dev", hiddenWorkspace.id);
    const visible = [await stores.sessionStore.create(input), await stores.sessionStore.create(input)];
    const query = `/v1/sessions?agent_id=${agent.id}&exclude_loop=true&exclude_delegated=true&limit=1`;
    const first = await app.request(query);
    expect(first.status).toBe(200);
    const page = await first.json();
    expect(page).toMatchObject({ data: [{ id: visible[0].id }], has_more: true, next_cursor: visible[0].id });
    const second = await app.request(`${query}&cursor=${page.next_cursor}`);
    expect(await second.json()).toMatchObject({ data: [{ id: visible[1].id }], has_more: false });
  });

  it("rejects cross-tenant rename and soft-delete requests", async () => {
    const { app, stores, agent } = await setup();
    const workspace = await stores.workspaceStore.create({ tenantId: "other", name: "Secret" });
    const session = await stores.sessionStore.create({ tenantId: "other", agentId: agent.id, agent, workspaceId: workspace.id });
    expect((await app.request(`/v1/workspaces/${workspace.id}`, { method: "DELETE" })).status).toBe(404);
    for (const body of [{ title: "new" }, { deleted: true }]) {
      expect((await app.request(`/v1/sessions/${session.id}`, jsonPost(body))).status).toBe(404);
    }
    expect((await stores.sessionStore.getById(session.id))?.deletedAt).toBeUndefined();
  });
});
