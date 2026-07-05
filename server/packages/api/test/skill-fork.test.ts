import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import type { ApiKeyStore } from "../src/types.js";
import {
  InMemoryAgentStore,
  InMemorySkillStore,
  InMemorySkillArtifactStore,
} from "@oma-server/store-memory";

const emptyApiKeyStore: ApiKeyStore = { async findByKeyHash() { return null; } };

const SKILL_MD = `---
name: greeter
description: Greets warmly
---
Equipped SKILL marker.`;

function setup() {
  process.env.AUTH_DISABLED = "true";
  const agentStore = new InMemoryAgentStore();
  const skillStore = new InMemorySkillStore();
  const skillArtifactStore = new InMemorySkillArtifactStore();
  const app = createApp({
    apiKeyStore: emptyApiKeyStore,
    agentStore,
    skillStore,
    skillArtifactStore,
  });
  return { app, agentStore, skillStore, skillArtifactStore };
}

async function makeAgent(app: ReturnType<typeof setup>["app"]) {
  const res = await app.request("/v1/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "A", model: "m", system: "s", runtime: "pi-agent" }),
  });
  return (await res.json()).id as string;
}

/** Create a Library Skill directly in the store + its files, return its id. */
async function makeLibrarySkill(
  skillStore: InMemorySkillStore,
  skillArtifactStore: InMemorySkillArtifactStore,
  files: { path: string; content: string }[] = [{ path: "SKILL.md", content: SKILL_MD }],
) {
  const skill = await skillStore.create({ tenantId: "dev", name: "greeter", description: "Greets warmly" });
  for (const f of files) await skillArtifactStore.put("dev", skill.id, f.path, f.content);
  return skill.id;
}

describe("Equip forks a Library Skill (ADR-0004)", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("equipping creates an independent Agent Skill copy; Agent.skills references the fork", async () => {
    const { app, agentStore, skillStore, skillArtifactStore } = setup();
    const agentId = await makeAgent(app);
    const libId = await makeLibrarySkill(skillStore, skillArtifactStore);

    const res = await app.request(`/v1/agents/${agentId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId: libId }),
    });
    expect(res.status).toBe(201);
    const fork = await res.json();
    expect(fork.ownerType).toBe("agent");
    expect(fork.ownerId).toBe(agentId);
    expect(fork.sourceSkillId).toBe(libId);
    expect(fork.id).not.toBe(libId);

    const agent = await agentStore.getById(agentId);
    expect(agent?.skills).toEqual([fork.id]);

    // Fork got its own copy of the files (equipped SKILL marker reaches it).
    const forkFiles = await skillArtifactStore.getAll("dev", fork.id);
    expect(forkFiles.map((f) => f.path)).toContain("SKILL.md");
    expect(new TextDecoder().decode(forkFiles[0].body)).toContain("Equipped SKILL marker");
  });

  it("GET the Agent's equipped list returns its forks", async () => {
    const { app, skillStore, skillArtifactStore } = setup();
    const agentId = await makeAgent(app);
    const libId = await makeLibrarySkill(skillStore, skillArtifactStore);
    await app.request(`/v1/agents/${agentId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId: libId }),
    });
    const list = await app.request(`/v1/agents/${agentId}/skills`);
    const body = await list.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].sourceSkillId).toBe(libId);
  });

  it("Library listing shows only Library Skills, not forks", async () => {
    const { app, skillStore, skillArtifactStore } = setup();
    const agentId = await makeAgent(app);
    const libId = await makeLibrarySkill(skillStore, skillArtifactStore);
    await app.request(`/v1/agents/${agentId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId: libId }),
    });
    const list = await app.request("/v1/skills");
    const body = await list.json();
    expect(body.data.map((s: { id: string }) => s.id)).toEqual([libId]);
  });

  it("deleting a Library Skill does not affect the equipped fork", async () => {
    const { app, skillStore, skillArtifactStore } = setup();
    const agentId = await makeAgent(app);
    const libId = await makeLibrarySkill(skillStore, skillArtifactStore);
    const forkId = (await (await app.request(`/v1/agents/${agentId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId: libId }),
    })).json()).id;

    const del = await app.request(`/v1/skills/${libId}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    // Fork survives with its files.
    expect(await skillStore.getById(forkId)).not.toBeNull();
    expect(await skillArtifactStore.list("dev", forkId)).toHaveLength(1);
  });

  it("unequipping removes the fork and leaves the Library Skill untouched", async () => {
    const { app, agentStore, skillStore, skillArtifactStore } = setup();
    const agentId = await makeAgent(app);
    const libId = await makeLibrarySkill(skillStore, skillArtifactStore);
    const forkId = (await (await app.request(`/v1/agents/${agentId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId: libId }),
    })).json()).id;

    const un = await app.request(`/v1/agents/${agentId}/skills/${forkId}`, { method: "DELETE" });
    expect(un.status).toBe(200);

    expect(await skillStore.getById(forkId)).toBeNull();
    expect(await skillArtifactStore.list("dev", forkId)).toHaveLength(0);
    expect((await agentStore.getById(agentId))?.skills).toEqual([]);
    // Library Skill untouched.
    expect(await skillStore.getById(libId)).not.toBeNull();
    expect(await skillArtifactStore.list("dev", libId)).toHaveLength(1);
  });

  it("equip is idempotent per source Library Skill", async () => {
    const { app, agentStore, skillStore, skillArtifactStore } = setup();
    const agentId = await makeAgent(app);
    const libId = await makeLibrarySkill(skillStore, skillArtifactStore);
    const first = await (await app.request(`/v1/agents/${agentId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId: libId }),
    })).json();
    const second = await app.request(`/v1/agents/${agentId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId: libId }),
    });
    expect(second.status).toBe(200);
    expect((await second.json()).id).toBe(first.id);
    expect((await agentStore.getById(agentId))?.skills).toEqual([first.id]);
  });
});

