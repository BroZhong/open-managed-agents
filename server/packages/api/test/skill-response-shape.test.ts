import { expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { ApiKeyStore } from "../src/types.js";
import { InMemoryAgentStore, InMemorySkillArtifactStore, InMemorySkillStore } from "@oma-server/store-memory";

const emptyApiKeyStore: ApiKeyStore = { async findByKeyHash() { return null; } };
/** The documented `Skill` schema: storage coordinates such as the bundle digest stay Host-private. */
const SKILL_KEYS = ["createdAt", "description", "id", "name", "ownerId", "ownerType", "sourceSkillId", "tenantId", "updatedAt"];

it("returns Skills in their documented shape without Skill Bundle storage fields", async () => {
  process.env.AUTH_DISABLED = "true";
  const agentStore = new InMemoryAgentStore();
  const skillStore = new InMemorySkillStore();
  const skillArtifactStore = new InMemorySkillArtifactStore();
  const app = createApp({ apiKeyStore: emptyApiKeyStore, agentStore, skillStore, skillArtifactStore });
  const json = async (path: string, init?: RequestInit) => (await app.request(path, init)).json();

  const form = new FormData();
  form.set("paths", JSON.stringify(["SKILL.md"]));
  form.append("files", new Blob(["---\nname: greeter\ndescription: Greets\n---\nHi."]), "SKILL.md");
  const uploaded = (await json("/v1/skills", { method: "POST", body: form })).data[0];
  expect(Object.keys(uploaded).sort()).toEqual(SKILL_KEYS);
  await skillStore.update(uploaded.id, { bundleSha256: "a".repeat(64), bundleSize: 10 });

  const detail = await json(`/v1/skills/${uploaded.id}`);
  expect(Object.keys(detail).sort()).toEqual([...SKILL_KEYS, "files"].sort());
  const patched = await json(`/v1/skills/${uploaded.id}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description: "Edited" }),
  });
  expect(Object.keys(patched).sort()).toEqual(SKILL_KEYS);

  const agent = await json("/v1/agents", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "A", model: "m", system: "s", runtime: "pi-agent" }),
  });
  const equip = (overwrite?: boolean) => json(`/v1/agents/${agent.id}/skills`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skillId: uploaded.id, ...(overwrite ? { overwrite } : {}) }),
  });
  const fork = await equip();
  expect(Object.keys(fork).sort()).toEqual(SKILL_KEYS);
  await skillStore.update(fork.id, { bundleSha256: "a".repeat(64), bundleSize: 10 });
  expect(Object.keys(await equip()).sort()).toEqual(SKILL_KEYS);
  expect(Object.keys(await equip(true)).sort()).toEqual(SKILL_KEYS);
});
