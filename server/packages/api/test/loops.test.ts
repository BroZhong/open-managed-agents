import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { createApp } from "../src/app.js";
import type { SessionRouter } from "@oma-server/session-router";

describe("Agent Loops", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("creates and lists a five-minute Loop owned by the Agent", async () => {
    const now = new Date("2026-07-14T00:00:00.000Z");
    const stores = createMemoryStores();
    const agent = await stores.agentStore.create({
      tenantId: "dev",
      name: "Session Analyst",
      model: "openai-codex/gpt-5.5",
      system: "Find concrete improvements.",
      runtime: "pi-agent",
    });
    const app = createApp({
      apiKeyStore: stores.apiKeyStore,
      agentStore: stores.agentStore,
      sessionStore: stores.sessionStore,
      workspaceStore: stores.workspaceStore,
      loopStore: stores.loopStore,
      now: () => now,
    });

    const created = await app.request(`/v1/agents/${agent.id}/loops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Weekly Session Review",
        description: "Review recent Session outcomes",
        prompt: "Read the last seven days of Sessions and propose Agent improvements.",
        intervalMinutes: 5,
        enabled: true,
      }),
    });

    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      agentId: agent.id,
      name: "Weekly Session Review",
      description: "Review recent Session outcomes",
      intervalMinutes: 5,
      enabled: true,
      nextRunAt: "2026-07-14T00:05:00.000Z",
    });

    const listed = await app.request(`/v1/agents/${agent.id}/loops`);
    expect(listed.status).toBe(200);
    expect((await listed.json()).data).toHaveLength(1);
  });

  it("rejects Loop cadences shorter than five minutes", async () => {
    const stores = createMemoryStores();
    const agent = await stores.agentStore.create({
      tenantId: "dev",
      name: "Session Analyst",
      model: "openai-codex/gpt-5.5",
      system: "Find concrete improvements.",
      runtime: "pi-agent",
    });
    const app = createApp({
      apiKeyStore: stores.apiKeyStore,
      agentStore: stores.agentStore,
      loopStore: stores.loopStore,
    });

    const response = await app.request(`/v1/agents/${agent.id}/loops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Too frequent",
        prompt: "Analyze recent Sessions.",
        intervalMinutes: 4,
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "intervalMinutes must be an integer of at least 5",
      code: "validation_error",
    });
  });

  it("pauses and resumes a Loop without dispatching while disabled", async () => {
    let now = new Date("2026-07-14T00:00:00.000Z");
    const stores = createMemoryStores();
    const agent = await stores.agentStore.create({
      tenantId: "dev",
      name: "Session Analyst",
      model: "openai-codex/gpt-5.5",
      system: "Find concrete improvements.",
      runtime: "pi-agent",
    });
    const loop = await stores.loopStore.create({
      tenantId: "dev",
      agentId: agent.id,
      name: "Weekly Session Review",
      prompt: "Analyze recent Sessions.",
      intervalMinutes: 5,
      enabled: true,
      now,
    });
    const app = createApp({
      apiKeyStore: stores.apiKeyStore,
      agentStore: stores.agentStore,
      loopStore: stores.loopStore,
      now: () => now,
    });

    now = new Date("2026-07-14T00:01:00.000Z");
    const paused = await app.request(`/v1/loops/${loop.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ enabled: false });
    expect(await stores.loopStore.dispatchDue(
      new Date("2026-07-14T00:05:00.000Z"),
      10,
    )).toEqual([]);

    now = new Date("2026-07-14T00:06:00.000Z");
    const resumed = await app.request(`/v1/loops/${loop.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      enabled: true,
      nextRunAt: "2026-07-14T00:11:00.000Z",
    });
  });

  it("runs a Loop immediately and attaches the created Session to it", async () => {
    const now = new Date("2026-07-14T00:00:00.000Z");
    const stores = createMemoryStores();
    const agent = await stores.agentStore.create({
      tenantId: "dev",
      name: "Session Analyst",
      model: "openai-codex/gpt-5.5",
      system: "Find concrete improvements.",
      runtime: "pi-agent",
    });
    const handleNewEvent = vi.fn(async () => undefined);
    const app = createApp({
      apiKeyStore: stores.apiKeyStore,
      agentStore: stores.agentStore,
      sessionStore: stores.sessionStore,
      workspaceStore: stores.workspaceStore,
      loopStore: stores.loopStore,
      pendingEventStore: stores.pendingEventStore,
      sessionRouter: { handleNewEvent } as unknown as SessionRouter,
      now: () => now,
    });
    const loop = await stores.loopStore.create({
      tenantId: "dev",
      agentId: agent.id,
      name: "Weekly Session Review",
      prompt: "Analyze recent Sessions.",
      intervalMinutes: 5,
      enabled: true,
      now,
    });

    const response = await app.request(`/v1/loops/${loop.id}/run`, {
      method: "POST",
    });

    expect(response.status).toBe(201);
    const session = await response.json();
    expect(session).toMatchObject({
      agentId: agent.id,
      loopId: loop.id,
      title: loop.name,
    });
    expect(await stores.pendingEventStore.peek(session.id)).toMatchObject({
      type: "user.message",
      data: { content: [{ type: "text", text: "Analyze recent Sessions." }] },
    });
    expect(handleNewEvent).toHaveBeenCalledWith(session.id, expect.objectContaining({ id: agent.id }));
  });

  it("attributes a run-now Loop Turn to the authenticating API key", async () => {
    const now = new Date("2026-07-14T00:00:00.000Z");
    const stores = createMemoryStores();
    const agent = await stores.agentStore.create({
      tenantId: "dev",
      name: "Session Analyst",
      model: "openai-codex/gpt-5.5",
      system: "Find concrete improvements.",
      runtime: "pi-agent",
    });
    const loop = await stores.loopStore.create({
      tenantId: "dev",
      agentId: agent.id,
      name: "Weekly Session Review",
      prompt: "Analyze recent Sessions.",
      intervalMinutes: 5,
      enabled: true,
      now,
    });
    const { apiKey, rawKey } = await stores.apiKeyStore.create("dev", "loop runner");
    const app = createApp({
      apiKeyStore: stores.apiKeyStore,
      agentStore: stores.agentStore,
      sessionStore: stores.sessionStore,
      workspaceStore: stores.workspaceStore,
      loopStore: stores.loopStore,
      pendingEventStore: stores.pendingEventStore,
      now: () => now,
    });
    delete process.env.AUTH_DISABLED;

    const response = await app.request(`/v1/loops/${loop.id}/run`, {
      method: "POST",
      headers: { "x-api-key": rawKey },
    });

    expect(response.status).toBe(201);
    const session = await response.json();
    expect((await stores.pendingEventStore.peek(session.id))?.apiKeyId).toBe(apiKey.id);
  });

  it("does not expose a legacy MCP connection in a run-now Session", async () => {
    const now = new Date("2026-07-14T00:00:00.000Z");
    const stores = createMemoryStores();
    const agent = await stores.agentStore.create({
      tenantId: "dev",
      name: "Legacy MCP Agent",
      model: "openai-codex/gpt-5.5",
      system: "Analyze Sessions.",
      runtime: "pi-agent",
      mcpServers: [{
        name: "rds-mcp",
        url: "https://campaign.welltop.tech/agent/mcp/rds",
        transport: "streamable-http",
        headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
      }],
    });
    const loop = await stores.loopStore.create({
      tenantId: "dev",
      agentId: agent.id,
      name: "Legacy review",
      prompt: "Review Sessions.",
      intervalMinutes: 5,
      enabled: true,
      now,
    });
    const app = createApp({
      apiKeyStore: stores.apiKeyStore,
      agentStore: stores.agentStore,
      sessionStore: stores.sessionStore,
      workspaceStore: stores.workspaceStore,
      loopStore: stores.loopStore,
      pendingEventStore: stores.pendingEventStore,
      now: () => now,
    });

    const response = await app.request(`/v1/loops/${loop.id}/run`, {
      method: "POST",
    });
    expect(response.status).toBe(201);
    const session = await response.json();
    expect(session.agent.mcpServers).toEqual([{
      catalogId: "rds-mcp",
      name: "rds-mcp",
    }]);
    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain("campaign.welltop.tech");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("RDS_MCP_APIKEY");
  });
});
