import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { Runtime } from "@oma-server/store";
import { InMemoryAgentStore, InMemoryAgentFileStore, InMemorySkillStore, InMemorySkillBundleStore } from "@oma-server/store-memory";
import { currentFiles, seedSkill } from "./fixtures/skill-bundles.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function setup() {
  vi.stubEnv("AUTH_DISABLED", "true");
  const agentStore = new InMemoryAgentStore();
  const agentFileStore = new InMemoryAgentFileStore();
  const skillStore = new InMemorySkillStore();
  const skillBundleStore = new InMemorySkillBundleStore();
  const app = createApp({ apiKeyStore: { async findByKeyHash() { return null; } }, agentStore, agentFileStore, skillStore, skillBundleStore });
  const source = await agentStore.create({ tenantId: "dev", name: "Original", description: "Research", model: "m", system: "s", runtime: "pi-agent", tools: ["Read"], sandbox: { enabled: true } });
  await agentFileStore.upsert("dev", source.id, "SOUL.md", "Private instructions");
  const skill = await seedSkill(skillStore, skillBundleStore,
    { tenantId: "dev", name: "research", description: "Edited Agent Skill", ownerType: "agent", ownerId: source.id, sourceSkillId: "deleted-library-skill" },
    { "SKILL.md": "Current Agent edits", "references/data.bin": new Uint8Array([0, 128, 255]) });
  await agentStore.update(source.id, { skills: [skill.id] });
  const fork = (id = source.id, name = "Copy") => app.request(`/v1/agents/${id}/fork`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  const filesOf = (id: string) => currentFiles(skillStore, skillBundleStore, id);
  return { app, agentStore, agentFileStore, skillStore, skillBundleStore, filesOf, source, skill, fork };
}

describe("Agent fork", () => {
  it("copies configuration and Agent Files and references the current private Skill versions under independent owners", async () => {
    const { app, fork, source, skill, agentStore, agentFileStore, skillStore, skillBundleStore, filesOf } = await setup();
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
    // The copy references the source's bundle; no Skill file is copied.
    expect(copies[0]).toMatchObject({ bundleSha256: skill.bundleSha256, bundleSize: skill.bundleSize });
    const sourceBundle = await skillBundleStore.get("dev", skill.bundleSha256!);
    expect((await agentFileStore.get("dev", copy.id, "SOUL.md"))?.content).toBe("Private instructions");
    const edit = await app.request(`/v1/skills/${copies[0].id}/files/content`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "SKILL.md", content: "Copy edit" }),
    });
    expect(edit.status).toBe(200);
    await agentFileStore.upsert("dev", copy.id, "SOUL.md", "Copy persona");
    expect((await filesOf(copies[0].id)).files["SKILL.md"]).toBe("Copy edit");
    const original = await filesOf(skill.id);
    expect(original.sha256).toBe(skill.bundleSha256);
    expect(original.files["SKILL.md"]).toBe("Current Agent edits");
    expect(await skillBundleStore.get("dev", skill.bundleSha256!)).toEqual(sourceBundle);
    expect(await skillBundleStore.readFile("dev", skill.bundleSha256!, "references/data.bin")).toEqual(new Uint8Array([0, 128, 255]));
    expect((await agentFileStore.get("dev", source.id, "SOUL.md"))?.content).toBe("Private instructions");
    expect((await agentStore.getById(source.id))?.skills).toEqual([skill.id]);
    const storedCopy = (await agentStore.getById(copy.id))!;
    storedCopy.sandbox!.enabled = false;
    expect(source.sandbox!.enabled).toBe(true);
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
    const { fork, source, skill, agentStore, agentFileStore, skillStore, skillBundleStore, filesOf } = await setup();
    const second = await seedSkill(skillStore, skillBundleStore,
      { tenantId: "dev", name: "writing", description: "", ownerType: "agent", ownerId: source.id }, { "SKILL.md": "Write" });
    await agentStore.update(source.id, { skills: [skill.id, second.id] });
    const create = skillStore.create.bind(skillStore);
    vi.spyOn(skillStore, "create").mockImplementation(async (input) => {
      if (input.name === "writing") throw new Error("Database unavailable");
      return create(input);
    });
    expect((await fork()).status).toBe(500);
    expect((await agentStore.list("dev")).data.map((agent) => agent.id)).toEqual([source.id]);
    expect(await skillStore.listByOwner("dev", "agent", "agent_2")).toEqual([]);
    expect(await agentFileStore.list("dev", "agent_2")).toEqual([]);
    expect((await skillStore.listByOwner("dev", "agent", source.id)).map((s) => s.id)).toEqual([skill.id, second.id]);
    expect((await filesOf(skill.id)).sha256).toBe(skill.bundleSha256);
  });

  it("refuses to copy a retired runtime into a new Agent", async () => {
    const { fork, agentStore } = await setup();
    // Existing Agents keep a retired runtime; they are not migrated.
    const retiredRuntime: string = "codex";
    const retired = await agentStore.create({ tenantId: "dev", name: "Retired", model: "m", system: "s", runtime: retiredRuntime as Runtime });
    const response = await fork(retired.id);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Agent runtime "codex" is not supported; runtime must be one of: pi-agent, mock' });
    expect((await agentStore.list("dev")).data).toHaveLength(2);
  });

  it("forks an Agent with no Skills or Agent Files", async () => {
    const { fork, agentStore } = await setup();
    const empty = await agentStore.create({ tenantId: "dev", name: "Empty", model: "m", system: "s", runtime: "mock" });
    const response = await fork(empty.id);
    expect(response.status).toBe(201);
    expect((await response.json()).skills).toEqual([]);
  });
});
