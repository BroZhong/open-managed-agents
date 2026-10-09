import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { createApp } from "../src/app.js";

afterEach(() => vi.unstubAllEnvs());
describe("Session thinking preference", () => {
  it("persists only on the selected Session, resets, and rejects invalid updates", async () => {
    vi.stubEnv("AUTH_DISABLED", "true");
    const stores = createMemoryStores();
    const app = createApp(stores);
    const post = (url: string, body: unknown) => app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const agent = await (await post("/v1/agents", { name: "Test", model: "test", system: "test", runtime: "pi-agent", thinking: "medium" })).json();
    const first = await (await post("/v1/sessions", { agent: agent.id })).json();
    const second = await (await post("/v1/sessions", { agent: agent.id })).json();
    expect(first.thinking ?? null).toBeNull();
    expect(first.agent.thinking).toBe("medium");
    const response = await post(`/v1/sessions/${first.id}`, { thinking: "high" });
    expect(response.status).toBe(200);
    expect((await response.json()).thinking).toBe("high");
    expect((await (await app.request(`/v1/sessions/${first.id}`)).json()).thinking).toBe("high");
    expect((await stores.sessionStore.getById(second.id))?.thinking ?? null).toBeNull();
    expect((await stores.agentStore.getById(agent.id))?.thinking).toBe("medium");
    for (const thinking of ["ultra", "", 3, false, {}]) {
      expect((await post(`/v1/sessions/${first.id}`, { thinking })).status).toBe(400);
    }
    expect((await post(`/v1/sessions/${first.id}`, { title: "Mixed", thinking: "low" })).status).toBe(400);
    expect((await (await post(`/v1/sessions/${first.id}`, { title: "Rename" })).json()).thinking).toBe("high");
    expect((await (await post(`/v1/sessions/${first.id}`, { thinking: null })).json()).thinking).toBeNull();
    const otherTenant = await stores.sessionStore.create({ tenantId: "other", agentId: agent.id, agent, workspaceId: "other" });
    expect((await post(`/v1/sessions/${otherTenant.id}`, { thinking: "max" })).status).toBe(404);
    await stores.sessionStore.softDelete(first.id);
    expect((await post(`/v1/sessions/${first.id}`, { thinking: "max" })).status).toBe(404);
  });
});
