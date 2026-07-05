import { Hono } from "hono";
import type { Context } from "hono";
import type { AgentFileStore, AgentStore } from "@oma-server/store";
import type { TenantContext } from "../types.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

/**
 * The canonical Agent File names. The session-router assembles them into the
 * runtime's system prompt in the fixed order IDENTITY → SOUL → USER → MEMORY.
 * Restricting to this set keeps a File from ever colliding with a Workspace
 * path and matches what the assembler reads.
 */
export const AGENT_FILE_NAMES = ["IDENTITY", "SOUL", "USER", "MEMORY"] as const;
const VALID_FILENAMES = new Set<string>(AGENT_FILE_NAMES);

/**
 * Routes for an Agent's Files — small editable markdown documents that shape
 * its persona/instructions, isolated per (tenant, agent). Every route first
 * resolves the Agent and enforces tenant ownership (cross-tenant → 404), so a
 * File can only ever be reached through an Agent the caller owns.
 */
export function agentFileRoutes(agentFileStore: AgentFileStore, agentStore: AgentStore) {
  const router = new Hono<Env>();

  /** Resolve the Agent and confirm it belongs to the caller's tenant. */
  async function ownedAgent(c: Context<Env>) {
    const agentId = c.req.param("id");
    if (!agentId) return null;
    const agent = await agentStore.getById(agentId);
    const tenant = c.get("tenant");
    if (!agent || agent.tenantId !== tenant.tenantId) return null;
    return { agentId, tenantId: tenant.tenantId };
  }

  // GET /v1/agents/:id/files — list an Agent's Files (metadata only)
  router.get("/v1/agents/:id/files", async (c) => {
    const owned = await ownedAgent(c);
    if (!owned) return c.json({ error: "Not found" }, 404);

    // Agent Files are a small fixed set — returned in full, never paginated.
    const files = await agentFileStore.list(owned.tenantId, owned.agentId);
    return c.json({ data: files, has_more: false });
  });

  // GET /v1/agents/:id/files/:filename — read one File's content
  router.get("/v1/agents/:id/files/:filename", async (c) => {
    const owned = await ownedAgent(c);
    if (!owned) return c.json({ error: "Not found" }, 404);

    const filename = c.req.param("filename");
    if (!filename) return c.json({ error: "Not found" }, 404);
    const file = await agentFileStore.get(owned.tenantId, owned.agentId, filename);
    if (!file) return c.json({ error: "Not found" }, 404);
    return c.json(file);
  });

  // POST /v1/agents/:id/files/:filename — upsert a File's content
  router.post("/v1/agents/:id/files/:filename", async (c) => {
    const owned = await ownedAgent(c);
    if (!owned) return c.json({ error: "Not found" }, 404);

    const filename = c.req.param("filename");
    if (!filename || !VALID_FILENAMES.has(filename)) {
      return c.json(
        { error: `filename must be one of: ${AGENT_FILE_NAMES.join(", ")}` },
        400,
      );
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.content !== "string") {
      return c.json({ error: "content is required" }, 400);
    }

    const file = await agentFileStore.upsert(
      owned.tenantId,
      owned.agentId,
      filename,
      body.content,
    );
    return c.json(file);
  });

  // DELETE /v1/agents/:id/files/:filename
  router.delete("/v1/agents/:id/files/:filename", async (c) => {
    const owned = await ownedAgent(c);
    if (!owned) return c.json({ error: "Not found" }, 404);

    const filename = c.req.param("filename");
    if (!filename) return c.json({ error: "Not found" }, 404);
    const deleted = await agentFileStore.delete(owned.tenantId, owned.agentId, filename);
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return c.json({ type: "agent_file_deleted", agentId: owned.agentId, filename });
  });

  return router;
}
