import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { ApiKeyStore } from "../src/types.js";
import { InMemorySkillStore, InMemorySkillBundleStore } from "@oma-server/store-memory";
import { currentFiles, seedSkill } from "./fixtures/skill-bundles.js";

const emptyApiKeyStore: ApiKeyStore = { async findByKeyHash() { return null; } };

function setup() {
  process.env.AUTH_DISABLED = "true";
  const skillStore = new InMemorySkillStore();
  const skillBundleStore = new InMemorySkillBundleStore();
  const app = createApp({ apiKeyStore: emptyApiKeyStore, skillStore, skillBundleStore });
  const filesOf = (id: string) => currentFiles(skillStore, skillBundleStore, id);
  return { app, skillStore, skillBundleStore, filesOf };
}

/** Build a multipart upload matching the POST /v1/skills wire shape. */
function uploadForm(files: { path: string; content: string }[]): FormData {
  const form = new FormData();
  form.set("paths", JSON.stringify(files.map((f) => f.path)));
  for (const f of files) {
    form.append("files", new Blob([f.content], { type: "text/markdown" }), f.path);
  }
  return form;
}

const SKILL_MD = `---
name: greeter
description: Greets warmly
---
Say hi.`;

describe("Skill Library routes", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a stable upload time and current metadata after online SKILL.md edits", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const uploadedAt = "2026-09-08T01:00:00.000Z";
    vi.setSystemTime(new Date(uploadedAt));
    const { app } = setup();
    const uploaded = await (await app.request("/v1/skills", {
      method: "POST",
      body: uploadForm([{ path: "SKILL.md", content: SKILL_MD }]),
    })).json();
    const skill = uploaded.data[0];
    expect(skill.createdAt).toBe(uploadedAt);
    expect(skill.updatedAt).toBe(uploadedAt);

    const editedAt = "2026-09-08T02:00:00.000Z";
    vi.setSystemTime(new Date(editedAt));
    const content = "---\nname: updated-greeter\ndescription: Updated greeting instructions\n---\nSay hello.";
    const saved = await app.request(`/v1/skills/${skill.id}/files/content`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "SKILL.md", content }),
    });
    expect(saved.status).toBe(200);

    const expected = {
      id: skill.id,
      name: "updated-greeter",
      description: "Updated greeting instructions",
      createdAt: uploadedAt,
      updatedAt: editedAt,
    };
    const listed = await (await app.request("/v1/skills")).json();
    expect(listed.data[0]).toMatchObject(expected);
    const detail = await (await app.request(`/v1/skills/${skill.id}`)).json();
    expect(detail).toMatchObject({ ...expected, files: ["SKILL.md"] });
  });

  it("keeps the current name when SKILL.md has no name and ignores other files' metadata", async () => {
    const { app, skillStore, skillBundleStore } = setup();
    const skill = await seedSkill(skillStore, skillBundleStore,
      { tenantId: "dev", name: "greeter", description: "Old description" }, { "SKILL.md": SKILL_MD });
    const write = (path: string, content: string) => app.request(`/v1/skills/${skill.id}/files/content`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    });

    expect((await write("SKILL.md", "# Greeting\nNew body description.")).status).toBe(200);
    expect(await skillStore.getById(skill.id)).toMatchObject({
      name: "greeter", description: "New body description.",
    });

    expect((await write("references/SKILL.md", "---\nname: nested\ndescription: Nested instructions\n---")).status).toBe(200);
    expect(await skillStore.getById(skill.id)).toMatchObject({
      name: "greeter", description: "New body description.",
    });

    expect((await write("SKILL.md", "# Heading only")).status).toBe(200);
    expect(await skillStore.getById(skill.id)).toMatchObject({ name: "greeter", description: "" });
  });

  it("single folder with root SKILL.md → 1 Skill", async () => {
    const { app } = setup();
    const res = await app.request("/v1/skills", {
      method: "POST",
      body: uploadForm([{ path: "SKILL.md", content: SKILL_MD }]),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe("greeter");
    expect(body.data[0].description).toBe("Greets warmly");
  });

  it("multi-subfolder → N Skills, each with its own bundle", async () => {
    const { app, filesOf } = setup();
    const res = await app.request("/v1/skills", {
      method: "POST",
      body: uploadForm([
        { path: "a/SKILL.md", content: "---\nname: a\ndescription: da\n---" },
        { path: "a/notes.md", content: "n" },
        { path: "b/SKILL.md", content: "---\nname: b\ndescription: db\n---" },
      ]),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    const a = body.data.find((s: { name: string }) => s.name === "a");
    const b = body.data.find((s: { name: string }) => s.name === "b");
    expect(Object.keys((await filesOf(a.id)).files)).toEqual(["SKILL.md", "notes.md"]);
    expect(Object.keys((await filesOf(b.id)).files)).toEqual(["SKILL.md"]);
  });

  it("no SKILL.md → 400", async () => {
    const { app, skillStore } = setup();
    const res = await app.request("/v1/skills", {
      method: "POST",
      body: uploadForm([{ path: "readme.md", content: "hi" }]),
    });
    expect(res.status).toBe(400);
    expect((await skillStore.list("dev")).data).toHaveLength(0);
  });

  it("ambiguous mix → 400", async () => {
    const { app } = setup();
    const res = await app.request("/v1/skills", {
      method: "POST",
      body: uploadForm([
        { path: "SKILL.md", content: SKILL_MD },
        { path: "child/SKILL.md", content: "---\nname: c\ndescription: dc\n---" },
      ]),
    });
    expect(res.status).toBe(400);
  });

  it("an invalid file path → 400 with nothing created", async () => {
    const { app, skillStore } = setup();
    const res = await app.request("/v1/skills", {
      method: "POST",
      body: uploadForm([{ path: "SKILL.md", content: SKILL_MD }, { path: "bad\\name.md", content: "x" }]),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_skill_file");
    expect((await skillStore.list("dev")).data).toHaveLength(0);
  });

  it("list, then delete removes the Skill from the list and keeps its bundle", async () => {
    const { app, skillStore, skillBundleStore } = setup();
    const create = await app.request("/v1/skills", {
      method: "POST",
      body: uploadForm([{ path: "SKILL.md", content: SKILL_MD }]),
    });
    const id = (await create.json()).data[0].id;
    const { bundleSha256 } = (await skillStore.getById(id))!;

    const list1 = await app.request("/v1/skills");
    expect((await list1.json()).data).toHaveLength(1);

    const del = await app.request(`/v1/skills/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()).type).toBe("skill_deleted");

    const list2 = await app.request("/v1/skills");
    expect((await list2.json()).data).toHaveLength(0);
    expect(await skillStore.getById(id)).toBeNull();
    // Bundles are content-addressed and may be shared by forks: GC is separate (#273).
    expect(await skillBundleStore.listFiles("dev", bundleSha256!)).not.toBeNull();
  });

  it("update metadata", async () => {
    const { app } = setup();
    const create = await app.request("/v1/skills", {
      method: "POST",
      body: uploadForm([{ path: "SKILL.md", content: SKILL_MD }]),
    });
    const id = (await create.json()).data[0].id;
    const upd = await app.request(`/v1/skills/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "new desc" }),
    });
    expect(upd.status).toBe(200);
    expect((await upd.json()).description).toBe("new desc");
  });
});

describe("Skill name uniqueness", () => {
  it("preflights the whole upload and replaces the complete tree only after confirmation", async () => {
    const { app, skillStore, filesOf } = setup();
    const send = (files: { path: string; content: string }[], overwrite = false) => {
      const form = uploadForm(files);
      if (overwrite) form.set("overwrite", "true");
      return app.request("/v1/skills", { method: "POST", body: form });
    };
    const first = await (await send([
      { path: "SKILL.md", content: SKILL_MD },
      { path: "old.txt", content: "old" },
    ])).json();
    const id = first.data[0].id;
    const files = [
      { path: "a/SKILL.md", content: "---\nname: another\n---\nnew" },
      { path: "b/SKILL.md", content: SKILL_MD + "\nnew" },
    ];
    const conflict = await send(files);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("skill_name_conflict");
    expect((await skillStore.list("dev")).data).toHaveLength(1);
    expect(Object.keys((await filesOf(id)).files)).toContain("old.txt");
    const confirmed = await send(files, true);
    expect(confirmed.status).toBe(201);
    expect((await skillStore.list("dev")).data).toHaveLength(2);
    const replaced = await filesOf(id);
    expect(Object.keys(replaced.files)).toEqual(["SKILL.md"]);
    expect(replaced.files["SKILL.md"]).toContain("new");
  });

  it("requires confirmation for duplicate names in one batch and keeps the last folder", async () => {
    const { app } = setup();
    const files = [{ path: "a/SKILL.md", content: SKILL_MD }, { path: "b/SKILL.md", content: SKILL_MD + "\nlast" }];
    expect((await app.request("/v1/skills", { method: "POST", body: uploadForm(files) })).status).toBe(409);
    const form = uploadForm(files);
    form.set("overwrite", "true");
    const saved = await (await app.request("/v1/skills", { method: "POST", body: form })).json();
    expect(saved.data).toHaveLength(1);
    const content = await (await app.request(`/v1/skills/${saved.data[0].id}/files/content?path=SKILL.md`)).json();
    expect(content.content).toContain("last");
  });

  it("rejects conflicting metadata and SKILL.md renames without changing files", async () => {
    const { app, skillStore, skillBundleStore, filesOf } = setup();
    await seedSkill(skillStore, skillBundleStore, { tenantId: "dev", name: "greeter", description: "" }, { "SKILL.md": SKILL_MD });
    const other = await seedSkill(skillStore, skillBundleStore, { tenantId: "dev", name: "other", description: "" }, { "SKILL.md": "original" });
    for (const [suffix, method, body] of [
      ["", "POST", { name: "greeter" }],
      ["/files/content", "PUT", { path: "SKILL.md", content: SKILL_MD }],
    ] as const) {
      const result = await app.request(`/v1/skills/${other.id}${suffix}`, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      expect(result.status).toBe(409);
      expect((await result.json()).code).toBe("skill_name_conflict");
    }
    expect((await skillStore.getById(other.id))?.name).toBe("other");
    expect(await filesOf(other.id)).toEqual({ sha256: other.bundleSha256, files: { "SKILL.md": "original" } });
  });

  it("keeps the old version if storing an overwrite upload fails", async () => {
    const { app, skillStore, skillBundleStore, filesOf } = setup();
    const skill = await seedSkill(skillStore, skillBundleStore,
      { tenantId: "dev", name: "greeter", description: "Original" }, { "SKILL.md": "original", "old.txt": "keep" });
    vi.spyOn(skillBundleStore, "put").mockRejectedValueOnce(new Error("Storage unavailable"));
    const form = uploadForm([{ path: "SKILL.md", content: SKILL_MD }]);
    form.set("overwrite", "true");
    expect((await app.request("/v1/skills", { method: "POST", body: form })).status).toBe(500);
    expect((await skillStore.getById(skill.id))?.description).toBe("Original");
    expect(await filesOf(skill.id)).toEqual({ sha256: skill.bundleSha256, files: { "SKILL.md": "original", "old.txt": "keep" } });
  });

  it("creates no Skill if storing a new upload fails", async () => {
    const { app, skillStore, skillBundleStore } = setup();
    vi.spyOn(skillBundleStore, "put").mockRejectedValueOnce(new Error("Storage unavailable"));
    const res = await app.request("/v1/skills", { method: "POST", body: uploadForm([{ path: "SKILL.md", content: SKILL_MD }]) });
    expect(res.status).toBe(500);
    expect((await skillStore.list("dev")).data).toHaveLength(0);
  });

  it("isolates names by tenant and prevents concurrent duplicate creation", async () => {
    const { app, skillStore, skillBundleStore } = setup();
    await seedSkill(skillStore, skillBundleStore, { tenantId: "other", name: "greeter", description: "" }, { "SKILL.md": SKILL_MD });
    const responses = await Promise.all([1, 2].map(() => app.request("/v1/skills", {
      method: "POST", body: uploadForm([{ path: "SKILL.md", content: SKILL_MD }]),
    })));
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await skillStore.list("dev")).data).toHaveLength(1);
    expect((await skillStore.list("other")).data).toHaveLength(1);
  });
});
