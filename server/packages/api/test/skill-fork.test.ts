import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { ApiKeyStore } from "../src/types.js";
import {
  InMemoryAgentStore,
  InMemorySkillStore,
  InMemorySkillBundleStore,
} from "@oma-server/store-memory";
import { currentFiles, seedSkill } from "./fixtures/skill-bundles.js";

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
  const skillBundleStore = new InMemorySkillBundleStore();
  const app = createApp({
    apiKeyStore: emptyApiKeyStore,
    agentStore,
    skillStore,
    skillBundleStore,
  });
  const filesOf = (id: string) => currentFiles(skillStore, skillBundleStore, id);
  return { app, agentStore, skillStore, skillBundleStore, filesOf };
}

type Env = ReturnType<typeof setup>;

async function makeAgent(app: Env["app"]) {
  const res = await app.request("/v1/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "A", model: "m", system: "s", runtime: "pi-agent" }),
  });
  return (await res.json()).id as string;
}

/** Create a Library Skill with a bundle of its files, return its id. */
async function makeLibrarySkill(
  { skillStore, skillBundleStore }: Env,
  files: Record<string, string> = { "SKILL.md": SKILL_MD },
) {
  const skill = await seedSkill(skillStore, skillBundleStore, { tenantId: "dev", name: "greeter", description: "Greets warmly" }, files);
  return skill.id;
}

