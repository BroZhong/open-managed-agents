import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { SKILL_BUNDLE_MAX_BYTES, packSkillBundle, type PackedSkillBundle, type SkillStoreUpdateInput, type SkillStoreUpdateOptions } from "@oma-server/store";
import { InMemorySkillBundleStore, InMemorySkillStore } from "@oma-server/store-memory";
import { PNG, TTF, bytes, currentFiles, seedSkill } from "./fixtures/skill-bundles.js";

/**
 * ADR-0022 acceptance for the Skill routes (#264): every Skill version is one
 * immutable Skill Bundle, every edit publishes a new one by compare-and-set.
 */

const SKILL_MD = "---\nname: fonts\ndescription: Subtitle fonts\n---\nUse the fonts.";

/** Holds every `put` until `parties` of them have arrived, so concurrent edits read the same version. */
class GatedSkillBundleStore extends InMemorySkillBundleStore {
  private parties = 0;
  private waiting: (() => void)[] = [];

  arm(parties: number) { this.parties = parties; }

  override async put(tenantId: string, bundle: Pick<PackedSkillBundle, "sha256" | "bytes">) {
    if (this.parties) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        if (this.waiting.length === this.parties) {
          this.parties = 0;
          for (const release of this.waiting.splice(0)) release();
        }
      });
    }
    return super.put(tenantId, bundle);
  }
}

