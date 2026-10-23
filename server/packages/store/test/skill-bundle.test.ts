import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import yazl from "yazl";
import yauzl from "yauzl";
import {
  EMPTY_SKILL_SET_HASH,
  InvalidSkillBundleError,
  InvalidSkillFileError,
  SKILL_BUNDLE_MAX_BYTES,
  SkillBundleTooLargeError,
  listSkillBundle,
  packSkillBundle,
  readSkillBundleFile,
  skillSetHash,
  unpackSkillBundle,
} from "../src/index.js";

const text = (value: string) => new TextEncoder().encode(value);
/** A font-shaped binary: TrueType magic, every byte value, CR/LF/NUL and random bytes. */
const FONT = new Uint8Array(Buffer.concat([
  Buffer.from([0x00, 0x01, 0x00, 0x00]),
  Buffer.from(Array.from({ length: 256 }, (_, byte) => byte)),
  Buffer.from("\r\n\0\r"),
  randomBytes(64 * 1024),
]));
const skillFiles = () => [
  { path: "SKILL.md", body: text("---\nname: demo\n---\nUse me.\n") },
  { path: "scripts/run.sh", body: text("#!/bin/sh\necho ok\n"), mode: 0o755 },
  { path: "fonts/NotoSans-Regular.ttf", body: FONT.slice() },
  { path: "docs/空 文件.txt", body: new Uint8Array() },
];
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("packSkillBundle", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("packs the same content to identical bytes regardless of input order or local timezone", async () => {
    const files = skillFiles();
    process.env.TZ = "UTC";
    const first = await packSkillBundle(files);
    process.env.TZ = "Asia/Shanghai";
    const second = await packSkillBundle([...files].reverse());
    process.env.TZ = "America/Los_Angeles";
    const third = await packSkillBundle(files.map((file) => ({ ...file, body: file.body.slice() })));
    expect(second.sha256).toBe(first.sha256);
    expect(third.sha256).toBe(first.sha256);
    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true);
    expect(first.sha256).toBe(sha256(first.bytes));
    expect(first).toMatchObject({
      size: files.reduce((total, file) => total + file.body.byteLength, 0),
      files: 4,
      filtered: [],
    });
  });

  it("changes the sha256 when content, a filename or the executable bit changes", async () => {
    const base = await packSkillBundle(skillFiles());
    const variants = [
      skillFiles().map((file) => file.path === "SKILL.md" ? { ...file, body: text("---\nname: demo\n---\nUse me!\n") } : file),
      skillFiles().map((file) => file.path === "scripts/run.sh" ? { ...file, path: "scripts/start.sh" } : file),
      skillFiles().map((file) => file.path === "scripts/run.sh" ? { ...file, mode: 0o644 } : file),
      skillFiles().map((file) => file.path === "SKILL.md" ? { ...file, mode: 0o700 } : file),
    ];
    const hashes = new Set([base.sha256]);
    for (const files of variants) hashes.add((await packSkillBundle(files)).sha256);
    expect(hashes.size).toBe(variants.length + 1);
  });

  it("normalizes permission bits: executable iff any x bit is set, otherwise 0644", async () => {
    const same = async (mode: number | undefined) => (await packSkillBundle([{ path: "a", body: text("x"), ...(mode === undefined ? {} : { mode }) }])).sha256;
    expect(await same(0o600)).toBe(await same(undefined));
    expect(await same(0o100664)).toBe(await same(0o644));
    expect(await same(0o100)).toBe(await same(0o755));
    expect(await same(0o100775)).toBe(await same(0o755));
    expect(await same(0o755)).not.toBe(await same(0o644));
    await expect(packSkillBundle([{ path: "a", body: text("x"), mode: -1 }])).rejects.toBeInstanceOf(InvalidSkillFileError);
    await expect(packSkillBundle([{ path: "a", body: text("x"), mode: 1.5 }])).rejects.toBeInstanceOf(InvalidSkillFileError);
  });

  it("filters compiled Python and __pycache__ directories and reports them", async () => {
    const packed = await packSkillBundle([
      ...skillFiles(),
      { path: "scripts/__pycache__/run.cpython-311.pyc", body: text("bytecode") },
      { path: "scripts/__pycache__/notes.txt", body: text("cache") },
      { path: "legacy.pyc", body: text("bytecode") },
      { path: "scripts/helper.py", body: text("print(1)\n") },
    ]);
    expect(packed.filtered).toEqual(["legacy.pyc", "scripts/__pycache__/notes.txt", "scripts/__pycache__/run.cpython-311.pyc"]);
    expect((await listSkillBundle(packed.bytes)).map((entry) => entry.path)).toEqual([
      "SKILL.md", "docs/空 文件.txt", "fonts/NotoSans-Regular.ttf", "scripts/helper.py", "scripts/run.sh",
    ]);
    expect(packed.files).toBe(5);
    expect(packed.sha256).toBe((await packSkillBundle([...skillFiles(), { path: "scripts/helper.py", body: text("print(1)\n") }])).sha256);
  });

  it.each([
    ["an empty path", ""],
    ["an absolute path", "/etc/passwd"],
    ["a parent segment", "scripts/../../escape"],
    ["a current-directory segment", "./SKILL.md"],
    ["an empty segment", "scripts//run.sh"],
    ["a directory entry", "scripts/"],
    ["a backslash", "scripts\\run.sh"],
    ["a control character", "bad\nname"],
    ["a Windows drive", "C:/x"],
  ])("rejects %s", async (_label, path) => {
    await expect(packSkillBundle([{ path, body: text("x") }])).rejects.toBeInstanceOf(InvalidSkillFileError);
  });

  it("rejects duplicate paths and a path that is both a file and a directory", async () => {
    await expect(packSkillBundle([{ path: "a.txt", body: text("1") }, { path: "a.txt", body: text("2") }]))
      .rejects.toThrow(/Duplicate Skill file path/);
    await expect(packSkillBundle([{ path: "a", body: text("1") }, { path: "a/b", body: text("2") }]))
      .rejects.toThrow(/both a file and a directory/);
  });

  it("rejects a Skill above 50 MB uncompressed with a dedicated error carrying the sizes", async () => {
    const half = new Uint8Array(SKILL_BUNDLE_MAX_BYTES / 2);
    const error = await packSkillBundle([
      { path: "a.bin", body: half },
      { path: "b.bin", body: new Uint8Array(SKILL_BUNDLE_MAX_BYTES / 2 + 1) },
    ]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SkillBundleTooLargeError);
    expect(error).toMatchObject({
      code: "skill_bundle_too_large",
      limitBytes: SKILL_BUNDLE_MAX_BYTES,
      actualBytes: SKILL_BUNDLE_MAX_BYTES + 1,
    });
    expect((error as Error).message).toMatch(/50 MB/);
    // Filtered files do not count; exactly the limit is accepted.
    const atLimit = await packSkillBundle([
      { path: "a.bin", body: half },
      { path: "b.bin", body: half },
      { path: "__pycache__/x.pyc", body: new Uint8Array(1) },
    ]);
    expect(atLimit.size).toBe(SKILL_BUNDLE_MAX_BYTES);
  });
});

