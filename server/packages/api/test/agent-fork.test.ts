import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { InMemoryAgentStore, InMemoryAgentFileStore, InMemorySkillStore, InMemorySkillArtifactStore } from "@oma-server/store-memory";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function setup() {
  vi.stubEnv("AUTH_DISABLED", "true");
  const agentStore = new InMemoryAgentStore();
  const agentFileStore = new InMemoryAgentFileStore();
  const skillStore = new InMemorySkillStore();
  const skillArtifactStore = new InMemorySkillArtifactStore();
  const app = createApp({ apiKeyStore: { async findByKeyHash() { return null; } }, agentStore, agentFileStore, skillStore, skillArtifactStore });
  const source = await agentStore.create({ tenantId: "dev", name: "Original", description: "Research", model: "m", system: "s", runtime: "pi-agent", tools: ["Read"], sandbox: { enabled: true, env: { LANG: "en_US" } } });
  await agentFileStore.upsert("dev", source.id, "SOUL.md", "Private instructions");
  const skill = await skillStore.create({ tenantId: "dev", name: "research", description: "Edited Agent Skill", ownerType: "agent", ownerId: source.id, sourceSkillId: "deleted-library-skill" });
  await skillArtifactStore.put("dev", skill.id, "SKILL.md", "Current Agent edits");
  await skillArtifactStore.put("dev", skill.id, "references/data.bin", new Uint8Array([0, 128, 255]));
  await agentStore.update(source.id, { skills: [skill.id] });
  const fork = (id = source.id, name = "Copy") => app.request(`/v1/agents/${id}/fork`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  return { app, agentStore, agentFileStore, skillStore, skillArtifactStore, source, skill, fork };
}

describe("Agent fork", () => {
  it("copies configuration, Agent Files and current private Skill contents into independent owners", async () => {
    const { fork, source, skill, agentStore, agentFileStore, skillStore, skillArtifactStore } = await setup();
    const response = await fork();
    expect(response.status).toBe(201);
    const copy = await response.json();
    expect(copy).toMatchObject({ name: "Copy", description: source.description, model: source.model, system: source.system, runtime: source.runtime, tools: source.tools, sandbox: source.sandbox });
    expect(copy.id).not.toBe(source.id);
    const copies = await skillStore.listByOwner("dev", "agent", copy.id);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ name: skill.name, description: skill.description, ownerId: copy.id, sourceSkillId: "deleted-library-skill" });
    expect(copies[0].id).not.toBe(skill.id);
    expect(copy.skills).toEqual([copies[0].id]);
    expect(await skillArtifactStore.getAll("dev", copies[0].id)).toEqual(await skillArtifactStore.getAll("dev", skill.id));
    expect((await agentFileStore.get("dev", copy.id, "SOUL.md"))?.content).toBe("Private instructions");
    await skillArtifactStore.put("dev", copies[0].id, "SKILL.md", "Copy edit");
    await agentFileStore.upsert("dev", copy.id, "SOUL.md", "Copy persona");
    expect(new TextDecoder().decode((await skillArtifactStore.get("dev", skill.id, "SKILL.md"))!)).toBe("Current Agent edits");
    expect((await agentFileStore.get("dev", source.id, "SOUL.md"))?.content).toBe("Private instructions");
    expect((await agentStore.getById(source.id))?.skills).toEqual([skill.id]);
    const storedCopy = (await agentStore.getById(copy.id))!;
    storedCopy.sandbox!.env!.LANG = "fr";
    expect(source.sandbox!.env!.LANG).toBe("en_US");
  });

  it("rejects cross-tenant sources and invalid names without creating an Agent", async () => {
    const { fork, agentStore } = await setup();
    const foreign = await agentStore.create({ tenantId: "other", name: "Foreign", model: "m", system: "s", runtime: "mock" });
    expect((await fork(foreign.id)).status).toBe(404);
    expect((await fork("missing")).status).toBe(404);
    expect((await fork(undefined, "  ")).status).toBe(400);
    expect((await agentStore.list("dev")).data).toHaveLength(1);
  });

  it("cleans up a failed Skill copy while preserving the source", async () => {
    const { fork, source, skill, agentStore, agentFileStore, skillStore, skillArtifactStore } = await setup();
    const put = skillArtifactStore.put.bind(skillArtifactStore);
    vi.spyOn(skillArtifactStore, "put").mockImplementation(async (tenant, id, path, body) => {
      if (path.endsWith(".bin")) throw new Error("Storage unavailable");
      return put(tenant, id, path, body);
    });
    expect((await fork()).status).toBe(500);
    expect((await agentStore.list("dev")).data.map((agent) => agent.id)).toEqual([source.id]);
    expect(await skillStore.listByOwner("dev", "agent", "agent_2")).toEqual([]);
    expect(await agentFileStore.list("dev", "agent_2")).toEqual([]);
    expect(await skillArtifactStore.list("dev", "skill_2")).toEqual([]);
    expect(await skillArtifactStore.list("dev", skill.id)).toHaveLength(2);
  });

  it("forks an Agent with no Skills or Agent Files", async () => {
    const { fork, agentStore } = await setup();
    const empty = await agentStore.create({ tenantId: "dev", name: "Empty", model: "m", system: "s", runtime: "mock" });
    const response = await fork(empty.id);
    expect(response.status).toBe(201);
    expect((await response.json()).skills).toEqual([]);
  });
});
