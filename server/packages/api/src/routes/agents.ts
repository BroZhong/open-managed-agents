import { Hono } from "hono";
import type { AgentStore, Runtime } from "@oma-server/store";
import type { TenantContext } from "../types.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

const VALID_RUNTIMES: readonly Runtime[] = ["claude-code", "codex", "pi-agent", "mock"];
const ALLOWED_MCP_SERVER = {
  name: "rds-mcp",
  url: "https://campaign.welltop.tech/agent/mcp/rds",
  transport: "streamable-http",
  authorization: "Bearer ${RDS_MCP_APIKEY}",
} as const;

function validateMcpServers(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "mcpServers must be an array";
  if (value.length > 1) {
    return "mcpServers may only contain the allowlisted rds-mcp server";
  }

  const names = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const candidate = value[index];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return `mcpServers[${index}] must be an object`;
    }

    const server = candidate as Record<string, unknown>;
    const name = server.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      return `mcpServers[${index}].name must be a non-empty string`;
    }
    const uniqueName = name.trim();
    if (names.has(uniqueName)) {
      return `mcpServers contains duplicate name: ${uniqueName}`;
    }
    names.add(uniqueName);

    const url = server.url;
    if (typeof url !== "string") {
      return `mcpServers[${index}].url must be a valid http/https URL`;
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return `mcpServers[${index}].url must be a valid http/https URL`;
      }
    } catch {
      return `mcpServers[${index}].url must be a valid http/https URL`;
    }

    const transport = server.transport;
    if (
      transport !== undefined &&
      transport !== "sse" &&
      transport !== "streamable-http"
    ) {
      return `mcpServers[${index}].transport must be sse or streamable-http`;
    }

    const headers = server.headers;
    if (headers !== undefined) {
      if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
        return `mcpServers[${index}].headers must be an object of string values`;
      }
      for (const [headerName, headerValue] of Object.entries(headers)) {
        if (typeof headerValue !== "string") {
          return `mcpServers[${index}].headers must be an object of string values`;
        }
        if (/\r|\n/.test(headerName) || /\r|\n/.test(headerValue)) {
          return `mcpServers[${index}].headers must not contain CR or LF`;
        }
      }
    }

    if (
      name !== ALLOWED_MCP_SERVER.name ||
      url !== ALLOWED_MCP_SERVER.url ||
      transport !== ALLOWED_MCP_SERVER.transport
    ) {
      return `mcpServers[${index}] is not an allowlisted MCP server`;
    }

    const headerEntries =
      headers && typeof headers === "object" && !Array.isArray(headers)
        ? Object.entries(headers)
        : [];
    if (
      headerEntries.length !== 1 ||
      headerEntries[0]?.[0] !== "Authorization" ||
      headerEntries[0]?.[1] !== ALLOWED_MCP_SERVER.authorization
    ) {
      return `mcpServers[${index}].headers must contain only the allowlisted Authorization value`;
    }
  }
}

