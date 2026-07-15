import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AgentStore, Runtime } from "@oma-server/store";
import type { TenantContext } from "../types.js";
import {
  normalizeManagedMcpRefs,
} from "@oma-server/mcp-catalog";
import { publicAgent } from "../lib/public-projection.js";
import { getOpenApiRoute } from "../openapi/routes.js";
import {
  createContractRouter,
  registerContractRoute,
} from "../openapi/router.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

const VALID_RUNTIMES: readonly Runtime[] = ["claude-code", "codex", "pi-agent", "mock"];

export function agentRoutes(agentStore: AgentStore): OpenAPIHono<Env> {
  const router = createContractRouter<Env>();

  // POST /v1/agents — Create agent
  registerContractRoute(router, getOpenApiRoute("createAgent"), async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { name, description, model, system, runtime, tools, mcpServers, skills, sandbox } = body;
    const tenant = c.get("tenant");
    let normalizedMcpServers = mcpServers;

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
      const result = normalizeManagedMcpRefs(mcpServers, {
        tenantId: tenant.tenantId,
      });
      if ("error" in result) return c.json({ error: result.error }, 400);
      normalizedMcpServers = result.refs;
    }
    if (skills !== undefined && !Array.isArray(skills)) {
      return c.json({ error: "skills must be an array" }, 400);
    }

    const agent = await agentStore.create({
      tenantId: tenant.tenantId,
      name,
      description,
      model,
      system,
      runtime: runtime as Runtime,
      tools,
      mcpServers: normalizedMcpServers,
      skills,
      sandbox,
    });

    return c.json(publicAgent(agent), 201);
  });

  // GET /v1/agents — List agents
  registerContractRoute(router, getOpenApiRoute("listAgents"), async (c) => {
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
      data: result.data.map(publicAgent),
      has_more: result.hasMore,
    };

    if (result.hasMore && result.data.length > 0) {
      response.next_cursor = result.data[result.data.length - 1].id;
    }

    return c.json(response);
  });

  // GET /v1/agents/:id — Get agent
  registerContractRoute(router, getOpenApiRoute("getAgent"), async (c) => {
    const id = c.req.param("id")!;
    const agent = await agentStore.getById(id);

    if (!agent) {
      return c.json({ error: "Not found" }, 404);
    }

    // Ensure tenant isolation
    const tenant = c.get("tenant");
    if (agent.tenantId !== tenant.tenantId) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json(publicAgent(agent));
  });

  // POST /v1/agents/:id — Update agent
  registerContractRoute(router, getOpenApiRoute("updateAgent"), async (c) => {
    const id = c.req.param("id")!;
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
      const result = normalizeManagedMcpRefs(body.mcpServers, {
        tenantId: tenant.tenantId,
      });
      if ("error" in result) return c.json({ error: result.error }, 400);
      body.mcpServers = result.refs;
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

    return c.json(publicAgent(updated));
  });

  // DELETE /v1/agents/:id — Delete agent
  registerContractRoute(router, getOpenApiRoute("deleteAgent"), async (c) => {
    const id = c.req.param("id")!;

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