describe("reading a Skill Bundle", () => {
  it("reads every file back byte-identical with its mode, including binary fonts", async () => {
    const files = skillFiles();
    const packed = await packSkillBundle(files);
    const unpacked = await unpackSkillBundle(packed.bytes);
    expect(unpacked.map((file) => file.path)).toEqual(["SKILL.md", "docs/空 文件.txt", "fonts/NotoSans-Regular.ttf", "scripts/run.sh"]);
    for (const original of files) {
      const read = unpacked.find((file) => file.path === original.path)!;
      expect(Buffer.from(read.body).equals(Buffer.from(original.body))).toBe(true);
      expect(read.mode).toBe(original.mode === 0o755 ? 0o755 : 0o644);
    }
    expect(await listSkillBundle(packed.bytes)).toEqual(unpacked.map((file) => ({ path: file.path, size: file.body.byteLength, mode: file.mode })));
    const font = await readSkillBundleFile(packed.bytes, "fonts/NotoSans-Regular.ttf");
    expect(Buffer.from(font!).equals(Buffer.from(files[2].body))).toBe(true);
    expect(await readSkillBundleFile(packed.bytes, "fonts")).toBeNull();
    expect(await readSkillBundleFile(packed.bytes, "missing.txt")).toBeNull();
  });

  it("writes standard unix deflate entries with fixed DOS timestamps and no OS-dependent extra fields", async () => {
    const packed = await packSkillBundle(skillFiles());
    const zip = await yauzl.fromBufferPromise(Buffer.from(packed.bytes), { lazyEntries: true });
    const entries: yauzl.Entry[] = [];
    for await (const entry of zip.eachEntry()) entries.push(entry);
    for (const entry of entries) {
      expect(entry.versionMadeBy >> 8).toBe(3); // unix
      expect(entry.compressionMethod).toBe(8); // deflate
      expect(entry.lastModFileDate).toBe((0 << 9) | (1 << 5) | 1); // 1980-01-01
      expect(entry.lastModFileTime).toBe(0);
      expect(entry.extraFieldLength).toBe(0);
      expect(entry.externalFileAttributes >>> 16 & 0o170000).toBe(0o100000); // regular file
    }
  });

  it("rejects bytes that are not a zip and bundles above the size limit (zip-bomb guard)", async () => {
    await expect(listSkillBundle(text("not a zip"))).rejects.toBeInstanceOf(InvalidSkillBundleError);
    const bomb = new yazl.ZipFile();
    bomb.addBuffer(Buffer.alloc(SKILL_BUNDLE_MAX_BYTES + 1), "zeros.bin");
    bomb.end();
    const chunks: Buffer[] = [];
    for await (const chunk of bomb.outputStream) chunks.push(chunk as Buffer);
    const bytes = new Uint8Array(Buffer.concat(chunks));
    expect(bytes.byteLength).toBeLessThan(1024 * 1024);
    await expect(listSkillBundle(bytes)).rejects.toBeInstanceOf(SkillBundleTooLargeError);
    await expect(unpackSkillBundle(bytes)).rejects.toBeInstanceOf(SkillBundleTooLargeError);
  });
});

