import { Hono } from "hono";
import type { Context } from "hono";
import type { AgentStore, SkillStore, SkillArtifactStore } from "@oma-server/store";
import type { TenantContext } from "../types.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

/**
 * Routes for the Skills equipped on an Agent (ADR-0004 fork-on-equip).
 *
 * Equipping a Library Skill FORKS it: we snapshot the Library Skill's metadata
 * and files into a new Agent Skill (`ownerType='agent'`, `ownerId=agentId`,
 * `sourceSkillId=<libraryId>`) and add the fork's id to `Agent.skills`. The
 * fork is independent from then on — editing it never touches the Library, and
 * deleting the Library Skill never affects already-equipped Agents.
 *
 * Unequipping DELETES the Agent's fork (metadata + files) and removes its id
 * from `Agent.skills`; the Library Skill is untouched.
 *
 * `GET` lists the Agent's forks (its equipped Skills), read from the skill store
 * by owner — so an equipped Skill is always visible (fixes the invisible-skill
 * P0 where a dangling Library reference silently vanished at materialization).
 */
export function agentSkillRoutes(
  agentStore: AgentStore,
  skillStore: SkillStore,
  skillArtifacts: SkillArtifactStore,
) {
  const router = new Hono<Env>();

  async function ownedAgent(c: Context<Env>) {
    const agentId = c.req.param("id");
    if (!agentId) return null;
    const agent = await agentStore.getById(agentId);
    const tenant = c.get("tenant");
    if (!agent || agent.tenantId !== tenant.tenantId) return null;
    return agent;
  }

  // GET /v1/agents/:id/skills — the Agent's equipped Skills (its forks)
  router.get("/v1/agents/:id/skills", async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: "Not found" }, 404);
    const forks = await skillStore.listByOwner(agent.tenantId, "agent", agent.id);
    return c.json({
      data: forks.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        sourceSkillId: s.sourceSkillId ?? null,
        updatedAt: s.updatedAt,
      })),
      has_more: false,
    });
  });

  // POST /v1/agents/:id/skills — equip a Library Skill (fork it onto the Agent)
  //   body: { skillId: "<libraryId>" }
  router.post("/v1/agents/:id/skills", async (c) => {
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
    if (already) return c.json(already, 200);

    // Snapshot metadata → new Agent Skill, then copy the files.
    const fork = await skillStore.create({
      tenantId: agent.tenantId,
      name: library.name,
      description: library.description,
      ownerType: "agent",
      ownerId: agent.id,
      sourceSkillId: library.id,
    });
    await skillArtifacts.copyTree(agent.tenantId, library.id, fork.id);

    const nextSkills = [...(agent.skills ?? []), fork.id];
    await agentStore.update(agent.id, { skills: nextSkills });

    return c.json(fork, 201);
  });

  // DELETE /v1/agents/:id/skills/:skillId — unequip (delete the Agent's fork)
  router.delete("/v1/agents/:id/skills/:skillId", async (c) => {
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

    await skillArtifacts.deleteTree(agent.tenantId, fork.id);
    await skillStore.delete(fork.id);

    const nextSkills = (agent.skills ?? []).filter((id) => id !== fork.id);
    await agentStore.update(agent.id, { skills: nextSkills });

    return c.json({ type: "skill_unequipped", agentId: agent.id, skillId: fork.id });
  });

  return router;
}