describe("Skill directory file editing (issue #73)", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("lists, reads, writes, deletes and renames files on a Library Skill", async () => {
    const { app, skillStore, skillArtifactStore } = setup();
    const libId = await makeLibrarySkill(skillStore, skillArtifactStore, [
      { path: "SKILL.md", content: SKILL_MD },
      { path: "notes.md", content: "old" },
    ]);

    // list
    const listed = await (await app.request(`/v1/skills/${libId}/files`)).json();
    expect(listed.data.sort()).toEqual(["SKILL.md", "notes.md"].sort());

    // read
    const read = await (await app.request(`/v1/skills/${libId}/files/content?path=notes.md`)).json();
    expect(read.content).toBe("old");

    // write (overwrite)
    const w = await app.request(`/v1/skills/${libId}/files/content`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "notes.md", content: "new" }),
    });
    expect(w.status).toBe(200);
    const reread = await (await app.request(`/v1/skills/${libId}/files/content?path=notes.md`)).json();
    expect(reread.content).toBe("new");

    // rename
    const ren = await app.request(`/v1/skills/${libId}/files/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "notes.md", to: "docs/moved.md" }),
    });
    expect(ren.status).toBe(200);
    const after = await (await app.request(`/v1/skills/${libId}/files`)).json();
    expect(after.data.sort()).toEqual(["SKILL.md", "docs/moved.md"].sort());

    // delete
    const del = await app.request(`/v1/skills/${libId}/files/content?path=docs/moved.md`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const final = await (await app.request(`/v1/skills/${libId}/files`)).json();
    expect(final.data).toEqual(["SKILL.md"]);
  });

  it("editing a fork does not change the Library Skill (and vice versa)", async () => {
    const { app, skillStore, skillArtifactStore } = setup();
    const agentId = await makeAgent(app);
    const libId = await makeLibrarySkill(skillStore, skillArtifactStore);
    const forkId = (await (await app.request(`/v1/agents/${agentId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId: libId }),
    })).json()).id;

    // Edit the fork's SKILL.md.
    await app.request(`/v1/skills/${forkId}/files/content`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "SKILL.md", content: "FORK EDIT" }),
    });

    const libContent = await (await app.request(`/v1/skills/${libId}/files/content?path=SKILL.md`)).json();
    const forkContent = await (await app.request(`/v1/skills/${forkId}/files/content?path=SKILL.md`)).json();
    expect(forkContent.content).toBe("FORK EDIT");
    expect(libContent.content).toContain("Equipped SKILL marker");
  });

  it("rejects path traversal", async () => {
    const { app, skillStore, skillArtifactStore } = setup();
    const libId = await makeLibrarySkill(skillStore, skillArtifactStore);
    const res = await app.request(`/v1/skills/${libId}/files/content?path=../escape`);
    expect(res.status).toBe(400);
  });

  it("a Skill from another tenant is not reachable", async () => {
    const { app, skillStore, skillArtifactStore } = setup();
    // Create a skill owned by a different tenant directly in the store.
    const other = await skillStore.create({ tenantId: "other", name: "x", description: "y" });
    await skillArtifactStore.put("other", other.id, "SKILL.md", "secret");
    const res = await app.request(`/v1/skills/${other.id}/files/content?path=SKILL.md`);
    expect(res.status).toBe(404);
  });
});
