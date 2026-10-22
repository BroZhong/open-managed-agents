import { SkillNameConflictError } from "@oma-server/store";
import { publicSkill } from "../lib/public-projection.js";
import { currentVersion } from "../skills/skill-versions.js";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AgentStore, SkillStore } from "@oma-server/store";
import type { TenantContext } from "../types.js";
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

/**
 * Routes for the Skills equipped on an Agent (ADR-0004 fork-on-equip).
 *
 * Equipping a Library Skill FORKS it: we snapshot the Library Skill's metadata
 * into a new Agent Skill (`ownerType='agent'`, `ownerId=agentId`,
 * `sourceSkillId=<libraryId>`) whose current version is the Library Skill's
 * current Skill Bundle (ADR-0022: bundles are immutable, so no file is copied),
 * and add the fork's id to `Agent.skills`. The fork is independent from then
 * on — an edit on either side publishes a new bundle for that side only, and
 * deleting the Library Skill never affects already-equipped Agents.
 *
 * Unequipping DELETES the Agent's fork row and removes its id from
 * `Agent.skills`; the Library Skill and every bundle are untouched.
 *
 * `GET` lists the Agent's forks (its equipped Skills), read from the skill store
 * by owner — so an equipped Skill is always visible (fixes the invisible-skill
 * P0 where a dangling Library reference silently vanished at materialization).
 */
export function agentSkillRoutes(
  agentStore: AgentStore,
  skillStore: SkillStore,
): OpenAPIHono<Env> {
  const router = createContractRouter<Env>();

  async function ownedAgent(c: Context<Env>) {
    const agentId = c.req.param("id");
    if (!agentId) return null;
    const agent = await agentStore.getById(agentId);
    const tenant = c.get("tenant");
    if (!agent || agent.tenantId !== tenant.tenantId) return null;
    return agent;
  }

  // GET /v1/agents/:id/skills — the Agent's equipped Skills (its forks)
  registerContractRoute(router, getOpenApiRoute("listAgentSkills"), async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: "Not found" }, 404);
    const forks = await skillStore.listByOwner(agent.tenantId, "agent", agent.id);
    return c.json({
      data: forks.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        sourceSkillId: s.sourceSkillId ?? null,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
      has_more: false,
    });
  });

  // POST /v1/agents/:id/skills — equip a Library Skill (fork it onto the Agent)
  //   body: { skillId: "<libraryId>" }
  registerContractRoute(router, getOpenApiRoute("equipAgentSkill"), async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.skillId !== "string") {
      return c.json({ error: "skillId is required" }, 400);
    }

    // The source must be a Library Skill the caller's tenant owns.
    const library = await skillStore.getById(body.skillId);
    if (
      !library ||
      library.tenantId !== agent.tenantId ||
      library.ownerType !== "library"
    ) {
      return c.json({ error: "Library Skill not found" }, 404);
    }

    // Idempotent: if this Library Skill is already forked onto the Agent, return
    // the existing fork instead of creating a duplicate.
    const existingForks = await skillStore.listByOwner(agent.tenantId, "agent", agent.id);
    const already = existingForks.find((s) => s.sourceSkillId === library.id);
    if (already && !body.overwrite) return c.json(publicSkill(already), 200);
    const sameName = existingForks.find((s) => s.name === library.name);
    if (sameName && !body.overwrite) throw new SkillNameConflictError(library.name);
    const version = currentVersion(library);
    if (sameName || already) {
      // Overwrite: the target moves to the Library Skill's current version,
      // unless the target was edited since it was read (409).
      const target = sameName ?? already!;
      const updated = await skillStore.update(target.id, {
        name: library.name,
        description: library.description,
        sourceSkillId: library.id,
        ...version,
      }, { expectedBundleSha256: target.bundleSha256 });
      return c.json(updated && publicSkill(updated), 200);
    }

    // Snapshot metadata → new Agent Skill on the Library Skill's bundle.
    const fork = await skillStore.create({
      tenantId: agent.tenantId,
      name: library.name,
      description: library.description,
      ownerType: "agent",
      ownerId: agent.id,
      sourceSkillId: library.id,
      ...version,
    });
    try {
      await agentStore.update(agent.id, { skills: [...(agent.skills ?? []), fork.id] });
    } catch (error) {
      await skillStore.delete(fork.id);
      throw error;
    }

    return c.json(publicSkill(fork), 201);
  });

  // DELETE /v1/agents/:id/skills/:skillId — unequip (delete the Agent's fork)
  registerContractRoute(router, getOpenApiRoute("unequipAgentSkill"), async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: "Not found" }, 404);

    const skillId = c.req.param("skillId");
    if (!skillId) return c.json({ error: "Not found" }, 404);

    // The target must be one of THIS Agent's forks (never a Library Skill or
    // another Agent's fork).
    const fork = await skillStore.getById(skillId);
    if (
      !fork ||
      fork.tenantId !== agent.tenantId ||
      fork.ownerType !== "agent" ||
      fork.ownerId !== agent.id
    ) {
      return c.json({ error: "Not found" }, 404);
    }

    // The fork's bundle stays: it may be shared (GC is #273).
    await skillStore.delete(fork.id);

    const nextSkills = (agent.skills ?? []).filter((id) => id !== fork.id);
    await agentStore.update(agent.id, { skills: nextSkills });

    return c.json({ type: "skill_unequipped", agentId: agent.id, skillId: fork.id });
  });

  return router;
}
