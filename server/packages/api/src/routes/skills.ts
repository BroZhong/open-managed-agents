import { packSkillBundle } from "@oma-server/store";
import { publicSkill } from "../lib/public-projection.js";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { SkillBundleStore, SkillStore } from "@oma-server/store";
import type { TenantContext } from "../types.js";
import { detectSkills, parseSkillMetadata, type DroppedFile } from "../skills/detect-skills.js";
import { SkillVersions } from "../skills/skill-versions.js";
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

/** The entry point every Skill keeps: uploads require it, and edits cannot remove it. */
const SKILL_MD = "SKILL.md";

/**
 * Skill Library routes: a tenant-scoped Library of reusable Skills (a
 * directory with a SKILL.md). Metadata and the current version live in
 * `skillStore`; each version's files are one immutable Skill Bundle in
 * `skillBundles` (ADR-0022), and every file change publishes a new bundle by
 * compare-and-set (see `SkillVersions`). Listing returns only Library Skills;
 * equipping (which forks a Library Skill onto an Agent, ADR-0004) lives on the
 * Agent routes. The `:id/files/*` endpoints edit any Skill the tenant owns — a
 * Library Skill or an Agent fork.
 *
 * Upload wire shape for POST /v1/skills — `multipart/form-data`:
 *   - `paths`: a JSON array of root-relative file paths (string[]).
 *   - `files`: one File entry per path, in the SAME order as `paths`.
 * The dropped folder's tree is flattened client-side into (path, file) pairs;
 * the server re-runs the single/multi-Skill detection (server-authoritative).
 * Files are stored byte for byte; `.pyc` and `__pycache__` are left out.
 */
