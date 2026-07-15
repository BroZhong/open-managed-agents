import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import type { ApiKeyStore, TenantContext } from "../src/types.js";
import type {
  AgentStore,
  Agent,
  AgentStoreCreateInput,
  AgentStoreUpdateInput,
  AgentStoreListOpts,
  PaginatedResult,
} from "@oma-server/store";

// In-memory AgentStore for testing
class InMemoryAgentStore implements AgentStore {
  private agents: Agent[] = [];
  private nextId = 1;

  async create(input: AgentStoreCreateInput): Promise<Agent> {
    const agent: Agent = {
      id: `agent_${this.nextId++}`,
      tenantId: input.tenantId,
      name: input.name,
      description: input.description,
      model: input.model,
      system: input.system,
      runtime: input.runtime,
      tools: input.tools,
      mcpServers: input.mcpServers,
      skills: input.skills,
      sandbox: input.sandbox,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.agents.push(agent);
    return agent;
  }

  async getById(id: string): Promise<Agent | null> {
    return this.agents.find((a) => a.id === id) ?? null;
  }

  async list(
    tenantId: string,
    opts?: AgentStoreListOpts,
  ): Promise<PaginatedResult<Agent>> {
    const limit = opts?.limit ?? 50;
    const cursor = opts?.cursor;

    let filtered = this.agents.filter((a) => a.tenantId === tenantId);

    if (cursor) {
      const idx = filtered.findIndex((a) => a.id === cursor);
      if (idx >= 0) {
        filtered = filtered.slice(idx + 1);
      }
    }

    const data = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;

    return { data, hasMore };
  }

  async update(id: string, input: AgentStoreUpdateInput): Promise<Agent | null> {
    const agent = this.agents.find((a) => a.id === id);
    if (!agent) return null;

    if (input.name !== undefined) agent.name = input.name;
    if (input.description !== undefined) agent.description = input.description;
    if (input.model !== undefined) agent.model = input.model;
    if (input.system !== undefined) agent.system = input.system;
    if (input.runtime !== undefined) agent.runtime = input.runtime;
    if (input.tools !== undefined) agent.tools = input.tools;
    if (input.mcpServers !== undefined) agent.mcpServers = input.mcpServers;
    if (input.skills !== undefined) agent.skills = input.skills;
    if (input.sandbox !== undefined) agent.sandbox = input.sandbox;
    agent.updatedAt = new Date();

    return agent;
  }

  async delete(id: string): Promise<boolean> {
    const idx = this.agents.findIndex((a) => a.id === id);
    if (idx < 0) return false;
    this.agents.splice(idx, 1);
    return true;
  }
}

function makeApiKeyStore(entries: Map<string, TenantContext>): ApiKeyStore {
  return {
    async findByKeyHash(keyHash) {
      return entries.get(keyHash) ?? null;
    },
  };
}

function createTestApp() {
  process.env.AUTH_DISABLED = "true";
  process.env.OMA_SUPABASE_ALLOWED_TENANTS = "dev";
  const agentStore = new InMemoryAgentStore();
  const app = createApp({
    apiKeyStore: makeApiKeyStore(new Map()),
    agentStore,
  });
  return { app, agentStore };
}

describe("POST /v1/agents", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("creates an agent with valid input", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My Agent",
        model: "claude-3",
        system: "You are helpful",
        runtime: "claude-code",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^agent_/);
    expect(body.name).toBe("My Agent");
    expect(body.model).toBe("claude-3");
    expect(body.system).toBe("You are helpful");
    expect(body.runtime).toBe("claude-code");
    expect(body.tenantId).toBe("dev");
  });

  it("creates an agent with an optional description", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My Agent",
        description: "Handles short-drama scripts",
        model: "claude-3",
        system: "You are helpful",
        runtime: "claude-code",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.description).toBe("Handles short-drama scripts");
  });

  it("returns 400 when description is not a string", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My Agent",
        description: 42,
        model: "claude-3",
        system: "You are helpful",
        runtime: "claude-code",
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("description must be a string");
  });

  it("returns 400 when name is missing", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-3",
        system: "You are helpful",
        runtime: "claude-code",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("name is required");
  });

  it("returns 400 when model is missing", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My Agent",
        system: "You are helpful",
        runtime: "claude-code",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("model is required");
  });

  it("returns 400 when system is missing", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My Agent",
        model: "claude-3",
        runtime: "claude-code",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("system is required");
  });

  it("returns 400 when runtime is missing", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My Agent",
        model: "claude-3",
        system: "You are helpful",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("runtime is required");
  });

  it("returns 400 for invalid runtime value", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My Agent",
        model: "claude-3",
        system: "You are helpful",
        runtime: "invalid-runtime",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("runtime must be one of");
  });

  it("returns 400 for invalid JSON body", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON body");
  });

  it("accepts codex as a valid runtime", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Codex Agent",
        model: "gpt-4",
        system: "You are helpful",
        runtime: "codex",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.runtime).toBe("codex");
  });

  it("accepts pi-agent as a valid runtime", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Pi Agent",
        model: "pi-1",
        system: "You are helpful",
        runtime: "pi-agent",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.runtime).toBe("pi-agent");
  });

  it("creates an agent with sandbox config", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Sandboxed Agent",
        model: "claude-3",
        system: "You are helpful",
        runtime: "claude-code",
        sandbox: { enabled: true, image: "open-managed-agents/sandbox:latest" },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sandbox).toEqual({
      enabled: true,
      image: "open-managed-agents/sandbox:latest",
    });
  });

  it("returns 400 when an MCP server URL is not HTTP(S)", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Pi Agent",
        model: "openai-codex/gpt-5.5",
        system: "You are helpful",
        runtime: "pi-agent",
        mcpServers: [{ name: "rds-mcp", url: "file:///tmp/mcp.sock" }],
      }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects a new raw RDS streamable HTTP MCP configuration", async () => {
    const { app } = createTestApp();
    const mcpServers = [
      {
        name: "rds-mcp",
        url: "https://campaign.welltop.tech/agent/mcp/rds",
        transport: "streamable-http",
        headers: {
          Authorization: "Bearer ${RDS_MCP_APIKEY}",
        },
      },
    ];
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "RDS Agent",
        model: "openai-codex/gpt-5.5",
        system: "You are helpful",
        runtime: "pi-agent",
        mcpServers,
      }),
    });

    expect(res.status).toBe(400);
  });

  it("attaches the managed Supabase MCP with configurable name and description", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Session Analyst",
        model: "openai-codex/gpt-5.5",
        system: "Find opportunities to improve this Agent.",
        runtime: "pi-agent",
        mcpServers: [
          {
            catalogId: "aliyun-rds-supabase",
            name: "session-data",
            description: "Read recent Session data from Supabase",
          },
        ],
      }),
    });

    expect(res.status).toBe(201);
    expect((await res.json()).mcpServers).toEqual([
      {
        catalogId: "aliyun-rds-supabase",
        name: "session-data",
        description: "Read recent Session data from Supabase",
      },
    ]);
  });

  it("rejects managed Supabase when the tenant is outside the deployment allowlist", async () => {
    const { app } = createTestApp();
    process.env.OMA_SUPABASE_ALLOWED_TENANTS = "another-tenant";
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Session Analyst",
        model: "openai-codex/gpt-5.5",
        system: "Find opportunities to improve this Agent.",
        runtime: "pi-agent",
        mcpServers: [{
          catalogId: "aliyun-rds-supabase",
          name: "session-data",
        }],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "mcpServers[0].catalogId is not available for this tenant",
    });
  });

  it.each([
    {
      label: "a non-array value",
      mcpServers: { name: "rds-mcp", url: "https://example.com/mcp" },
    },
    {
      label: "a non-object entry",
      mcpServers: [null],
    },
    {
      label: "an empty name",
      mcpServers: [{ name: "   ", url: "https://example.com/mcp" }],
    },
    {
      label: "duplicate names",
      mcpServers: [
        { name: "rds-mcp", url: "https://example.com/one" },
        { name: "rds-mcp", url: "https://example.com/two" },
      ],
    },
    {
      label: "an unsupported transport",
      mcpServers: [
        { name: "rds-mcp", url: "https://example.com/mcp", transport: "stdio" },
      ],
    },
    {
      label: "non-object headers",
      mcpServers: [
        { name: "rds-mcp", url: "https://example.com/mcp", headers: ["bad"] },
      ],
    },
    {
      label: "a non-string header value",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://example.com/mcp",
          headers: { Authorization: 42 },
        },
      ],
    },
    {
      label: "a header name containing a newline",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://example.com/mcp",
          headers: { "X-Test\nInjected": "value" },
        },
      ],
    },
    {
      label: "a header value containing a newline",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer safe\r\nX-Injected: yes" },
        },
      ],
    },
  ])("returns 400 when MCP servers contain $label", async ({ mcpServers }) => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Pi Agent",
        model: "openai-codex/gpt-5.5",
        system: "You are helpful",
        runtime: "pi-agent",
        mcpServers,
      }),
    });

    expect(res.status).toBe(400);
  });

  it.each([
    {
      label: "a different server name",
      mcpServers: [
        {
          name: "other-mcp",
          url: "https://campaign.welltop.tech/agent/mcp/rds",
          transport: "streamable-http",
          headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
        },
      ],
    },
    {
      label: "a different URL",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://example.com/mcp",
          transport: "streamable-http",
          headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
        },
      ],
    },
    {
      label: "SSE transport",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://campaign.welltop.tech/agent/mcp/rds",
          transport: "sse",
          headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
        },
      ],
    },
    {
      label: "an omitted transport",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://campaign.welltop.tech/agent/mcp/rds",
          headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
        },
      ],
    },
    {
      label: "missing headers",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://campaign.welltop.tech/agent/mcp/rds",
          transport: "streamable-http",
        },
      ],
    },
    {
      label: "a different token expression",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://campaign.welltop.tech/agent/mcp/rds",
          transport: "streamable-http",
          headers: { Authorization: "Bearer ${OTHER_TOKEN}" },
        },
      ],
    },
    {
      label: "an extra header",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://campaign.welltop.tech/agent/mcp/rds",
          transport: "streamable-http",
          headers: {
            Authorization: "Bearer ${RDS_MCP_APIKEY}",
            "X-Extra": "value",
          },
        },
      ],
    },
  ])("returns 400 for $label outside the MCP allowlist", async ({ mcpServers }) => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Pi Agent",
        model: "openai-codex/gpt-5.5",
        system: "You are helpful",
        runtime: "pi-agent",
        mcpServers,
      }),
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /v1/agents", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("returns empty list when no agents exist", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.has_more).toBe(false);
  });

  it("returns list of agents", async () => {
    const { app, agentStore } = createTestApp();
    await agentStore.create({
      tenantId: "dev",
      name: "Agent 1",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });
    await agentStore.create({
      tenantId: "dev",
      name: "Agent 2",
      model: "claude-3",
      system: "sys",
      runtime: "codex",
    });

    const res = await app.request("/v1/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.has_more).toBe(false);
  });

  it("respects limit parameter", async () => {
    const { app, agentStore } = createTestApp();
    for (let i = 0; i < 5; i++) {
      await agentStore.create({
        tenantId: "dev",
        name: `Agent ${i}`,
        model: "claude-3",
        system: "sys",
        runtime: "claude-code",
      });
    }

    const res = await app.request("/v1/agents?limit=3");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(3);
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).toBeDefined();
  });

  it("caps limit at 100", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents?limit=200");
    expect(res.status).toBe(200);
    // Just verifying the request succeeds - the limit is capped internally
  });

  it("preserves tolerant parsing for legacy limit values", async () => {
    const { app, agentStore } = createTestApp();
    for (let i = 0; i < 2; i++) {
      await agentStore.create({
        tenantId: "dev",
        name: `Agent ${i}`,
        model: "claude-3",
        system: "sys",
        runtime: "claude-code",
      });
    }

    const invalid = await app.request("/v1/agents?limit=abc");
    expect(invalid.status).toBe(200);
    expect((await invalid.json()).data).toHaveLength(2);

    const decimal = await app.request("/v1/agents?limit=1.5");
    expect(decimal.status).toBe(200);
    expect((await decimal.json()).data).toHaveLength(1);
  });

  it("supports cursor pagination", async () => {
    const { app, agentStore } = createTestApp();
    for (let i = 0; i < 5; i++) {
      await agentStore.create({
        tenantId: "dev",
        name: `Agent ${i}`,
        model: "claude-3",
        system: "sys",
        runtime: "claude-code",
      });
    }

    const page1 = await app.request("/v1/agents?limit=3");
    const body1 = await page1.json();
    expect(body1.data).toHaveLength(3);
    expect(body1.has_more).toBe(true);

    const page2 = await app.request(`/v1/agents?limit=3&cursor=${body1.next_cursor}`);
    const body2 = await page2.json();
    expect(body2.data).toHaveLength(2);
    expect(body2.has_more).toBe(false);
  });

  it("isolates agents by tenant", async () => {
    const { app, agentStore } = createTestApp();
    await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });
    await agentStore.create({
      tenantId: "other-tenant",
      name: "Other Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });

    const res = await app.request("/v1/agents");
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe("My Agent");
  });
});