function setup() {
  vi.stubEnv("AUTH_DISABLED", "true");
  const skillStore = new InMemorySkillStore();
  const skillBundleStore = new GatedSkillBundleStore();
  const app = createApp({ apiKeyStore: { async findByKeyHash() { return null; } }, skillStore, skillBundleStore });
  const seed = (files: Record<string, string | Uint8Array> = { "SKILL.md": SKILL_MD, "notes.md": "notes" }) =>
    seedSkill(skillStore, skillBundleStore, { tenantId: "dev", name: "fonts", description: "Subtitle fonts" }, files);
  const json = (method: string, path: string, body: unknown) => app.request(path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const upload = (files: Record<string, string | Uint8Array>, overwrite = false) => {
    const form = new FormData();
    form.set("paths", JSON.stringify(Object.keys(files)));
    if (overwrite) form.set("overwrite", "true");
    for (const [path, body] of Object.entries(files)) form.append("files", new Blob([body]), path.split("/").pop());
    return app.request("/v1/skills", { method: "POST", body: form });
  };
  const filesOf = (id: string) => currentFiles(skillStore, skillBundleStore, id);
  return { app, skillStore, skillBundleStore, seed, json, upload, filesOf };
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Skill files are bytes end to end", () => {
  it("stores an uploaded TTF byte-identical and leaves compiled Python out", async () => {
    const { upload, skillStore, skillBundleStore, app } = setup();
    const res = await upload({
      "fonts/SKILL.md": SKILL_MD,
      "fonts/assets/Regular.ttf": TTF,
      "fonts/scripts/__pycache__/render.cpython-312.pyc": randomBytes(64),
      "fonts/scripts/render.py": "print('render')\n",
    });
    expect(res.status).toBe(201);
    const [created] = (await res.json()).data;
    const skill = (await skillStore.getById(created.id))!;
    expect(skill.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(skill.bundleSize).toBe(bytes(SKILL_MD).byteLength + TTF.byteLength + bytes("print('render')\n").byteLength);
    const stored = await skillBundleStore.readFile("dev", skill.bundleSha256!, "assets/Regular.ttf");
    expect(Buffer.from(stored!).equals(Buffer.from(TTF))).toBe(true);
    expect((await (await app.request(`/v1/skills/${created.id}/files`)).json()).data)
      .toEqual(["SKILL.md", "assets/Regular.ttf", "scripts/render.py"]);
  });
});

describe("every edit publishes a new Skill Bundle by compare-and-set", () => {
  const edits: [string, (env: ReturnType<typeof setup>, id: string) => Promise<Response>, Record<string, string>][] = [
    ["write a file", ({ json }, id) => json("PUT", `/v1/skills/${id}/files/content`, { path: "notes.md", content: "edited" }),
      { "SKILL.md": SKILL_MD, "notes.md": "edited" }],
    ["create a file", ({ json }, id) => json("PUT", `/v1/skills/${id}/files/content`, { path: "docs/new.md", content: "new" }),
      { "SKILL.md": SKILL_MD, "docs/new.md": "new", "notes.md": "notes" }],
    ["rename the Skill through SKILL.md", ({ json }, id) => json("PUT", `/v1/skills/${id}/files/content`, { path: "SKILL.md", content: "---\nname: renamed\n---" }),
      { "SKILL.md": "---\nname: renamed\n---", "notes.md": "notes" }],
    ["delete a file", ({ app }, id) => app.request(`/v1/skills/${id}/files/content?path=notes.md`, { method: "DELETE" }),
      { "SKILL.md": SKILL_MD }],
    ["rename a file", ({ json }, id) => json("POST", `/v1/skills/${id}/files/rename`, { from: "notes.md", to: "docs/notes.md" }),
      { "SKILL.md": SKILL_MD, "docs/notes.md": "notes" }],
    ["replace the folder by an overwrite upload", ({ upload }) => upload({ "SKILL.md": SKILL_MD, "other.md": "other" }, true),
      { "SKILL.md": SKILL_MD, "other.md": "other" }],
  ];

  for (const [name, edit, expected] of edits) {
    it(`${name}: a new current version, the old bundle unchanged`, async () => {
      const env = setup();
      const skill = await env.seed();
      const before = await env.skillBundleStore.get("dev", skill.bundleSha256!);
      const res = await edit(env, skill.id);
      expect(res.status, await res.clone().text()).toBeLessThan(300);
      const after = await env.filesOf(skill.id);
      expect(after.sha256).not.toBe(skill.bundleSha256);
      expect(after.files).toEqual(expected);
      expect(Buffer.from((await env.skillBundleStore.get("dev", skill.bundleSha256!))!).equals(Buffer.from(before!))).toBe(true);
      expect(await env.skillBundleStore.readFile("dev", skill.bundleSha256!, "notes.md")).toEqual(bytes("notes"));
    });
  }

  it("keeps the other files' bytes and modes, a renamed file's bytes and an edited file's mode", async () => {
    const { json, skillStore, skillBundleStore } = setup();
    const packed = await packSkillBundle([
      { path: "SKILL.md", body: bytes(SKILL_MD) },
      { path: "assets/Regular.ttf", body: TTF },
      { path: "scripts/render.sh", body: bytes("#!/bin/sh\n"), mode: 0o755 },
    ]);
    await skillBundleStore.put("dev", packed);
    const skill = await skillStore.create({ tenantId: "dev", name: "fonts", description: "", bundleSha256: packed.sha256, bundleSize: packed.size });
    expect((await json("POST", `/v1/skills/${skill.id}/files/rename`, { from: "assets/Regular.ttf", to: "fonts/Regular.ttf" })).status).toBe(200);
    expect((await json("PUT", `/v1/skills/${skill.id}/files/content`, { path: "scripts/render.sh", content: "#!/bin/sh\necho hi\n" })).status).toBe(200);
    const { bundleSha256 } = (await skillStore.getById(skill.id))!;
    expect(await skillBundleStore.listFiles("dev", bundleSha256!)).toEqual([
      { path: "SKILL.md", size: bytes(SKILL_MD).byteLength, mode: 0o644 },
      { path: "fonts/Regular.ttf", size: TTF.byteLength, mode: 0o644 },
      { path: "scripts/render.sh", size: bytes("#!/bin/sh\necho hi\n").byteLength, mode: 0o755 },
    ]);
    expect(Buffer.from((await skillBundleStore.readFile("dev", bundleSha256!, "fonts/Regular.ttf"))!).equals(Buffer.from(TTF))).toBe(true);
  });

  it("a metadata change keeps the version and its files", async () => {
    const { seed, json, filesOf, skillStore } = setup();
    const skill = await seed();
    const res = await json("POST", `/v1/skills/${skill.id}`, { name: "subtitle-fonts", description: "Edited" });
    expect(res.status).toBe(200);
    expect(await skillStore.getById(skill.id)).toMatchObject({ name: "subtitle-fonts", description: "Edited", bundleSha256: skill.bundleSha256 });
    expect((await filesOf(skill.id)).files).toEqual({ "SKILL.md": SKILL_MD, "notes.md": "notes" });
  });

  it("renaming a file onto SKILL.md replaces it and refreshes the Skill's metadata", async () => {
    const { seed, json, filesOf, skillStore } = setup();
    const skill = await seed({ "SKILL.md": SKILL_MD, "draft.md": "---\nname: drafted\ndescription: From the draft\n---" });
    expect((await json("POST", `/v1/skills/${skill.id}/files/rename`, { from: "draft.md", to: "SKILL.md" })).status).toBe(200);
    expect((await filesOf(skill.id)).files).toEqual({ "SKILL.md": "---\nname: drafted\ndescription: From the draft\n---" });
    expect(await skillStore.getById(skill.id)).toMatchObject({ name: "drafted", description: "From the draft" });
  });
});

describe("concurrent edits based on the same version", () => {
  it("the later committer gets 409 and its change is not merged", async () => {
    const { seed, json, filesOf, skillBundleStore } = setup();
    const skill = await seed();
    skillBundleStore.arm(2);
    const responses = await Promise.all([
      json("PUT", `/v1/skills/${skill.id}/files/content`, { path: "a.md", content: "A" }),
      json("PUT", `/v1/skills/${skill.id}/files/content`, { path: "b.md", content: "B" }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = responses.find((r) => r.status === 409)!;
    expect(await loser.json()).toEqual({
      error: "The Skill was changed by another request since this edit read it. Reload the Skill and retry.",
      code: "skill_version_conflict",
    });
    const { files } = await filesOf(skill.id);
    expect(["a.md", "b.md"].filter((path) => path in files)).toHaveLength(1);
  });

  it("a file edit and an overwrite upload of the same version: one wins, the other gets 409", async () => {
    const { seed, app, upload, filesOf, skillBundleStore } = setup();
    const skill = await seed();
    skillBundleStore.arm(2);
    const [edit, replace] = await Promise.all([
      app.request(`/v1/skills/${skill.id}/files/content?path=notes.md`, { method: "DELETE" }),
      upload({ "SKILL.md": SKILL_MD, "replaced.md": "r" }, true),
    ]);
    const statuses = [edit.status, replace.status];
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);
    expect(statuses.filter((status) => status === 200 || status === 201)).toHaveLength(1);
    const { files } = await filesOf(skill.id);
    expect(Object.keys(files)).toEqual(replace.status === 201 ? ["SKILL.md", "replaced.md"] : ["SKILL.md"]);
  });

  it("a metadata change based on a replaced version gets 409 and keeps the file edit", async () => {
    const env = setup();
    const skill = await env.seed();
    // Hold the metadata update until a file edit has published a new version.
    let fileEdit: Promise<Response> | undefined;
    const update = env.skillStore.update.bind(env.skillStore);
    vi.spyOn(env.skillStore, "update").mockImplementation(async (id: string, input: SkillStoreUpdateInput, options?: SkillStoreUpdateOptions) => {
      if (input.description === "Edited" && !fileEdit) {
        fileEdit = env.json("PUT", `/v1/skills/${skill.id}/files/content`, { path: "notes.md", content: "edited" });
        expect((await fileEdit).status).toBe(200);
      }
      return update(id, input, options);
    });
    const res = await env.json("POST", `/v1/skills/${skill.id}`, { description: "Edited" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("skill_version_conflict");
    const current = (await env.skillStore.getById(skill.id))!;
    expect(current.description).toBe("Subtitle fonts");
    expect((await env.filesOf(skill.id)).files["notes.md"]).toBe("edited");
  });
});

describe("a Skill holds at most 50 MB uncompressed", () => {
  it("rejects an oversized upload with 413 and creates nothing", async () => {
    const { upload, skillStore } = setup();
    const res = await upload({ "SKILL.md": SKILL_MD, "assets/big.bin": new Uint8Array(SKILL_BUNDLE_MAX_BYTES) });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe("skill_bundle_too_large");
    expect(body.error).toMatch(/uncompressed exceeds the 50 MB/);
    expect((await skillStore.list("dev")).data).toHaveLength(0);
  });

  it("rejects an edit that would exceed the limit with 413 and keeps the version", async () => {
    const { seed, json, skillStore } = setup();
    const skill = await seed();
    const res = await json("PUT", `/v1/skills/${skill.id}/files/content`, { path: "big.md", content: "a".repeat(SKILL_BUNDLE_MAX_BYTES) });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/50 MB/);
    expect((await skillStore.getById(skill.id))?.bundleSha256).toBe(skill.bundleSha256);
  });
});

describe("SKILL.md always exists", () => {
  it("refuses to delete SKILL.md or rename it away, and keeps the version", async () => {
    const { seed, json, app, skillStore } = setup();
    const skill = await seed();
    for (const res of [
      await app.request(`/v1/skills/${skill.id}/files/content?path=SKILL.md`, { method: "DELETE" }),
      await app.request(`/v1/skills/${skill.id}/files/content?path=/SKILL.md`, { method: "DELETE" }),
      await json("POST", `/v1/skills/${skill.id}/files/rename`, { from: "SKILL.md", to: "README.md" }),
    ]) {
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/SKILL\.md/);
    }
    expect((await skillStore.getById(skill.id))?.bundleSha256).toBe(skill.bundleSha256);
  });

  it("deleting an absent file changes nothing; renaming one returns 404", async () => {
    const { seed, json, app, skillStore } = setup();
    const skill = await seed();
    const deleted = await app.request(`/v1/skills/${skill.id}/files/content?path=missing.md`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ type: "skill_file_deleted", id: skill.id, path: "missing.md" });
    expect((await json("POST", `/v1/skills/${skill.id}/files/rename`, { from: "missing.md", to: "x.md" })).status).toBe(404);
    expect(await skillStore.getById(skill.id)).toMatchObject({ bundleSha256: skill.bundleSha256, updatedAt: skill.updatedAt });
  });

  it("rejects a write that makes a path both a file and a directory with 400", async () => {
    const { seed, json } = setup();
    const skill = await seed();
    const res = await json("PUT", `/v1/skills/${skill.id}/files/content`, { path: "notes.md/child.md", content: "x" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_skill_file");
  });
});

/** POST /v1/skills/:id/files/upload, shaped like the Workspace upload. */
function uploadInto(
  app: ReturnType<typeof setup>["app"],
  id: string,
  files: { name: string; body: string | Uint8Array; type?: string }[],
  fields: Record<string, string> = {},
) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  for (const file of files) form.append("files", new Blob([file.body], { type: file.type ?? "" }), file.name);
  return app.request(`/v1/skills/${id}/files/upload`, { method: "POST", body: form });
}

const INVALID_UTF8 = new Uint8Array([0x23, 0x20, 0xc3, 0x28, 0x0a]);

describe("binary files in an existing Skill (#269)", () => {
  it("uploads a TTF and the byte endpoint returns it byte-identical", async () => {
    const env = setup();
    const skill = await env.seed();
    const res = await uploadInto(env.app, skill.id, [{ name: "Regular.ttf", body: TTF }], { path: "assets/Regular.ttf" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ data: [{ path: "assets/Regular.ttf" }] });
    expect((await env.filesOf(skill.id)).sha256).not.toBe(skill.bundleSha256);

    const raw = await env.app.request(`/v1/skills/${skill.id}/files/raw?path=assets/Regular.ttf`);
    expect(raw.status).toBe(200);
    expect(Buffer.from(await raw.arrayBuffer()).equals(Buffer.from(TTF))).toBe(true);
    expect(Object.fromEntries(raw.headers)).toMatchObject({
      "content-type": "font/ttf",
      "content-length": String(TTF.byteLength),
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "no-store",
    });
    const download = await env.app.request(`/v1/skills/${skill.id}/files/raw?path=assets/Regular.ttf&download=1`);
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="Regular.ttf"');
  });

  it("places several files under destDir, keeping uploaded folder paths, as one new version", async () => {
    const env = setup();
    const skill = await env.seed();
    const put = vi.spyOn(env.skillBundleStore, "put");
    const res = await uploadInto(env.app, skill.id, [
      { name: "Regular.ttf", body: TTF },
      { name: "icons/logo.png", body: PNG, type: "image/png" },
    ], { destDir: "assets/" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json()).data).toEqual([{ path: "assets/Regular.ttf" }, { path: "assets/icons/logo.png" }]);
    expect(put).toHaveBeenCalledTimes(1);
    const { bundleSha256 } = (await env.skillStore.getById(skill.id))!;
    expect((await env.skillBundleStore.listFiles("dev", bundleSha256!))!.map((entry) => entry.path))
      .toEqual(["SKILL.md", "assets/Regular.ttf", "assets/icons/logo.png", "notes.md"]);
    const png = await env.app.request(`/v1/skills/${skill.id}/files/raw?path=${encodeURIComponent("assets/icons/logo.png")}`);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await png.arrayBuffer()).equals(Buffer.from(PNG))).toBe(true);
  });

  it("replaces an existing file in place, keeping its mode", async () => {
    const { app, skillStore, skillBundleStore } = setup();
    const packed = await packSkillBundle([
      { path: "SKILL.md", body: bytes(SKILL_MD) },
      { path: "scripts/render.sh", body: bytes("#!/bin/sh\n"), mode: 0o755 },
    ]);
    await skillBundleStore.put("dev", packed);
    const skill = await skillStore.create({ tenantId: "dev", name: "fonts", description: "", bundleSha256: packed.sha256, bundleSize: packed.size });
    const res = await uploadInto(app, skill.id, [{ name: "render.sh", body: "#!/bin/sh\necho hi\n" }], { destDir: "scripts" });
    expect(res.status).toBe(200);
    const { bundleSha256 } = (await skillStore.getById(skill.id))!;
    expect(await skillBundleStore.listFiles("dev", bundleSha256!)).toContainEqual({ path: "scripts/render.sh", size: 18, mode: 0o755 });
    expect(await (await app.request(`/v1/skills/${skill.id}/files/content?path=scripts/render.sh`)).json())
      .toEqual({ path: "scripts/render.sh", content: "#!/bin/sh\necho hi\n" });
  });

  it("an uploaded SKILL.md refreshes the Skill's name and description", async () => {
    const { app, seed, skillStore } = setup();
    const skill = await seed();
    const res = await uploadInto(app, skill.id, [{ name: "SKILL.md", body: "---\nname: uploaded\ndescription: From the upload\n---" }]);
    expect(res.status).toBe(200);
    expect(await skillStore.getById(skill.id)).toMatchObject({ name: "uploaded", description: "From the upload" });
  });

  it("reads a binary file as metadata and a text file as its exact content", async () => {
    const { app, seed } = setup();
    const skill = await seed({
      "SKILL.md": SKILL_MD,
      "notes.md": "notes",
      "LICENSE": "MIT",
      "bom.txt": "﻿hello",
      "assets/Regular.ttf": TTF,
      "assets/logo.png": PNG,
      "assets/icon.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
      "broken.md": INVALID_UTF8,
      "zeros.bin": new Uint8Array(16),
    });
    const read = async (path: string) => {
      const res = await app.request(`/v1/skills/${skill.id}/files/content?path=${encodeURIComponent(path)}`);
      expect(res.status).toBe(200);
      return res.json();
    };
    expect(await read("notes.md")).toEqual({ path: "notes.md", content: "notes" });
    expect(await read("LICENSE")).toEqual({ path: "LICENSE", content: "MIT" });
    expect(await read("bom.txt")).toEqual({ path: "bom.txt", content: "﻿hello" });
    expect(await read("assets/Regular.ttf")).toEqual({ path: "assets/Regular.ttf", binary: true, size: TTF.byteLength, contentType: "font/ttf" });
    expect(await read("assets/logo.png")).toEqual({ path: "assets/logo.png", binary: true, size: PNG.byteLength, contentType: "image/png" });
    expect(await read("assets/icon.svg")).toMatchObject({ binary: true, contentType: "image/svg+xml" });
    expect(await read("broken.md")).toEqual({ path: "broken.md", binary: true, size: 5, contentType: "text/markdown; charset=utf-8" });
    expect(await read("zeros.bin")).toEqual({ path: "zeros.bin", binary: true, size: 16, contentType: "application/octet-stream" });
  });

  it("rejects compiled Python with 400 instead of dropping it silently", async () => {
    const { app, json, seed, skillStore } = setup();
    const skill = await seed();
    for (const res of [
      await uploadInto(app, skill.id, [{ name: "render.cpython-312.pyc", body: randomBytes(32) }], { destDir: "scripts" }),
      await uploadInto(app, skill.id, [{ name: "render.py", body: "print()" }], { destDir: "scripts/__pycache__" }),
      await uploadInto(app, skill.id, [{ name: "ok.md", body: "ok" }, { name: "__pycache__/x.pyc", body: randomBytes(8) }]),
      await json("PUT", `/v1/skills/${skill.id}/files/content`, { path: "scripts/render.pyc", content: "x" }),
      await json("POST", `/v1/skills/${skill.id}/files/rename`, { from: "notes.md", to: "__pycache__/notes.md" }),
    ]) {
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("invalid_skill_file");
      expect(body.error).toMatch(/\.pyc files and __pycache__ directories/);
    }
    expect((await skillStore.getById(skill.id))?.bundleSha256).toBe(skill.bundleSha256);
  });

  it("rejects an upload over 50 MB uncompressed with 413 and keeps the version", async () => {
    const { app, seed, skillStore } = setup();
    const skill = await seed();
    const res = await uploadInto(app, skill.id, [{ name: "big.bin", body: new Uint8Array(SKILL_BUNDLE_MAX_BYTES) }]);
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("skill_bundle_too_large");
    expect((await skillStore.getById(skill.id))?.bundleSha256).toBe(skill.bundleSha256);
  });

  it("an upload and an edit based on the same version: one wins, the other gets 409", async () => {
    const { app, json, seed, filesOf, skillBundleStore } = setup();
    const skill = await seed();
    skillBundleStore.arm(2);
    const [upload, edit] = await Promise.all([
      uploadInto(app, skill.id, [{ name: "Regular.ttf", body: TTF }]),
      json("PUT", `/v1/skills/${skill.id}/files/content`, { path: "notes.md", content: "edited" }),
    ]);
    expect([upload.status, edit.status].sort()).toEqual([200, 409]);
    const loser = upload.status === 409 ? upload : edit;
    expect((await loser.json()).code).toBe("skill_version_conflict");
    // The winner's change alone is published; the loser's is not merged.
    const { files } = await filesOf(skill.id);
    expect({ uploaded: "Regular.ttf" in files, edited: files["notes.md"] === "edited" })
      .toEqual(upload.status === 200 ? { uploaded: true, edited: false } : { uploaded: false, edited: true });
  });

  it("rejects malformed uploads with 400 and changes nothing", async () => {
    const { app, seed, skillStore } = setup();
    const skill = await seed();
    const empty = new FormData();
    empty.set("destDir", "assets");
    for (const res of [
      await app.request(`/v1/skills/${skill.id}/files/upload`, { method: "POST", body: empty }),
      await uploadInto(app, skill.id, [{ name: "x.md", body: "x" }], { path: "../x.md" }),
      await uploadInto(app, skill.id, [{ name: "x.md", body: "x" }], { destDir: "../outside" }),
      await uploadInto(app, skill.id, [{ name: "x.md", body: "x" }], { destDir: "notes.md" }),
    ]) {
      expect(res.status, await res.clone().text()).toBe(400);
    }
    expect((await skillStore.getById(skill.id))?.bundleSha256).toBe(skill.bundleSha256);
  });

  it("serves only the caller's Skills and files that exist", async () => {
    const { app, skillStore, skillBundleStore, seed } = setup();
    const own = await seed();
    const other = await seedSkill(skillStore, skillBundleStore, { tenantId: "other", name: "theirs", description: "" }, { "SKILL.md": SKILL_MD });
    for (const res of [
      await app.request(`/v1/skills/${other.id}/files/raw?path=SKILL.md`),
      await app.request(`/v1/skills/${other.id}/files/content?path=SKILL.md`),
      await uploadInto(app, other.id, [{ name: "x.md", body: "x" }]),
      await app.request(`/v1/skills/${own.id}/files/raw?path=missing.ttf`),
    ]) {
      expect(res.status).toBe(404);
    }
    expect((await app.request(`/v1/skills/${own.id}/files/raw`)).status).toBe(400);
    expect((await skillStore.getById(other.id))?.bundleSha256).toBe(other.bundleSha256);
  });
});
