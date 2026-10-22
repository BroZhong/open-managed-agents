import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { InvalidSkillBundleError, packSkillBundle, type PackedSkillBundle, type SkillBundleStore } from "../src/index.js";

export interface SkillBundleStoreFixture {
  store: SkillBundleStore;
  /** Download an install URL the way a Sandbox would. */
  download(url: string): Promise<Uint8Array>;
}

const text = (value: string) => new TextEncoder().encode(value);
const same = (a: Uint8Array | null | undefined, b: Uint8Array) => Boolean(a) && Buffer.from(a!).equals(Buffer.from(b));

/** One behavioural contract for every {@link SkillBundleStore} implementation. */
export function skillBundleStoreContract(name: string, create: () => Promise<SkillBundleStoreFixture>, close?: () => Promise<void>) {
  describe(name, () => {
    let fixture: SkillBundleStoreFixture;
    let bundle: PackedSkillBundle;
    const font = new Uint8Array(Buffer.concat([Buffer.from([0, 1, 0, 0]), randomBytes(32 * 1024), Buffer.from("\r\n\0")]));
    const files = [
      { path: "SKILL.md", body: text("---\nname: fonts\n---\n") },
      { path: "fonts/字体 Regular.ttf", body: font },
      { path: "scripts/render.sh", body: text("#!/bin/sh\n"), mode: 0o755 },
    ];

    beforeEach(async () => {
      fixture = await create();
      bundle = await packSkillBundle(files);
    });
    afterAll(async () => { await close?.(); });

    it("stores a bundle and reads back the zip, file tree, single files and every file byte-identical", async () => {
      await fixture.store.put("tenant-a", bundle);
      expect(same(await fixture.store.get("tenant-a", bundle.sha256), bundle.bytes)).toBe(true);
      expect(await fixture.store.listFiles("tenant-a", bundle.sha256)).toEqual([
        { path: "SKILL.md", size: files[0].body.byteLength, mode: 0o644 },
        { path: "fonts/字体 Regular.ttf", size: font.byteLength, mode: 0o644 },
        { path: "scripts/render.sh", size: files[2].body.byteLength, mode: 0o755 },
      ]);
      expect(same(await fixture.store.readFile("tenant-a", bundle.sha256, "fonts/字体 Regular.ttf"), font)).toBe(true);
      const all = await fixture.store.readAll("tenant-a", bundle.sha256);
      expect(all?.map((file) => [file.path, file.mode])).toEqual([["SKILL.md", 0o644], ["fonts/字体 Regular.ttf", 0o644], ["scripts/render.sh", 0o755]]);
      for (const [index, file] of (all ?? []).entries()) expect(same(file.body, files[index].body)).toBe(true);
    });

    it("returns null for an absent bundle or file", async () => {
      const absent = "0".repeat(64);
      expect(await fixture.store.get("tenant-a", absent)).toBeNull();
      expect(await fixture.store.listFiles("tenant-a", absent)).toBeNull();
      expect(await fixture.store.readFile("tenant-a", absent, "SKILL.md")).toBeNull();
      expect(await fixture.store.readAll("tenant-a", absent)).toBeNull();
      await fixture.store.put("tenant-a", bundle);
      expect(await fixture.store.readFile("tenant-a", bundle.sha256, "missing.md")).toBeNull();
      expect(await fixture.store.readFile("tenant-a", bundle.sha256, "fonts")).toBeNull();
    });

    it("treats storing the same bundle again as harmless", async () => {
      await fixture.store.put("tenant-a", bundle);
      await fixture.store.put("tenant-a", { sha256: bundle.sha256, bytes: bundle.bytes.slice() });
      await Promise.all([fixture.store.put("tenant-a", bundle), fixture.store.put("tenant-a", bundle)]);
      expect(same(await fixture.store.get("tenant-a", bundle.sha256), bundle.bytes)).toBe(true);
    });

    it("isolates tenants", async () => {
      await fixture.store.put("tenant-a", bundle);
      expect(await fixture.store.get("tenant-b", bundle.sha256)).toBeNull();
      expect(await fixture.store.readAll("tenant-b", bundle.sha256)).toBeNull();
    });

    it("rejects bytes that do not match their sha256 or are not a bundle", async () => {
      const tampered = bundle.bytes.slice();
      tampered[tampered.length - 30] ^= 0xff;
      await expect(fixture.store.put("tenant-a", { sha256: bundle.sha256, bytes: tampered })).rejects.toBeInstanceOf(InvalidSkillBundleError);
      const other = await packSkillBundle([{ path: "SKILL.md", body: text("other") }]);
      await expect(fixture.store.put("tenant-a", { sha256: other.sha256, bytes: bundle.bytes })).rejects.toBeInstanceOf(InvalidSkillBundleError);
      const junk = text("not a zip");
      await expect(fixture.store.put("tenant-a", { sha256: createHash("sha256").update(junk).digest("hex"), bytes: junk }))
        .rejects.toBeInstanceOf(InvalidSkillBundleError);
      expect(await fixture.store.get("tenant-a", bundle.sha256)).toBeNull();
    });

    it("rejects invalid tenant ids and digests before touching storage", async () => {
      await expect(fixture.store.put("../tenant", bundle)).rejects.toThrow("Invalid Skill Bundle identity");
      await expect(fixture.store.get("tenant/a", bundle.sha256)).rejects.toThrow("Invalid Skill Bundle identity");
      await expect(fixture.store.get("tenant-a", bundle.sha256.toUpperCase())).rejects.toThrow("Invalid Skill Bundle identity");
      await expect(fixture.store.listFiles("tenant-a", "../x")).rejects.toThrow("Invalid Skill Bundle identity");
      await expect(fixture.store.createInstallUrl("", bundle.sha256, 60)).rejects.toThrow("Invalid Skill Bundle identity");
    });

    it("returns copies: modifying a result never changes the stored bundle", async () => {
      const input = bundle.bytes.slice();
      await fixture.store.put("tenant-a", { sha256: bundle.sha256, bytes: input });
      input.fill(0);
      (await fixture.store.get("tenant-a", bundle.sha256))!.fill(0);
      (await fixture.store.readFile("tenant-a", bundle.sha256, "SKILL.md"))!.fill(0);
      (await fixture.store.readAll("tenant-a", bundle.sha256))![0].body.fill(0);
      expect(same(await fixture.store.get("tenant-a", bundle.sha256), bundle.bytes)).toBe(true);
      expect(same(await fixture.store.readFile("tenant-a", bundle.sha256, "SKILL.md"), files[0].body)).toBe(true);
    });

    it("signs an install URL that downloads the exact zip", async () => {
      await fixture.store.put("tenant-a", bundle);
      const url = await fixture.store.createInstallUrl("tenant-a", bundle.sha256, 300);
      expect(same(await fixture.download(url), bundle.bytes)).toBe(true);
    });

    it("bounds install URL expiry to whole seconds between 1 and 900", async () => {
      await fixture.store.put("tenant-a", bundle);
      for (const expiry of [0, 901, 1.5, Number.NaN]) {
        await expect(fixture.store.createInstallUrl("tenant-a", bundle.sha256, expiry)).rejects.toThrow("between 1 and 900 seconds");
      }
      await expect(fixture.store.createInstallUrl("tenant-a", bundle.sha256, 1)).resolves.toEqual(expect.any(String));
      await expect(fixture.store.createInstallUrl("tenant-a", bundle.sha256, 900)).resolves.toEqual(expect.any(String));
    });
  });
}