describe("GET /v1/agents/:id", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("returns an agent by id", async () => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });

    const res = await app.request(`/v1/agents/${created.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.name).toBe("My Agent");
  });

  it("returns 404 for non-existent agent", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents/agent_999");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  it("returns 404 for agent belonging to different tenant", async () => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "other-tenant",
      name: "Other Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });

    const res = await app.request(`/v1/agents/${created.id}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });
});

describe("POST /v1/agents/:id (update)", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("updates an agent with partial fields", async () => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });

    const res = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated Agent" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Updated Agent");
    expect(body.model).toBe("claude-3");
    expect(body.runtime).toBe("claude-code");
  });

  it("enforces the documented update types before persisting changes", async () => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });

    const res = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tools: "not-an-array",
        sandbox: "not-an-object",
      }),
    });

    expect(res.status).toBe(400);
    expect(await agentStore.getById(created.id)).toMatchObject({
      tools: undefined,
      sandbox: undefined,
    });
  });

  it("returns a safe managed reference for a persisted legacy RDS connection", async () => {
    const { app, agentStore } = createTestApp();
    const mcpServers = [
      {
        name: "rds-mcp",
        url: "https://campaign.welltop.tech/agent/mcp/rds",
        transport: "streamable-http" as const,
        headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
      },
    ];
    const created = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "openai-codex/gpt-5.5",
      system: "You are helpful",
      runtime: "pi-agent",
      mcpServers,
    });

    const res = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed Agent" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mcpServers).toEqual([{
      catalogId: "rds-mcp",
      name: "rds-mcp",
    }]);
    expect(JSON.stringify(body)).not.toContain("campaign.welltop.tech");
    expect(JSON.stringify(body)).not.toContain("RDS_MCP_APIKEY");
  });

  it("rejects replacing an Agent MCP list with a raw RDS connection", async () => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "openai-codex/gpt-5.5",
      system: "You are helpful",
      runtime: "pi-agent",
    });
    const mcpServers = [
      {
        name: "rds-mcp",
        url: "https://campaign.welltop.tech/agent/mcp/rds",
        transport: "streamable-http",
        headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
      },
    ];

    const res = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mcpServers }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects a Supabase MCP update outside the tenant allowlist", async () => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "openai-codex/gpt-5.5",
      system: "You are helpful",
      runtime: "pi-agent",
    });
    process.env.OMA_SUPABASE_ALLOWED_TENANTS = "another-tenant";

    const res = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mcpServers: [{
          catalogId: "aliyun-rds-supabase",
          name: "session-data",
        }],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "mcpServers[0].catalogId is not available for this tenant",
    });
  });

  it.each([
    {
      label: "a non-array value",
      mcpServers: { name: "rds-mcp", url: "https://example.com/mcp" },
    },
    {
      label: "a non-object entry",
      mcpServers: [null],
    },
    {
      label: "an empty name",
      mcpServers: [{ name: "", url: "https://example.com/mcp" }],
    },
    {
      label: "duplicate names",
      mcpServers: [
        { name: "rds-mcp", url: "https://example.com/one" },
        { name: "rds-mcp", url: "https://example.com/two" },
      ],
    },
    {
      label: "an invalid URL",
      mcpServers: [{ name: "rds-mcp", url: "not a url" }],
    },
    {
      label: "an unsupported transport",
      mcpServers: [
        { name: "rds-mcp", url: "https://example.com/mcp", transport: "stdio" },
      ],
    },
    {
      label: "non-object headers",
      mcpServers: [
        { name: "rds-mcp", url: "https://example.com/mcp", headers: null },
      ],
    },
    {
      label: "a non-string header value",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://example.com/mcp",
          headers: { Authorization: false },
        },
      ],
    },
    {
      label: "a header name containing CR/LF",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://example.com/mcp",
          headers: { "X-Test\rInjected": "value" },
        },
      ],
    },
    {
      label: "a header value containing CR/LF",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer safe\nX-Injected: yes" },
        },
      ],
    },
  ])("returns 400 when an MCP update contains $label", async ({ mcpServers }) => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "openai-codex/gpt-5.5",
      system: "You are helpful",
      runtime: "pi-agent",
    });

    const res = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mcpServers }),
    });

    expect(res.status).toBe(400);
  });

  it.each([
    {
      label: "a different server name",
      mcpServers: [
        {
          name: "other-mcp",
          url: "https://campaign.welltop.tech/agent/mcp/rds",
          transport: "streamable-http",
          headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
        },
      ],
    },
    {
      label: "a different URL",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://example.com/mcp",
          transport: "streamable-http",
          headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
        },
      ],
    },
    {
      label: "SSE transport",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://campaign.welltop.tech/agent/mcp/rds",
          transport: "sse",
          headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
        },
      ],
    },
    {
      label: "an omitted transport",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://campaign.welltop.tech/agent/mcp/rds",
          headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
        },
      ],
    },
    {
      label: "missing headers",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://campaign.welltop.tech/agent/mcp/rds",
          transport: "streamable-http",
        },
      ],
    },
    {
      label: "a different token expression",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://campaign.welltop.tech/agent/mcp/rds",
          transport: "streamable-http",
          headers: { Authorization: "Bearer ${OTHER_TOKEN}" },
        },
      ],
    },
    {
      label: "an extra header",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://campaign.welltop.tech/agent/mcp/rds",
          transport: "streamable-http",
          headers: {
            Authorization: "Bearer ${RDS_MCP_APIKEY}",
            "X-Extra": "value",
          },
        },
      ],
    },
  ])("returns 400 for $label outside the MCP update allowlist", async ({ mcpServers }) => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "openai-codex/gpt-5.5",
      system: "You are helpful",
      runtime: "pi-agent",
    });

    const res = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mcpServers }),
    });

    expect(res.status).toBe(400);
  });

  it("clears MCP servers when updated with an empty array", async () => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "openai-codex/gpt-5.5",
      system: "You are helpful",
      runtime: "pi-agent",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://campaign.welltop.tech/agent/mcp/rds",
          transport: "streamable-http",
          headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
        },
      ],
    });

    const res = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mcpServers: [] }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).mcpServers).toEqual([]);
  });

  it("updates the description (and can clear it with an empty string)", async () => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      description: "Initial blurb",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });

    const set = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "New blurb" }),
    });
    expect(set.status).toBe(200);
    expect((await set.json()).description).toBe("New blurb");

    const cleared = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "" }),
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).description).toBe("");
  });

  it("returns 400 when update description is not a string", async () => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });
    const res = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: 42 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("description must be a string");
  });

  it("updates runtime field", async () => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });

    const res = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: "codex" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runtime).toBe("codex");
  });

  it("returns 400 for invalid runtime in update", async () => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });

    const res = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: "bad-runtime" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("runtime must be one of");
  });

  it("returns 404 for non-existent agent", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents/agent_999", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  it("returns 404 for agent belonging to different tenant", async () => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "other-tenant",
      name: "Other Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });

    const res = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Hacked" }),
    });

    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid JSON body", async () => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });

    const res = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    expect(res.status).toBe(400);
  });
});

describe("DELETE /v1/agents/:id", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("deletes an agent", async () => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "dev",
      name: "My Agent",
      model: "claude-3",
      system: "You are helpful",
      runtime: "claude-code",
    });

    const res = await app.request(`/v1/agents/${created.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("agent_deleted");
    expect(body.id).toBe(created.id);

    // Verify it's actually deleted
    const getRes = await app.request(`/v1/agents/${created.id}`);
    expect(getRes.status).toBe(404);
  });

  it("returns 404 for non-existent agent", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/agents/agent_999", {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  it("returns 404 for agent belonging to different tenant", async () => {
    const { app, agentStore } = createTestApp();
    const created = await agentStore.create({
      tenantId: "other-tenant",
      name: "Other Agent",
      model: "claude-3",
      system: "sys",
      runtime: "claude-code",
    });

    const res = await app.request(`/v1/agents/${created.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
  });
});
