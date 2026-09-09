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
