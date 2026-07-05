import { describe, it, expect, beforeEach } from "vitest";
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
