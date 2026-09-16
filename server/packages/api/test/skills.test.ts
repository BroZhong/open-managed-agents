import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { ApiKeyStore } from "../src/types.js";
import { InMemorySkillStore, InMemorySkillArtifactStore } from "@oma-server/store-memory";

const emptyApiKeyStore: ApiKeyStore = { async findByKeyHash() { return null; } };

function setup() {
  process.env.AUTH_DISABLED = "true";
  const skillStore = new InMemorySkillStore();
  const skillArtifactStore = new InMemorySkillArtifactStore();
  const app = createApp({ apiKeyStore: emptyApiKeyStore, skillStore, skillArtifactStore });
  return { app, skillStore, skillArtifactStore };
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
    expect(detail).toMatchObject(expected);
  });

  it("keeps the current name when SKILL.md has no name and ignores other files' metadata", async () => {
    const { app, skillStore } = setup();
    const skill = await skillStore.create({ tenantId: "dev", name: "greeter", description: "Old description" });
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

  it("multi-subfolder → N Skills, bodies stored in S3", async () => {
    const { app, skillArtifactStore } = setup();
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
    const files = await skillArtifactStore.list("dev", a.id);
    expect(files.sort()).toEqual(["SKILL.md", "notes.md"].sort());
  });

  it("no SKILL.md → 400", async () => {
    const { app } = setup();
    const res = await app.request("/v1/skills", {
      method: "POST",
      body: uploadForm([{ path: "readme.md", content: "hi" }]),
    });
    expect(res.status).toBe(400);
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

  it("list, then delete removes from list and S3", async () => {
    const { app, skillArtifactStore } = setup();
    const create = await app.request("/v1/skills", {
      method: "POST",
      body: uploadForm([{ path: "SKILL.md", content: SKILL_MD }]),
    });
    const id = (await create.json()).data[0].id;

    const list1 = await app.request("/v1/skills");
    expect((await list1.json()).data).toHaveLength(1);

    const del = await app.request(`/v1/skills/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()).type).toBe("skill_deleted");

    const list2 = await app.request("/v1/skills");
    expect((await list2.json()).data).toHaveLength(0);
    expect(await skillArtifactStore.list("dev", id)).toHaveLength(0);
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
    const { app, skillStore, skillArtifactStore } = setup();
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
    expect(await skillArtifactStore.list("dev", id)).toContain("old.txt");
    const confirmed = await send(files, true);
    expect(confirmed.status).toBe(201);
    expect((await skillStore.list("dev")).data).toHaveLength(2);
    expect(await skillArtifactStore.list("dev", id)).toEqual(["SKILL.md"]);
    expect(new TextDecoder().decode(await skillArtifactStore.get("dev", id, "SKILL.md") ?? undefined)).toContain("new");
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
    const { app, skillStore, skillArtifactStore } = setup();
    await skillStore.create({ tenantId: "dev", name: "greeter", description: "" });
    const other = await skillStore.create({ tenantId: "dev", name: "other", description: "" });
    await skillArtifactStore.put("dev", other.id, "SKILL.md", "original");
    for (const [suffix, method, body] of [
      ["", "POST", { name: "greeter" }],
      ["/files/content", "PUT", { path: "SKILL.md", content: SKILL_MD }],
    ] as const) {
      const result = await app.request(`/v1/skills/${other.id}${suffix}`, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      expect(result.status).toBe(409);
    }
    expect((await skillStore.getById(other.id))?.name).toBe("other");
    expect(new TextDecoder().decode((await skillArtifactStore.get("dev", other.id, "SKILL.md"))!)).toBe("original");
  });

  it("restores the old tree if an overwrite upload fails", async () => {
    const { app, skillStore, skillArtifactStore } = setup();
    const skill = await skillStore.create({ tenantId: "dev", name: "greeter", description: "Original" });
    await skillArtifactStore.put("dev", skill.id, "SKILL.md", "original");
    await skillArtifactStore.put("dev", skill.id, "old.txt", "keep");
    vi.spyOn(skillArtifactStore, "put").mockRejectedValueOnce(new Error("Storage unavailable"));
    const form = uploadForm([{ path: "SKILL.md", content: SKILL_MD }]);
    form.set("overwrite", "true");
    expect((await app.request("/v1/skills", { method: "POST", body: form })).status).toBe(500);
    expect((await skillStore.getById(skill.id))?.description).toBe("Original");
    expect(new TextDecoder().decode((await skillArtifactStore.get("dev", skill.id, "SKILL.md"))!)).toBe("original");
    expect(await skillArtifactStore.list("dev", skill.id)).toContain("old.txt");
  });

  it("isolates names by tenant and prevents concurrent duplicate creation", async () => {
    const { app, skillStore } = setup();
    await skillStore.create({ tenantId: "other", name: "greeter", description: "" });
    const responses = await Promise.all([1, 2].map(() => app.request("/v1/skills", {
      method: "POST", body: uploadForm([{ path: "SKILL.md", content: SKILL_MD }]),
    })));
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await skillStore.list("dev")).data).toHaveLength(1);
    expect((await skillStore.list("other")).data).toHaveLength(1);
  });
});
