import { spawn } from "node:child_process";
import { constants } from "node:fs";
import * as native from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxFileSystem } from "../src/sandbox-file-system.js";
import type { SandboxExecChunk, SandboxExecOptions } from "../src/sandbox-client.js";

const directories: string[] = [];
const transportFiles: string[] = [];
afterEach(async () => {
  await Promise.all([
    ...directories.splice(0).map((path) => native.rm(path, { recursive: true, force: true })),
    ...transportFiles.splice(0).map((path) => native.rm(path, { force: true })),
  ]);
});

/** Execute the production helper itself, with Node fs rather than mocked results. */
async function* runNative(command: string[], options?: SandboxExecOptions): AsyncIterable<SandboxExecChunk> {
  const child = spawn(process.execPath, command.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
  child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (stdout) yield { stream: "stdout", text: stdout };
  if (stderr) yield { stream: "stderr", text: stderr };
  options?.onExit?.({ exitCode });
}

async function fixture(exec = runNative, remove = (path: string) => native.rm(path, { force: true })) {
  const root = await native.mkdtemp(join(tmpdir(), "oma-fs-contract-"));
  directories.push(root);
  const staged: string[] = [];
  const fs = createSandboxFileSystem({
    exec,
    writeFileBytes: async (path, content) => { staged.push(path); transportFiles.push(path); await native.writeFile(path, content); },
    remove,
  });
  return { root, fs, staged };
}

describe("sandbox native filesystem helper", () => {
  it("round-trips binary data larger than exec argv limits and cleans transport payloads", async () => {
    const { root, fs, staged } = await fixture();
    const bytes = Buffer.alloc(300_007);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const content = bytes.subarray(3, bytes.length - 2);
    const path = join(root, "图片 ' $(literal).bin");
    await fs.writeFile(path, content);
    expect(await fs.readFile(path)).toEqual(content);
    await fs.appendFile(path, new Uint8Array([255, 0, 239, 187, 191]));
    expect(await native.readFile(path)).toEqual(Buffer.concat([content, Buffer.from([255, 0, 239, 187, 191])]));
    expect(staged).toHaveLength(2);
    for (const path of staged) await expect(native.access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves native missing-parent, missing-path, directory and non-directory errors", async () => {
    const { root, fs, staged } = await fixture();
    const missing = join(root, "missing", "child");
    await expect(fs.writeFile(missing, new Uint8Array())).rejects.toMatchObject({ code: "ENOENT", syscall: "open", path: missing });
    await expect(fs.appendFile(missing, new Uint8Array())).rejects.toMatchObject({ code: "ENOENT", syscall: "open", path: missing });
    await expect(native.access(dirname(missing))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(root)).rejects.toMatchObject({ code: "EISDIR" });
    await expect(fs.access(missing, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT", syscall: "access", path: missing });
    const file = join(root, "file");
    await native.writeFile(file, "hi");
    await expect(fs.readdir(file)).rejects.toMatchObject({ code: "ENOTDIR", syscall: "scandir", path: file });
    for (const path of staged) await expect(native.access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves target errno when staging cleanup also fails", async () => {
    const { root, fs } = await fixture(runNative, async () => { throw new Error("cleanup unavailable"); });
    const path = join(root, "missing", "file");
    await expect(fs.writeFile(path, new Uint8Array([1]))).rejects.toMatchObject({ code: "ENOENT", syscall: "open", path });
  });

  it("does not report a completed append as failed when staging cleanup fails", async () => {
    const { root, fs } = await fixture(runNative, async () => { throw new Error("cleanup unavailable"); });
    const path = join(root, "output");
    await native.writeFile(path, "before");
    await expect(fs.appendFile(path, Buffer.from("after"))).resolves.toBeUndefined();
    expect(await native.readFile(path, "utf8")).toBe("beforeafter");
  });

  it("executes stat/lstat, realpath, readdir and recursive mkdir with native link semantics", async () => {
    const { root, fs } = await fixture();
    await fs.mkdir(join(root, "nested", "empty"));
    const directory = join(root, "nested");
    const target = join(directory, "中文\nname");
    await native.writeFile(target, new Uint8Array([0, 255]));
    await native.symlink("中文\nname", join(directory, "link"));
    await native.symlink("missing", join(directory, "dangling"));
    await native.symlink("empty", join(directory, "directory-link"));
    const expected = await native.stat(target);
    expect(await fs.stat(join(directory, "link"))).toEqual({ isFile: true, isDirectory: false, isSymbolicLink: false, size: 2, mtimeMs: expected.mtimeMs });
    expect(await fs.lstat(join(directory, "link"))).toMatchObject({ isFile: false, isSymbolicLink: true });
    expect(await fs.lstat(join(directory, "dangling"))).toMatchObject({ isSymbolicLink: true });
    await expect(fs.stat(join(directory, "dangling"))).rejects.toMatchObject({ code: "ENOENT", syscall: "stat" });
    await expect(fs.access(join(directory, "dangling"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.realpath(join(directory, "link"))).toBe(await native.realpath(target));
    expect((await fs.readdir(directory)).sort()).toEqual(["dangling", "directory-link", "empty", "link", "中文\nname"]);
    expect(await fs.stat(join(directory, "directory-link"))).toMatchObject({ isDirectory: true });
    await fs.writeFile(join(directory, "link"), Buffer.from("changed"));
    expect(await native.readFile(target, "utf8")).toBe("changed");
    expect(await fs.lstat(join(directory, "link"))).toMatchObject({ isSymbolicLink: true });
  });

  it("creates unique existing empty files and appends exact bytes", async () => {
    const { fs } = await fixture();
    const files = await Promise.all([fs.createTempFile(), fs.createTempFile()]);
    directories.push(...files.map(dirname));
    expect(files[0]).not.toBe(files[1]);
    for (const path of files) {
      expect(await fs.readFile(path)).toHaveLength(0);
      expect((await native.stat(path)).mode & 0o777).toBe(0o600);
    }
    await fs.appendFile(files[0], new Uint8Array([255, 0]));
    expect(await fs.readFile(files[0])).toEqual(Buffer.from([255, 0]));
  });

  it("does not release a cancelled mutation until the actual write settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const { root, fs, staged } = await fixture(async function* (command, options) {
      expect(options?.signal).toBeUndefined();
      started();
      await gate;
      yield* runNative(command, options);
    });
    const controller = new AbortController();
    let settled = false;
    const path = join(root, "write");
    const pending = fs.writeFile(path, Buffer.from("complete"), { signal: controller.signal }).finally(() => { settled = true; });
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await entered;
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    await rejection;
    expect(await native.readFile(path, "utf8")).toBe("complete");
    await expect(native.access(staged[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pre-aborted operations never start a helper or stage bytes", async () => {
    let calls = 0;
    const { fs, staged } = await fixture(async function* () { calls++; });
    const options = { signal: AbortSignal.abort() };
    await expect(fs.writeFile("/unused", new Uint8Array(), options)).rejects.toMatchObject({ name: "AbortError" });
    await expect(fs.readFile("/unused", options)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
    expect(staged).toEqual([]);
  });

  it("does not treat missing process completion as a successful filesystem result", async () => {
    const { fs } = await fixture(async function* () { yield { stream: "stdout", text: '\u001eoma-fs:{"ok":true,"value":[]}' }; });
    await expect(fs.readdir("/unused")).rejects.toThrow("exit unknown");
  });
});
