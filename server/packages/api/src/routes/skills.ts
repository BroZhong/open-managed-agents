import { Hono } from "hono";
import type { Context } from "hono";
import type { SkillStore, SkillArtifactStore } from "@oma-server/store";
import type { TenantContext } from "../types.js";
import { detectSkills, type DroppedFile } from "../skills/detect-skills.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

/**
 * Skill Library routes: a tenant-scoped Library of reusable, instruction-only
 * Skills (a directory with a SKILL.md). Metadata lives in `skillStore`; file
 * bodies live in S3 under `<tenantId>/skills/<skillId>/…` via `skillArtifacts`.
 * Listing returns only Library Skills; equipping (which forks a Library Skill
 * onto an Agent, ADR-0004) lives on the Agent routes. The `:id/files/*`
 * endpoints edit any Skill the tenant owns — a Library Skill or an Agent fork.
 *
 * Upload wire shape for POST /v1/skills — `multipart/form-data`:
 *   - `paths`: a JSON array of root-relative file paths (string[]).
 *   - `files`: one File entry per path, in the SAME order as `paths`.
 * The dropped folder's tree is flattened client-side into (path, file) pairs;
 * the server re-runs the single/multi-Skill detection (server-authoritative).
 */
export function skillRoutes(skillStore: SkillStore, skillArtifacts: SkillArtifactStore) {
  const router = new Hono<Env>();

  // POST /v1/skills — upload a dropped folder → create N Skills
  router.post("/v1/skills", async (c) => {
    const tenant = c.get("tenant");

    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: "Expected multipart/form-data" }, 400);

    const pathsRaw = form.get("paths");
    if (typeof pathsRaw !== "string") {
      return c.json({ error: "paths (JSON array) is required" }, 400);
    }
    let paths: string[];
    try {
      paths = JSON.parse(pathsRaw);
      if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) throw new Error();
    } catch {
      return c.json({ error: "paths must be a JSON array of strings" }, 400);
    }

    const fileEntries = form.getAll("files").filter((f): f is File => f instanceof File);
    if (fileEntries.length !== paths.length) {
      return c.json({ error: "files and paths length mismatch" }, 400);
    }

    const dropped: DroppedFile[] = [];
    for (let i = 0; i < paths.length; i++) {
      const content = await fileEntries[i].text();
      dropped.push({ path: paths[i], content });
    }

    const detected = detectSkills(dropped);
    if (!detected.ok) return c.json({ error: detected.error }, 400);

    const created = [];
    for (const skill of detected.skills) {
      const row = await skillStore.create({
        tenantId: tenant.tenantId,
        name: skill.name,
        description: skill.description,
      });
      for (const file of skill.files) {
        await skillArtifacts.put(tenant.tenantId, row.id, file.path, file.content);
      }
      created.push(row);
    }

    return c.json({ data: created }, 201);
  });

  // GET /v1/skills — list the tenant's Library
  router.get("/v1/skills", async (c) => {
    const tenant = c.get("tenant");
    const limitParam = c.req.query("limit");
    const cursor = c.req.query("cursor");
    let limit = 50;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed > 0) limit = Math.min(parsed, 100);
    }

    const result = await skillStore.list(tenant.tenantId, { limit, cursor: cursor || undefined });
    const response: Record<string, unknown> = {
      data: result.data.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        updatedAt: s.updatedAt,
      })),
      has_more: result.hasMore,
    };
    if (result.hasMore && result.data.length > 0) {
      response.next_cursor = result.data[result.data.length - 1].id;
    }
    return c.json(response);
  });

  // GET /v1/skills/:id — metadata + file list
  router.get("/v1/skills/:id", async (c) => {
    const skill = await requireOwned(c, skillStore);
    if (!skill) return c.json({ error: "Not found" }, 404);
    const files = await skillArtifacts.list(skill.tenantId, skill.id);
    return c.json({ ...skill, files });
  });

  // POST /v1/skills/:id — update metadata
  router.post("/v1/skills/:id", async (c) => {
    const existing = await requireOwned(c, skillStore);
    if (!existing) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);
    const update: { name?: string; description?: string } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string") return c.json({ error: "name must be a string" }, 400);
      update.name = body.name;
    }
    if (body.description !== undefined) {
      if (typeof body.description !== "string") return c.json({ error: "description must be a string" }, 400);
      update.description = body.description;
    }
    const updated = await skillStore.update(existing.id, update);
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json(updated);
  });

  // DELETE /v1/skills/:id — remove from Library + S3
  router.delete("/v1/skills/:id", async (c) => {
    const existing = await requireOwned(c, skillStore);
    if (!existing) return c.json({ error: "Not found" }, 404);
    await skillArtifacts.deleteTree(existing.tenantId, existing.id);
    const deleted = await skillStore.delete(existing.id);
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return c.json({ type: "skill_deleted", id: existing.id });
  });

  // --- Skill directory file operations (issue #73) ------------------------
  // These endpoints work uniformly for a Library Skill or an Agent's fork —
  // both are resolved by id and gated by tenant ownership, so editing a fork
  // (on the Agent page) never touches the Library Skill and vice versa.

  // GET /v1/skills/:id/files — file tree (paths only)
  router.get("/v1/skills/:id/files", async (c) => {
    const skill = await requireOwned(c, skillStore);
    if (!skill) return c.json({ error: "Not found" }, 404);
    const files = await skillArtifacts.list(skill.tenantId, skill.id);
    return c.json({ data: files, has_more: false });
  });

  // GET /v1/skills/:id/files/content?path=… — read one file's text
  router.get("/v1/skills/:id/files/content", async (c) => {
    const skill = await requireOwned(c, skillStore);
    if (!skill) return c.json({ error: "Not found" }, 404);
    const path = safePath(c.req.query("path"));
    if (!path) return c.json({ error: "path is required" }, 400);
    const bytes = await skillArtifacts.get(skill.tenantId, skill.id, path);
    if (!bytes) return c.json({ error: "Not found" }, 404);
    return c.json({ path, content: new TextDecoder().decode(bytes) });
  });

  // PUT /v1/skills/:id/files/content — write (create or overwrite) one file
  //   body: { path: string, content: string }
  router.put("/v1/skills/:id/files/content", async (c) => {
    const skill = await requireOwned(c, skillStore);
    if (!skill) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json().catch(() => null);
    const path = safePath(body?.path);
    if (!path) return c.json({ error: "path is required" }, 400);
    if (typeof body.content !== "string") {
      return c.json({ error: "content is required" }, 400);
    }
    await skillArtifacts.put(skill.tenantId, skill.id, path, body.content);
    await skillStore.update(skill.id, {}); // bump updatedAt
    return c.json({ path, content: body.content });
  });

  // DELETE /v1/skills/:id/files/content?path=… — delete one file
  router.delete("/v1/skills/:id/files/content", async (c) => {
    const skill = await requireOwned(c, skillStore);
    if (!skill) return c.json({ error: "Not found" }, 404);
    const path = safePath(c.req.query("path"));
    if (!path) return c.json({ error: "path is required" }, 400);
    await skillArtifacts.delete(skill.tenantId, skill.id, path);
    await skillStore.update(skill.id, {});
    return c.json({ type: "skill_file_deleted", id: skill.id, path });
  });

  // POST /v1/skills/:id/files/rename — rename/move one file within the Skill
  //   body: { from: string, to: string }
  router.post("/v1/skills/:id/files/rename", async (c) => {
    const skill = await requireOwned(c, skillStore);
    if (!skill) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json().catch(() => null);
    const from = safePath(body?.from);
    const to = safePath(body?.to);
    if (!from || !to) return c.json({ error: "from and to are required" }, 400);
    const src = await skillArtifacts.get(skill.tenantId, skill.id, from);
    if (!src) return c.json({ error: "Not found" }, 404);
    await skillArtifacts.move(skill.tenantId, skill.id, from, to);
    await skillStore.update(skill.id, {});
    return c.json({ type: "skill_file_renamed", id: skill.id, from, to });
  });

  return router;
}

/**
 * Validate a Skill-relative file path from the client. Rejects empty,
 * absolute, and traversal (`.`/`..`) paths so a request can never escape the
 * Skill's own directory. Returns the normalized path, or null if invalid.
 */
function safePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.replace(/^\/+/, "").trim();
  if (!trimmed) return null;
  const segments = trimmed.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return trimmed;
}

/** Resolve the Skill by :id and confirm it belongs to the caller's tenant. */
async function requireOwned(c: Context<Env>, skillStore: SkillStore) {
  const id = c.req.param("id");
  if (!id) return null;
  const skill = await skillStore.getById(id);
  const tenant = c.get("tenant");
  if (!skill || skill.tenantId !== tenant.tenantId) return null;
  return skill;
}