const hasTool = (command: string, args: string[]) => {
  const probe = spawnSync(command, args, { stdio: "ignore" });
  return !probe.error && probe.status === 0;
};

describe("standard extraction tooling", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const writeBundle = async () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-bundle-"));
    dirs.push(dir);
    const packed = await packSkillBundle(skillFiles());
    writeFileSync(join(dir, "bundle.zip"), packed.bytes);
    return { dir, zip: join(dir, "bundle.zip") };
  };

  it.skipIf(!hasTool("unzip", ["-v"]))("Info-ZIP unzip extracts identical bytes and keeps the executable bit", async () => {
    const { dir, zip } = await writeBundle();
    const out = join(dir, "out");
    const result = spawnSync("unzip", ["-q", zip, "-d", out], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    for (const file of skillFiles()) {
      const path = join(out, file.path);
      expect(readFileSync(path).equals(Buffer.from(file.body))).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(file.mode === 0o755 ? 0o755 : 0o644);
    }
    const test = spawnSync("unzip", ["-tq", zip], { encoding: "utf8" });
    expect(test.status, test.stdout + test.stderr).toBe(0);
  });

  it.skipIf(!hasTool("python3", ["-I", "-c", "import zipfile"]))("python zipfile reads unix modes, deflate entries and identical bytes", async () => {
    const { zip } = await writeBundle();
    const script = [
      "import hashlib, json, sys, zipfile",
      "z = zipfile.ZipFile(sys.argv[1])",
      "assert z.testzip() is None",
      "print(json.dumps([[i.filename, i.create_system, i.compress_type, i.external_attr >> 16, hashlib.sha256(z.read(i)).hexdigest()] for i in z.infolist()]))",
    ].join("\n");
    const result = spawnSync("python3", ["-I", "-c", script, zip], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const entries = JSON.parse(result.stdout) as Array<[string, number, number, number, string]>;
    const expected = [...skillFiles()].sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(entries).toEqual(expected.map((file) => [file.path, 3, 8, 0o100000 | (file.mode === 0o755 ? 0o755 : 0o644), sha256(file.body)]));
  });
});

describe("skillSetHash", () => {
  const a = { name: "alpha", bundleSha256: "a".repeat(64) };
  const b = { name: "beta", bundleSha256: "b".repeat(64) };
  const c = { name: "gamma", bundleSha256: "c".repeat(64) };

  it("is a stable hex sha256 independent of equip order", () => {
    expect(skillSetHash([a, b, c])).toMatch(/^[a-f0-9]{64}$/);
    expect(skillSetHash([c, a, b])).toBe(skillSetHash([a, b, c]));
    expect(skillSetHash([b, c, a])).toBe(skillSetHash([a, b, c]));
  });

  it("changes on equip, unequip, rename or any bundle change", () => {
    const base = skillSetHash([a, b]);
    const variants = [
      skillSetHash([a, b, c]),
      skillSetHash([a]),
      skillSetHash([a, { ...b, name: "beta2" }]),
      skillSetHash([a, { ...b, bundleSha256: "d".repeat(64) }]),
      // Swapping which name carries which bundle is a different installation.
      skillSetHash([{ name: "alpha", bundleSha256: b.bundleSha256 }, { name: "beta", bundleSha256: a.bundleSha256 }]),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it("defines the empty set as a fixed, documented value distinct from any non-empty set", () => {
    expect(skillSetHash([])).toBe(EMPTY_SKILL_SET_HASH);
    expect(EMPTY_SKILL_SET_HASH).toBe(createHash("sha256").update("oma-skill-set/v1\n[]").digest("hex"));
    expect(skillSetHash([a])).not.toBe(EMPTY_SKILL_SET_HASH);
  });

  it("rejects duplicate names, empty names and malformed bundle digests", () => {
    expect(() => skillSetHash([a, { ...a, bundleSha256: "b".repeat(64) }])).toThrow(/Duplicate Skill name/);
    expect(() => skillSetHash([{ name: "", bundleSha256: a.bundleSha256 }])).toThrow();
    expect(() => skillSetHash([{ name: "x", bundleSha256: "A".repeat(64) }])).toThrow();
    expect(() => skillSetHash([{ name: "x", bundleSha256: "a".repeat(63) }])).toThrow();
  });
});