const equip = (app: Env["app"], agentId: string, skillId: string, overwrite?: boolean) =>
  app.request(`/v1/agents/${agentId}/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skillId, ...(overwrite === undefined ? {} : { overwrite }) }),
  });

const writeFile = (app: Env["app"], skillId: string, path: string, content: string) =>
  app.request(`/v1/skills/${skillId}/files/content`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });

describe("Equip forks a Library Skill (ADR-0004)", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("equipping creates an Agent Skill on the Library Skill's bundle; Agent.skills references the fork", async () => {
    const env = setup();
    const { app, agentStore, skillStore, skillBundleStore } = env;
    const agentId = await makeAgent(app);
    const libId = await makeLibrarySkill(env);
    const library = (await skillStore.getById(libId))!;
    const libraryBundle = await skillBundleStore.get("dev", library.bundleSha256!);

    const res = await equip(app, agentId, libId);
    expect(res.status).toBe(201);
    const fork = await res.json();
    expect(fork.ownerType).toBe("agent");
    expect(fork.ownerId).toBe(agentId);
    expect(fork.sourceSkillId).toBe(libId);
    expect(fork.id).not.toBe(libId);

    const agent = await agentStore.getById(agentId);
    expect(agent?.skills).toEqual([fork.id]);

    // The fork references the same immutable bundle: no files are copied.
    expect(await skillStore.getById(fork.id)).toMatchObject({ bundleSha256: library.bundleSha256, bundleSize: library.bundleSize });
    const forkContent = await (await app.request(`/v1/skills/${fork.id}/files/content?path=SKILL.md`)).json();
    expect(forkContent.content).toContain("Equipped SKILL marker");

    // Editing the fork afterwards publishes a bundle for the fork only.
    expect((await writeFile(app, fork.id, "notes.md", "fork only")).status).toBe(200);
    const forkFiles = await env.filesOf(fork.id);
    expect(forkFiles.sha256).not.toBe(library.bundleSha256);
    expect(forkFiles.files["notes.md"]).toBe("fork only");
    expect(await env.filesOf(libId)).toEqual({ sha256: library.bundleSha256, files: { "SKILL.md": SKILL_MD } });
    expect(await skillBundleStore.get("dev", library.bundleSha256!)).toEqual(libraryBundle);

    // ...and editing the Library Skill changes only the Library Skill.
    expect((await writeFile(app, libId, "library.md", "library only")).status).toBe(200);
    expect((await env.filesOf(fork.id)).files).toEqual({ "SKILL.md": SKILL_MD, "notes.md": "fork only" });
  });

  it("GET the Agent's equipped list returns its forks", async () => {
    const env = setup();
    const agentId = await makeAgent(env.app);
    const libId = await makeLibrarySkill(env);
    await equip(env.app, agentId, libId);
    const list = await env.app.request(`/v1/agents/${agentId}/skills`);
    const body = await list.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].sourceSkillId).toBe(libId);
  });

  it("Library listing shows only Library Skills, not forks", async () => {
    const env = setup();
    const agentId = await makeAgent(env.app);
    const libId = await makeLibrarySkill(env);
    await equip(env.app, agentId, libId);
    const list = await env.app.request("/v1/skills");
    const body = await list.json();
    expect(body.data.map((s: { id: string }) => s.id)).toEqual([libId]);
  });

  it("deleting a Library Skill does not affect the equipped fork", async () => {
    const env = setup();
    const agentId = await makeAgent(env.app);
    const libId = await makeLibrarySkill(env);
    const forkId = (await (await equip(env.app, agentId, libId)).json()).id;

    const del = await env.app.request(`/v1/skills/${libId}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    // Fork survives with its files: the shared bundle is never deleted.
    expect(await env.skillStore.getById(forkId)).not.toBeNull();
    expect((await env.filesOf(forkId)).files).toEqual({ "SKILL.md": SKILL_MD });
  });

  it("unequipping removes the fork and leaves the Library Skill untouched", async () => {
    const env = setup();
    const agentId = await makeAgent(env.app);
    const libId = await makeLibrarySkill(env);
    const forkId = (await (await equip(env.app, agentId, libId)).json()).id;

    const un = await env.app.request(`/v1/agents/${agentId}/skills/${forkId}`, { method: "DELETE" });
    expect(un.status).toBe(200);

    expect(await env.skillStore.getById(forkId)).toBeNull();
    expect((await env.agentStore.getById(agentId))?.skills).toEqual([]);
    // Library Skill untouched.
    expect((await env.filesOf(libId)).files).toEqual({ "SKILL.md": SKILL_MD });
  });

  it("equip is idempotent per source Library Skill", async () => {
    const env = setup();
    const agentId = await makeAgent(env.app);
    const libId = await makeLibrarySkill(env);
    const first = await (await equip(env.app, agentId, libId)).json();
    const second = await equip(env.app, agentId, libId);
    expect(second.status).toBe(200);
    expect((await second.json()).id).toBe(first.id);
    expect((await env.agentStore.getById(agentId))?.skills).toEqual([first.id]);
  });

  it("removes the fork again if recording it on the Agent fails", async () => {
    const env = setup();
    const agentId = await makeAgent(env.app);
    const libId = await makeLibrarySkill(env);
    vi.spyOn(env.agentStore, "update").mockRejectedValueOnce(new Error("Database unavailable"));
    expect((await equip(env.app, agentId, libId)).status).toBe(500);
    expect(await env.skillStore.listByOwner("dev", "agent", agentId)).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe("Skill directory file editing (issue #73)", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists, reads, writes, deletes and renames files on a Library Skill", async () => {
    const env = setup();
    const { app } = env;
    const libId = await makeLibrarySkill(env, { "SKILL.md": SKILL_MD, "notes.md": "old" });

    // list
    const listed = await (await app.request(`/v1/skills/${libId}/files`)).json();
    expect(listed).toEqual({ data: ["SKILL.md", "notes.md"], has_more: false });

    // read
    const read = await (await app.request(`/v1/skills/${libId}/files/content?path=notes.md`)).json();
    expect(read).toEqual({ path: "notes.md", content: "old" });

    // write (overwrite)
    const w = await writeFile(app, libId, "notes.md", "new");
    expect(w.status).toBe(200);
    expect(await w.json()).toEqual({ path: "notes.md", content: "new" });
    const reread = await (await app.request(`/v1/skills/${libId}/files/content?path=notes.md`)).json();
    expect(reread.content).toBe("new");

    // rename
    const ren = await app.request(`/v1/skills/${libId}/files/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "notes.md", to: "docs/moved.md" }),
    });
    expect(ren.status).toBe(200);
    expect(await ren.json()).toEqual({ type: "skill_file_renamed", id: libId, from: "notes.md", to: "docs/moved.md" });
    const after = await (await app.request(`/v1/skills/${libId}/files`)).json();
    expect(after.data).toEqual(["SKILL.md", "docs/moved.md"]);

    // delete
    const del = await app.request(`/v1/skills/${libId}/files/content?path=docs/moved.md`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ type: "skill_file_deleted", id: libId, path: "docs/moved.md" });
    const final = await (await app.request(`/v1/skills/${libId}/files`)).json();
    expect(final.data).toEqual(["SKILL.md"]);
  });

  it("online fork edits update its summary and timestamps independently of the Library Skill", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const uploadedAt = "2026-09-08T01:00:00.000Z";
    const forkedAt = "2026-09-08T02:00:00.000Z";
    const editedAt = "2026-09-08T03:00:00.000Z";
    vi.setSystemTime(new Date(uploadedAt));
    const env = setup();
    const { app, skillStore } = env;
    const agentId = await makeAgent(app);
    const libId = await makeLibrarySkill(env);
    vi.setSystemTime(new Date(forkedAt));
    const fork = await (await equip(app, agentId, libId)).json();
    const forkId = fork.id;
    expect(fork.createdAt).toBe(forkedAt);
    expect(fork.updatedAt).toBe(forkedAt);

    // Edit the fork's SKILL.md.
    vi.setSystemTime(new Date(editedAt));
    const forkEdit = "---\nname: agent-greeter\ndescription: Agent greeting\n---\nFORK EDIT";
    const saved = await writeFile(app, forkId, "SKILL.md", forkEdit);
    expect(saved.status).toBe(200);

    const libContent = await (await app.request(`/v1/skills/${libId}/files/content?path=SKILL.md`)).json();
    const forkContent = await (await app.request(`/v1/skills/${forkId}/files/content?path=SKILL.md`)).json();
    expect(forkContent.content).toBe(forkEdit);
    expect(libContent.content).toContain("Equipped SKILL marker");

    const expectedFork = {
      id: forkId,
      name: "agent-greeter",
      description: "Agent greeting",
      sourceSkillId: libId,
      createdAt: forkedAt,
      updatedAt: editedAt,
    };
    const equipped = await (await app.request(`/v1/agents/${agentId}/skills`)).json();
    expect(equipped.data).toEqual([expectedFork]);
    const library = await (await app.request(`/v1/skills/${libId}`)).json();
    expect(library).toMatchObject({
      name: "greeter",
      description: "Greets warmly",
      createdAt: uploadedAt,
      updatedAt: uploadedAt,
    });

    // Updating the Library afterwards must not overwrite the fork's metadata.
    vi.setSystemTime(new Date("2026-09-08T04:00:00.000Z"));
    const librarySaved = await writeFile(app, libId, "SKILL.md", "---\nname: library-greeter\ndescription: Library greeting\n---");
    expect(librarySaved.status).toBe(200);
    const forkDetail = await (await app.request(`/v1/skills/${forkId}`)).json();
    expect(forkDetail).toMatchObject(expectedFork);
    expect(await skillStore.getById(libId)).toMatchObject({ name: "library-greeter", description: "Library greeting" });
  });

  it("rejects path traversal", async () => {
    const env = setup();
    const libId = await makeLibrarySkill(env);
    const res = await env.app.request(`/v1/skills/${libId}/files/content?path=../escape`);
    expect(res.status).toBe(400);
  });

  it("a Skill from another tenant is not reachable", async () => {
    const env = setup();
    // Create a skill owned by a different tenant directly in the store.
    const other = await seedSkill(env.skillStore, env.skillBundleStore, { tenantId: "other", name: "x", description: "y" }, { "SKILL.md": "secret" });
    const res = await env.app.request(`/v1/skills/${other.id}/files/content?path=SKILL.md`);
    expect(res.status).toBe(404);
  });
});

describe("Agent Skill name conflicts", () => {
  it("re-importing with overwrite moves the existing source fork to the Library Skill's current bundle", async () => {
    const env = setup();
    const { app, agentStore, skillStore } = env;
    const agentId = await makeAgent(app);
    const libId = await makeLibrarySkill(env);
    const initial = await equip(app, agentId, libId, true);
    expect(initial.status).toBe(201);
    const fork = await initial.json();
    expect((await writeFile(app, fork.id, "old.txt", "Agent-only file")).status).toBe(200);
    await skillStore.update(libId, { description: "Updated Library instructions" });
    expect((await writeFile(app, libId, "scripts/new.sh", "echo updated")).status).toBe(200);
    const library = (await skillStore.getById(libId))!;

    const updated = await equip(app, agentId, libId, true);
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ id: fork.id, sourceSkillId: libId, description: "Updated Library instructions" });
    expect(await skillStore.getById(fork.id)).toMatchObject({ bundleSha256: library.bundleSha256, bundleSize: library.bundleSize });
    expect((await env.filesOf(fork.id)).files).toEqual({ "SKILL.md": SKILL_MD, "scripts/new.sh": "echo updated" });
    expect((await agentStore.getById(agentId))?.skills).toEqual([fork.id]);
    expect(await skillStore.listByOwner("dev", "agent", agentId)).toHaveLength(1);
  });

  it("confirms replacement of a same-name fork while preserving other Agents and the Library", async () => {
    const env = setup();
    const { app, agentStore, skillStore, skillBundleStore } = env;
    const agentId = await makeAgent(app);
    const otherAgent = await makeAgent(app);
    const libId = await makeLibrarySkill(env);
    const fork = await seedSkill(skillStore, skillBundleStore,
      { tenantId: "dev", ownerType: "agent", ownerId: agentId, name: "greeter", description: "private", sourceSkillId: "old-source" },
      { "SKILL.md": "private", "old.txt": "private" });
    await agentStore.update(agentId, { skills: [fork.id] });
    const other = await seedSkill(skillStore, skillBundleStore,
      { tenantId: "dev", ownerType: "agent", ownerId: otherAgent, name: "greeter", description: "other" }, { "SKILL.md": "other" });
    expect((await equip(app, agentId, libId)).status).toBe(409);
    expect((await env.filesOf(fork.id)).files).toEqual({ "SKILL.md": "private", "old.txt": "private" });
    const replaced = await equip(app, agentId, libId, true);
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ id: fork.id, sourceSkillId: libId, description: "Greets warmly" });
    expect((await env.filesOf(fork.id)).files).toEqual({ "SKILL.md": SKILL_MD });
    expect((await agentStore.getById(agentId))?.skills).toEqual([fork.id]);
    expect(await skillStore.listByOwner("dev", "agent", agentId)).toHaveLength(1);
    expect((await skillStore.getById(other.id))?.description).toBe("other");
    expect((await env.filesOf(other.id)).files).toEqual({ "SKILL.md": "other" });
    expect((await env.filesOf(libId)).files).toEqual({ "SKILL.md": SKILL_MD });
  });

  it("an overwrite equip racing an edit of the target fork gets 409 and keeps the edit", async () => {
    const env = setup();
    const { app, skillStore } = env;
    const agentId = await makeAgent(app);
    const libId = await makeLibrarySkill(env);
    const fork = await (await equip(app, agentId, libId)).json();
    // The fork is edited after the overwrite equip read it, before it commits.
    const update = skillStore.update.bind(skillStore);
    let raced = false;
    vi.spyOn(skillStore, "update").mockImplementation(async (id, input, options) => {
      if (id === fork.id && input.sourceSkillId === libId && !raced) {
        raced = true;
        expect((await writeFile(app, fork.id, "notes.md", "concurrent edit")).status).toBe(200);
      }
      return update(id, input, options);
    });
    const res = await equip(app, agentId, libId, true);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("skill_version_conflict");
    expect((await env.filesOf(fork.id)).files["notes.md"]).toBe("concurrent edit");
    vi.restoreAllMocks();
  });
});