export function skillRoutes(
  skillStore: SkillStore,
  skillBundles: SkillBundleStore,
): OpenAPIHono<Env> {
  const router = createContractRouter<Env>();
  const versions = new SkillVersions(skillStore, skillBundles);

  // POST /v1/skills — upload a dropped folder → create N Skills
  registerContractRoute(router, getOpenApiRoute("uploadSkills"), async (c) => {
    const tenant = c.get("tenant");

    let form: FormData | null = null;
    try {
      // OpenAPI validation may already have populated Hono's body cache with a
      // concrete FormData object; `await` supports both that and a Promise.
      form = await c.req.formData();
    } catch {
      form = null;
    }
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
      // Bytes, never text(): decoding corrupts fonts and other binary files.
      dropped.push({ path: paths[i], body: new Uint8Array(await fileEntries[i].arrayBuffer()) });
    }

    const detected = detectSkills(dropped);
    if (!detected.ok) return c.json({ error: detected.error }, 400);

    // A replacement is based on the version read here: capture it as a value.
    const existing = await skillStore.listByOwner(tenant.tenantId, "library", tenant.tenantId);
    const byName = new Map(existing.map((skill) => [skill.name, { id: skill.id, bundleSha256: skill.bundleSha256 }]));
    const incoming = new Map<string, (typeof detected.skills)[number]>();
    const conflicts = new Set<string>();
    for (const skill of detected.skills) {
      if (byName.has(skill.name) || incoming.has(skill.name)) conflicts.add(skill.name);
      incoming.set(skill.name, skill);
    }
    if (conflicts.size && form.get("overwrite") !== "true") {
      return c.json({
        error: `Skills already exist: ${[...conflicts].join(", ")}. Replace them with the uploaded files?`,
        code: "skill_name_conflict",
      }, 409);
    }

    // Pack every Skill before writing anything, so an invalid or oversized
    // Skill rejects the whole upload.
    const packed = [];
    for (const skill of incoming.values()) packed.push({ skill, bundle: await packSkillBundle(skill.files) });

    // A Skill row is written only with its stored bundle: a failure leaves no
    // half-created Skill, and a replacement keeps the old version until its
    // compare-and-set succeeds.
    const created = [];
    for (const { skill, bundle } of packed) {
      const version = await versions.store(tenant.tenantId, bundle);
      const previous = byName.get(skill.name);
      created.push(previous
        ? await skillStore.update(previous.id, { description: skill.description, ...version },
          { expectedBundleSha256: previous.bundleSha256 })
        : await skillStore.create({
          tenantId: tenant.tenantId,
          name: skill.name,
          description: skill.description,
          ...version,
        }));
    }

    return c.json({ data: created.map((skill) => skill && publicSkill(skill)) }, 201);
  });

  // GET /v1/skills — list the tenant's Library
  registerContractRoute(router, getOpenApiRoute("listSkills"), async (c) => {
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
        createdAt: s.createdAt,
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
  registerContractRoute(router, getOpenApiRoute("getSkill"), async (c) => {
    const skill = await requireOwned(c, skillStore);
    if (!skill) return c.json({ error: "Not found" }, 404);
    return c.json({ ...publicSkill(skill), files: await versions.paths(skill) });
  });

  // POST /v1/skills/:id — update metadata. No file changes, so the version
  // stays; the compare-and-set still rejects a metadata change based on a
  // version that a concurrent file edit has replaced.
  registerContractRoute(router, getOpenApiRoute("updateSkill"), async (c) => {
    const existing = await requireOwned(c, skillStore);
    if (!existing) return c.json({ error: "Not found" }, 404);
    const version = existing.bundleSha256;

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
    const updated = await skillStore.update(existing.id, update, { expectedBundleSha256: version });
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json(publicSkill(updated));
  });

  // DELETE /v1/skills/:id — remove the Skill. Its bundles stay: they are
  // content-addressed and may be the current version of a fork (GC is #273).
  registerContractRoute(router, getOpenApiRoute("deleteSkill"), async (c) => {
    const existing = await requireOwned(c, skillStore);
    if (!existing) return c.json({ error: "Not found" }, 404);
    const deleted = await skillStore.delete(existing.id);
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return c.json({ type: "skill_deleted", id: existing.id });
  });

  // --- Skill directory file operations (issue #73) ------------------------
  // These endpoints work uniformly for a Library Skill or an Agent's fork —
  // both are resolved by id and gated by tenant ownership, so editing a fork
  // (on the Agent page) never touches the Library Skill and vice versa.

  // GET /v1/skills/:id/files — file tree (paths only)
  registerContractRoute(router, getOpenApiRoute("listSkillFiles"), async (c) => {
    const skill = await requireOwned(c, skillStore);
    if (!skill) return c.json({ error: "Not found" }, 404);
    return c.json({ data: await versions.paths(skill), has_more: false });
  });

  // GET /v1/skills/:id/files/content?path=… — read one file's text
  registerContractRoute(router, getOpenApiRoute("getSkillFileContent"), async (c) => {
    const skill = await requireOwned(c, skillStore);
    if (!skill) return c.json({ error: "Not found" }, 404);
    const path = safePath(c.req.query("path"));
    if (!path) return c.json({ error: "path is required" }, 400);
    const bytes = await versions.readFile(skill, path);
    if (!bytes) return c.json({ error: "Not found" }, 404);
    return c.json({ path, content: new TextDecoder().decode(bytes) });
  });

  // PUT /v1/skills/:id/files/content — write (create or overwrite) one file
  //   body: { path: string, content: string }
  registerContractRoute(router, getOpenApiRoute("putSkillFileContent"), async (c) => {
    const skill = await requireOwned(c, skillStore);
    if (!skill) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json().catch(() => null);
    const path = safePath(body?.path);
    if (!path) return c.json({ error: "path is required" }, 400);
    if (typeof body.content !== "string") {
      return c.json({ error: "content is required" }, 400);
    }
    const base = await versions.checkout(skill);
    const previous = base.files.find((file) => file.path === path);
    const files = [
      ...base.files.filter((file) => file.path !== path),
      { path, body: new TextEncoder().encode(body.content), mode: previous?.mode },
    ];
    // The row's name and the new version are published together, so a name
    // conflict (409) changes nothing.
    const updated = await versions.commit(base, files, skillMdMetadata(path, body.content, skill.name));
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json({ path, content: body.content });
  });

  // DELETE /v1/skills/:id/files/content?path=… — delete one file
  registerContractRoute(router, getOpenApiRoute("deleteSkillFileContent"), async (c) => {
    const skill = await requireOwned(c, skillStore);
    if (!skill) return c.json({ error: "Not found" }, 404);
    const path = safePath(c.req.query("path"));
    if (!path) return c.json({ error: "path is required" }, 400);
    if (path === SKILL_MD) {
      return c.json({ error: "SKILL.md cannot be deleted: every Skill needs one. Edit it instead." }, 400);
    }
    // Deleting an absent file is a no-op that publishes no version.
    const base = await versions.checkout(skill);
    if (base.files.some((file) => file.path === path)) {
      const updated = await versions.commit(base, base.files.filter((file) => file.path !== path));
      if (!updated) return c.json({ error: "Not found" }, 404);
    }
    return c.json({ type: "skill_file_deleted", id: skill.id, path });
  });

  // POST /v1/skills/:id/files/rename — rename/move one file within the Skill,
  // replacing any file at the destination.
  //   body: { from: string, to: string }
  registerContractRoute(router, getOpenApiRoute("renameSkillFile"), async (c) => {
    const skill = await requireOwned(c, skillStore);
    if (!skill) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json().catch(() => null);
    const from = safePath(body?.from);
    const to = safePath(body?.to);
    if (!from || !to) return c.json({ error: "from and to are required" }, 400);
    if (from === SKILL_MD && to !== SKILL_MD) {
      return c.json({ error: "SKILL.md cannot be renamed: every Skill needs one. Rename the Skill by editing its name in SKILL.md." }, 400);
    }
    const base = await versions.checkout(skill);
    const source = base.files.find((file) => file.path === from);
    if (!source) return c.json({ error: "Not found" }, 404);
    const files = [
      ...base.files.filter((file) => file.path !== from && file.path !== to),
      { ...source, path: to },
    ];
    const metadata = skillMdMetadata(to, new TextDecoder().decode(source.body), skill.name);
    const updated = await versions.commit(base, files, metadata);
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json({ type: "skill_file_renamed", id: skill.id, from, to });
  });

  return router;
}

/**
 * Keep the Skill's summary in sync with its entry point: writing `SKILL.md`
 * refreshes name and description. A missing name keeps the Skill's current
 * name, matching upload parsing without renaming it to a generic fallback.
 * Other files change no metadata.
 */
function skillMdMetadata(path: string, content: string, currentName: string): { name?: string; description?: string } {
  return path === SKILL_MD ? parseSkillMetadata(content, currentName) : {};
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
