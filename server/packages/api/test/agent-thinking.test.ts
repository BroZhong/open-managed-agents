import { describe, expect, it } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { createApp } from "../src/app.js";

describe("Agent thinking configuration", () => {
  it("round trips, preserves on partial edits, forks and clears the preference", async () => {
    process.env.AUTH_DISABLED = "true";
    const app = createApp({ ...createMemoryStores() });
    const post = (url: string, body: unknown) => app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const created = await post("/v1/agents", { name: "Test", model: "test", system: "test", runtime: "pi-agent", thinking: "medium" });
    expect(created.status).toBe(201);
    const agent = await created.json();
    expect(agent.thinking).toBe("medium");
    expect((await (await post(`/v1/agents/${agent.id}`, { name: "Rename" })).json()).thinking).toBe("medium");
    const fork = await post(`/v1/agents/${agent.id}/fork`, { name: "Copy" });
    expect(fork.status).toBe(201);
    expect((await fork.json()).thinking).toBe("medium");
    expect((await post(`/v1/agents/${agent.id}`, { thinking: "invalid" })).status).toBe(400);
    const reset = await post(`/v1/agents/${agent.id}`, { thinking: null });
    expect(reset.status).toBe(200);
    expect((await reset.json()).thinking ?? null).toBeNull();
  });
});
