import { RUNTIMES, type AgentFileStore, type AgentStore, type SkillStore } from "@oma-server/store";
import type { TenantContext } from "../types.js";
import { publicAgent } from "../lib/public-projection.js";
import { currentVersion } from "../skills/skill-versions.js";
import { getOpenApiRoute } from "../openapi/routes.js";
import { createContractRouter, registerContractRoute } from "../openapi/router.js";

type Env = { Variables: { tenant: TenantContext } };

export function agentForkRoutes(
  agents: AgentStore,
  agentFiles: AgentFileStore,
  skills: SkillStore,
) {
  const router = createContractRouter<Env>();
  registerContractRoute(router, getOpenApiRoute("forkAgent"), async (c) => {
    const tenantId = c.get("tenant").tenantId;
    const source = await agents.getById(c.req.param("id")!);
    if (!source || source.tenantId !== tenantId) return c.json({ error: "Not found" }, 404);
    // Existing Agents keep a retired runtime (they are not migrated); a fork
    // must not create another one.
    if (!RUNTIMES.includes(source.runtime)) {
      return c.json({ error: `Agent runtime "${source.runtime}" is not supported; runtime must be one of: ${RUNTIMES.join(", ")}` }, 400);
    }
    const { name } = await c.req.json<{ name: string }>();

    // Snapshot the Agent's current private copies, including edits made since
    // equip and Skills whose Library source has been deleted. A copy references
    // its source's current Skill Bundle, which never changes (ADR-0022).
    const config = structuredClone(source);
    const skillSnapshots = (await skills.listByOwner(tenantId, "agent", source.id))
      .map((skill) => ({ skill: structuredClone(skill), version: currentVersion(skill) }));
    const fileSnapshots = [];
    for (const file of await agentFiles.list(tenantId, source.id)) {
      const snapshot = await agentFiles.get(tenantId, source.id, file.filename);
      if (!snapshot) throw new Error("Agent File changed while forking; retry the fork");
      fileSnapshots.push(structuredClone(snapshot));
    }

    const fork = await agents.create({
      tenantId, name: name.trim(), description: config.description,
      model: config.model, system: config.system, runtime: config.runtime,
      thinking: config.thinking,
      tools: config.tools, mcpServers: config.mcpServers, sandbox: config.sandbox,
      skills: [],
    });
    const forkSkillIds: string[] = [];
    try {
      for (const file of fileSnapshots) {
        await agentFiles.upsert(tenantId, fork.id, file.filename, file.content);
      }
      for (const { skill, version } of skillSnapshots) {
        const copy = await skills.create({
          tenantId, name: skill.name, description: skill.description,
          ownerType: "agent", ownerId: fork.id, sourceSkillId: skill.sourceSkillId, ...version,
        });
        forkSkillIds.push(copy.id);
      }
      const updated = await agents.update(fork.id, { skills: forkSkillIds });
      if (!updated) throw new Error("Forked Agent disappeared");
      return c.json(publicAgent(updated), 201);
    } catch (error) {
      // Attempt every cleanup even if one storage operation fails.
      const cleanup = await Promise.allSettled([
        ...forkSkillIds.map((id) => skills.delete(id)),
        ...fileSnapshots.map((file) => agentFiles.delete(tenantId, fork.id, file.filename)),
        agents.delete(fork.id),
      ]);
      const failures = cleanup.filter((result) => result.status === "rejected");
      if (failures.length) throw new AggregateError([error, ...failures.map((result) => result.reason)], "Agent fork cleanup failed");
      throw error;
    }
  });
  return router;
}
