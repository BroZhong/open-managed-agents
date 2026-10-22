import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { SKILL_BUNDLE_MAX_BYTES, packSkillBundle, type PackedSkillBundle, type SkillStoreUpdateInput, type SkillStoreUpdateOptions } from "@oma-server/store";
import { InMemorySkillBundleStore, InMemorySkillStore } from "@oma-server/store-memory";
import { bytes, currentFiles, seedSkill } from "./fixtures/skill-bundles.js";

/**
 * ADR-0022 acceptance for the Skill routes (#264): every Skill version is one
 * immutable Skill Bundle, every edit publishes a new one by compare-and-set.
 */

const SKILL_MD = "---\nname: fonts\ndescription: Subtitle fonts\n---\nUse the fonts.";
/** A TrueType header followed by bytes that are not valid UTF-8. */
const TTF = new Uint8Array(Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), randomBytes(64 * 1024), Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x80])]));

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
