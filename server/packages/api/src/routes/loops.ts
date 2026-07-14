import { Hono } from "hono";
import type { AgentStore, LoopStore } from "@oma-server/store";
import type { SessionRouter } from "@oma-server/session-router";
import type { TenantContext } from "../types.js";
import { publicSession } from "../lib/public-projection.js";

type Env = { Variables: { tenant: TenantContext } };

export interface LoopRouteDeps {
  agentStore: AgentStore;
  loopStore: LoopStore;
  sessionRouter?: SessionRouter;
  now?: () => Date;
}

function validateLoopBody(body: Record<string, unknown>, partial = false): string | undefined {
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return "name must be a non-empty string";
    }
  }
  if (!partial || body.prompt !== undefined) {
    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
      return "prompt must be a non-empty string";
    }
  }
  if (!partial || body.intervalMinutes !== undefined) {
    if (!Number.isInteger(body.intervalMinutes) || Number(body.intervalMinutes) < 5) {
      return "intervalMinutes must be an integer of at least 5";
    }
  }
  if (body.description !== undefined && typeof body.description !== "string") {
    return "description must be a string";
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return "enabled must be a boolean";
  }
}

export function loopRoutes(deps: LoopRouteDeps) {
  const router = new Hono<Env>();
  const now = deps.now ?? (() => new Date());

  router.get("/v1/agents/:agentId/loops", async (c) => {
    const tenant = c.get("tenant");
    const agent = await deps.agentStore.getById(c.req.param("agentId"));
    if (!agent || agent.tenantId !== tenant.tenantId) {
      return c.json({ error: "Agent not found" }, 404);
    }
    return c.json({ data: await deps.loopStore.list(tenant.tenantId, agent.id) });
  });

  router.post("/v1/agents/:agentId/loops", async (c) => {
    const tenant = c.get("tenant");
    const agent = await deps.agentStore.getById(c.req.param("agentId"));
    if (!agent || agent.tenantId !== tenant.tenantId) {
      return c.json({ error: "Agent not found" }, 404);
    }
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);
    const error = validateLoopBody(body);
    if (error) return c.json({ error }, 400);
    const loop = await deps.loopStore.create({
      tenantId: tenant.tenantId,
      agentId: agent.id,
      name: (body.name as string).trim(),
      description: body.description as string | undefined,
      prompt: (body.prompt as string).trim(),
      intervalMinutes: body.intervalMinutes as number,
      enabled: (body.enabled as boolean | undefined) ?? true,
      now: now(),
    });
    return c.json(loop, 201);
  });

  router.get("/v1/loops/:id", async (c) => {
    const tenant = c.get("tenant");
    const loop = await deps.loopStore.getById(c.req.param("id"));
    if (!loop || loop.tenantId !== tenant.tenantId) {
      return c.json({ error: "Loop not found" }, 404);
    }
    return c.json(loop);
  });

  router.post("/v1/loops/:id", async (c) => {
    const tenant = c.get("tenant");
    const loop = await deps.loopStore.getById(c.req.param("id"));
    if (!loop || loop.tenantId !== tenant.tenantId) {
      return c.json({ error: "Loop not found" }, 404);
    }
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);
    const error = validateLoopBody(body, true);
    if (error) return c.json({ error }, 400);
    const updated = await deps.loopStore.update(loop.id, tenant.tenantId, {
      ...(body.name === undefined ? {} : { name: (body.name as string).trim() }),
      ...(body.description === undefined ? {} : { description: body.description as string }),
      ...(body.prompt === undefined ? {} : { prompt: (body.prompt as string).trim() }),
      ...(body.intervalMinutes === undefined ? {} : { intervalMinutes: body.intervalMinutes as number }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled as boolean }),
      now: now(),
    });
    return c.json(updated!);
  });

  router.post("/v1/loops/:id/run", async (c) => {
    const tenant = c.get("tenant");
    const dispatched = await deps.loopStore.dispatchNow(
      c.req.param("id"),
      tenant.tenantId,
      now(),
    );
    if (!dispatched) return c.json({ error: "Loop not found" }, 404);
    void deps.sessionRouter
      ?.handleNewEvent(dispatched.session.id, dispatched.session.agent)
      .catch((error) => {
        console.error(`SessionRouter failed after Loop ${dispatched.loop.id} dispatch:`, error);
      });
    return c.json(publicSession(dispatched.session), 201);
  });

  return router;
}