export function agentRoutes(agentStore: AgentStore) {
  const router = new Hono<Env>();

  // POST /v1/agents — Create agent
  router.post("/v1/agents", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { name, description, model, system, runtime, tools, mcpServers, skills, sandbox } = body;

    if (!name || typeof name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }
    if (description !== undefined && typeof description !== "string") {
      return c.json({ error: "description must be a string" }, 400);
    }
    if (!model || typeof model !== "string") {
      return c.json({ error: "model is required" }, 400);
    }
    if (!system || typeof system !== "string") {
      return c.json({ error: "system is required" }, 400);
    }
    if (!runtime || typeof runtime !== "string") {
      return c.json({ error: "runtime is required" }, 400);
    }
    if (!VALID_RUNTIMES.includes(runtime as Runtime)) {
      return c.json(
        { error: `runtime must be one of: ${VALID_RUNTIMES.join(", ")}` },
        400,
      );
    }
    if (tools !== undefined && !Array.isArray(tools)) {
      return c.json({ error: "tools must be an array" }, 400);
    }
    if (mcpServers !== undefined) {
      const error = validateMcpServers(mcpServers);
      if (error) return c.json({ error }, 400);
    }
    if (skills !== undefined && !Array.isArray(skills)) {
      return c.json({ error: "skills must be an array" }, 400);
    }

    const tenant = c.get("tenant");
    const agent = await agentStore.create({
      tenantId: tenant.tenantId,
      name,
      description,
      model,
      system,
      runtime: runtime as Runtime,
      tools,
      mcpServers,
      skills,
      sandbox,
    });

    return c.json(agent, 201);
  });

  // GET /v1/agents — List agents
  router.get("/v1/agents", async (c) => {
    const tenant = c.get("tenant");
    const limitParam = c.req.query("limit");
    const cursor = c.req.query("cursor");

    let limit = 50;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 100);
      }
    }

    const result = await agentStore.list(tenant.tenantId, {
      limit,
      cursor: cursor || undefined,
    });

    const response: Record<string, unknown> = {
      data: result.data,
      has_more: result.hasMore,
    };

    if (result.hasMore && result.data.length > 0) {
      response.next_cursor = result.data[result.data.length - 1].id;
    }

    return c.json(response);
  });

  // GET /v1/agents/:id — Get agent
  router.get("/v1/agents/:id", async (c) => {
    const id = c.req.param("id");
    const agent = await agentStore.getById(id);

    if (!agent) {
      return c.json({ error: "Not found" }, 404);
    }

    // Ensure tenant isolation
    const tenant = c.get("tenant");
    if (agent.tenantId !== tenant.tenantId) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json(agent);
  });

  // POST /v1/agents/:id — Update agent
  router.post("/v1/agents/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // Verify agent exists and belongs to tenant
    const existing = await agentStore.getById(id);
    if (!existing) {
      return c.json({ error: "Not found" }, 404);
    }

    const tenant = c.get("tenant");
    if (existing.tenantId !== tenant.tenantId) {
      return c.json({ error: "Not found" }, 404);
    }

    // Validate runtime if provided
    if (body.runtime !== undefined) {
      if (!VALID_RUNTIMES.includes(body.runtime as any)) {
        return c.json(
          { error: `runtime must be one of: ${VALID_RUNTIMES.join(", ")}` },
          400,
        );
      }
    }

    if (body.description !== undefined && typeof body.description !== "string") {
      return c.json({ error: "description must be a string" }, 400);
    }

    if (body.mcpServers !== undefined) {
      const error = validateMcpServers(body.mcpServers);
      if (error) return c.json({ error }, 400);
    }

    const updateInput: Record<string, unknown> = {};
    if (body.name !== undefined) updateInput.name = body.name;
    if (body.description !== undefined) updateInput.description = body.description;
    if (body.model !== undefined) updateInput.model = body.model;
    if (body.system !== undefined) updateInput.system = body.system;
    if (body.runtime !== undefined) updateInput.runtime = body.runtime;
    if (body.tools !== undefined) updateInput.tools = body.tools;
    if (body.mcpServers !== undefined) updateInput.mcpServers = body.mcpServers;
    if (body.skills !== undefined) updateInput.skills = body.skills;
    if (body.sandbox !== undefined) updateInput.sandbox = body.sandbox;

    const updated = await agentStore.update(id, updateInput);
    if (!updated) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json(updated);
  });

  // DELETE /v1/agents/:id — Delete agent
  router.delete("/v1/agents/:id", async (c) => {
    const id = c.req.param("id");

    // Verify agent exists and belongs to tenant
    const existing = await agentStore.getById(id);
    if (!existing) {
      return c.json({ error: "Not found" }, 404);
    }

    const tenant = c.get("tenant");
    if (existing.tenantId !== tenant.tenantId) {
      return c.json({ error: "Not found" }, 404);
    }

    const deleted = await agentStore.delete(id);
    if (!deleted) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json({ type: "agent_deleted", id });
  });

  return router;
}
