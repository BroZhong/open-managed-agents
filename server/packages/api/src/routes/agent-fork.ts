import type { AgentFileStore, AgentStore, SkillArtifactStore, SkillStore } from "@oma-server/store";
import type { TenantContext } from "../types.js";
import { publicAgent } from "../lib/public-projection.js";
import { getOpenApiRoute } from "../openapi/routes.js";
import { createContractRouter, registerContractRoute } from "../openapi/router.js";

type Env = { Variables: { tenant: TenantContext } };

export function agentForkRoutes(
  agents: AgentStore,
  agentFiles: AgentFileStore,
  skills: SkillStore,
  artifacts: SkillArtifactStore,
) {
  const router = createContractRouter<Env>();
  registerContractRoute(router, getOpenApiRoute("forkAgent"), async (c) => {
    const tenantId = c.get("tenant").tenantId;
    const source = await agents.getById(c.req.param("id")!);
    if (!source || source.tenantId !== tenantId) return c.json({ error: "Not found" }, 404);
    const { name } = await c.req.json<{ name: string }>();

    // Snapshot the Agent's current private copies, including edits made since
    // equip and Skills whose Library source has been deleted.
    const config = structuredClone(source);
    const skillSnapshots = [];
    for (const skill of await skills.listByOwner(tenantId, "agent", source.id)) {
      skillSnapshots.push({ skill: structuredClone(skill), files: structuredClone(await artifacts.getAll(tenantId, skill.id)) });
    }
    const fileSnapshots = [];
    for (const file of await agentFiles.list(tenantId, source.id)) {
      const snapshot = await agentFiles.get(tenantId, source.id, file.filename);
      if (!snapshot) throw new Error("Agent File changed while forking; retry the fork");
      fileSnapshots.push(structuredClone(snapshot));
    }

    const fork = await agents.create({
      tenantId, name: name.trim(), description: config.description,
      model: config.model, system: config.system, runtime: config.runtime,
      tools: config.tools, mcpServers: config.mcpServers, sandbox: config.sandbox,
      skills: [],
    });
    const forkSkillIds: string[] = [];
    try {
      for (const file of fileSnapshots) {
        await agentFiles.upsert(tenantId, fork.id, file.filename, file.content);
      }
      for (const { skill, files } of skillSnapshots) {
        const copy = await skills.create({
          tenantId, name: skill.name, description: skill.description,
          ownerType: "agent", ownerId: fork.id, sourceSkillId: skill.sourceSkillId,
        });
        forkSkillIds.push(copy.id);
        for (const file of files) await artifacts.put(tenantId, copy.id, file.path, file.body);
      }
      const updated = await agents.update(fork.id, { skills: forkSkillIds });
      if (!updated) throw new Error("Forked Agent disappeared");
      return c.json(publicAgent(updated), 201);
    } catch (error) {
      // Attempt every cleanup even if one storage operation fails.
      const cleanup = await Promise.allSettled([
        ...forkSkillIds.flatMap((id) => [artifacts.deleteTree(tenantId, id), skills.delete(id)]),
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
