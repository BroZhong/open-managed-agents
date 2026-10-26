import type { OpenAPIHono } from "@hono/zod-openapi";
import { RUNTIMES, type AgentStore, type Runtime } from "@oma-server/store";
import type { TenantContext } from "../types.js";
import {
  normalizeManagedMcpRefs,
} from "@oma-server/mcp-catalog";
import { publicAgent } from "../lib/public-projection.js";
import { EnvironmentError, type EnvironmentService } from "../lib/environments.js";
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

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * `sandbox` holds whether the Agent runs in a Sandbox, nothing else: what it
 * runs is the Agent's Environment (ADR-0024), which replaced `sandbox.image`
 * and `sandbox.env`.
 */
function validateSandbox(value: unknown): { error: string; code: string } | undefined {
  const invalid = (error: string) => ({ error, code: "validation_error" });
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("sandbox must be an object");
  const sandbox = value as Record<string, unknown>;
  if (sandbox.image !== undefined) {
    return { error: "sandbox.image was removed: bind an Environment with environmentId instead", code: "sandbox_image_removed" };
  }
  if (sandbox.env !== undefined) {
    return { error: "sandbox.env was removed: set the variables on an Environment and bind it with environmentId instead", code: "sandbox_env_removed" };
  }
  if (sandbox.enabled !== undefined && typeof sandbox.enabled !== "boolean") return invalid("sandbox.enabled must be a boolean");
}

const sandboxed = (sandbox: unknown) => (sandbox as { enabled?: unknown } | undefined)?.enabled !== false;

/**
 * Agents, each bound to the Environment its new Sessions run in (ADR-0024).
 * A Sandboxed Agent always has one: naming none binds the default,
 * video-production. Without `environments` none can be bound.
 */
export function agentRoutes(agentStore: AgentStore, environments?: Pick<EnvironmentService, "bindable" | "defaultFor">): OpenAPIHono<Env> {
  const router = createContractRouter<Env>();
  /**
   * The Environment an Agent is bound to by a write that sends `requested`
   * (undefined when it sends none). Every binding, a resent one too, must
   * serve an image (`EnvironmentService.bindable`). A Sandboxed Agent that
   * has none gets the default; null (an Agent without a Sandbox only)
   * unbinds. Undefined: no change.
   */
  const binding = async (tenantId: string, requested: unknown, inSandbox: boolean, current?: string): Promise<string | null | undefined> => {
    if (requested === undefined) {
      if (!inSandbox || current || !environments) return undefined;
      return environments.defaultFor(tenantId);
    }
    if (requested === null) {
      if (inSandbox) throw new EnvironmentError(400, "environment_required", "A Sandboxed Agent runs in an Environment: name one, or send none for video-production");
      return null;
    }
    if (typeof requested !== "string" || !requested) {
      throw new EnvironmentError(400, "validation_error", "environmentId must be an Environment id or null");
    }
    if (!environments) throw new EnvironmentError(404, "environment_not_found", "Environment not found");
    return (await environments.bindable(tenantId, requested)).id;
  };

  // POST /v1/agents — Create agent
  registerContractRoute(router, getOpenApiRoute("createAgent"), async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { name, description, model, thinking, system, runtime, tools, mcpServers, skills, sandbox, environmentId } = body;
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
    if (thinking != null && !VALID_THINKING_LEVELS.includes(thinking)) {
      return c.json({ error: `thinking must be one of: ${VALID_THINKING_LEVELS.join(", ")}` }, 400);
    }
    if (!runtime || typeof runtime !== "string") {
      return c.json({ error: "runtime is required" }, 400);
    }
    if (!RUNTIMES.includes(runtime as Runtime)) {
      return c.json(
        { error: `runtime must be one of: ${RUNTIMES.join(", ")}` },
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
    if (sandbox !== undefined) {
      const invalid = validateSandbox(sandbox);
      if (invalid) return c.json(invalid, 400);
    }
    const bound = await binding(tenant.tenantId, environmentId, sandboxed(sandbox));

    const agent = await agentStore.create({
      tenantId: tenant.tenantId,
      name,
      description,
      model,
      thinking,
      system,
      runtime: runtime as Runtime,
      tools,
      mcpServers: normalizedMcpServers,
      skills,
      sandbox,
      ...(bound ? { environmentId: bound } : {}),
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
      if (!RUNTIMES.includes(body.runtime as any)) {
        return c.json(
          { error: `runtime must be one of: ${RUNTIMES.join(", ")}` },
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
    if (body.sandbox !== undefined) {
      const invalid = validateSandbox(body.sandbox);
      if (invalid) return c.json(invalid, 400);
    }
    if (body.name !== undefined) updateInput.name = body.name;
    if (body.description !== undefined) updateInput.description = body.description;
    if (body.model !== undefined) updateInput.model = body.model;
    if (body.thinking !== undefined) {
      if (body.thinking !== null && !VALID_THINKING_LEVELS.includes(body.thinking)) {
        return c.json({ error: `thinking must be one of: ${VALID_THINKING_LEVELS.join(", ")}` }, 400);
      }
      updateInput.thinking = body.thinking;
    }
    if (body.system !== undefined) updateInput.system = body.system;
    if (body.runtime !== undefined) updateInput.runtime = body.runtime;
    if (body.tools !== undefined) updateInput.tools = body.tools;
    if (body.mcpServers !== undefined) updateInput.mcpServers = body.mcpServers;
    if (body.skills !== undefined) updateInput.skills = body.skills;
    if (body.sandbox !== undefined) updateInput.sandbox = body.sandbox;
    const bound = await binding(tenant.tenantId, body.environmentId, sandboxed(body.sandbox ?? existing.sandbox), existing.environmentId);
    if (bound !== undefined) updateInput.environmentId = bound;

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
