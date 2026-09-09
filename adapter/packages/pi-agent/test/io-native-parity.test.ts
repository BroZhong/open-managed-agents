import fs from "node:fs";
import fsPromises, { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createLsToolDefinition,
  createReadToolDefinition, createWriteToolDefinition, defineTool, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolExecutor, ToolFileSystem } from "@open-managed-agents/adapter-core";
import { LocalToolExecutor } from "@open-managed-agents/adapter-tool-executor-local";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCustomTools } from "../src/custom-tools.js";
import { MemoryFileSystem } from "./memory-file-system.js";

type Result = Awaited<ReturnType<ToolDefinition["execute"]>>;
type Name = "bash" | "read" | "write" | "edit" | "ls" | "find";
let root: string;
let executor: LocalToolExecutor;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "oma-io-native-parity-"));
  executor = new LocalToolExecutor({ root });
});
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function native(name: Name): ToolDefinition {
  const factories = { bash: createBashToolDefinition, read: createReadToolDefinition,
    write: createWriteToolDefinition, edit: createEditToolDefinition, ls: createLsToolDefinition, find: createFindToolDefinition };
  return defineTool(factories[name](root) as ToolDefinition);
}
function sandbox(name: Name, ex: ToolExecutor = executor): ToolDefinition {
  return buildCustomTools(ex).find((tool) => tool.name === name)!;
}
function execute(tool: ToolDefinition, args: Record<string, unknown>, signal?: AbortSignal,
  onUpdate?: (result: Result) => void): Promise<Result> {
  return tool.execute("io-parity", args as never, signal, onUpdate, {} as never);
}
async function outcome(tool: ToolDefinition, args: Record<string, unknown>, signal?: AbortSignal,
  onUpdate?: (result: Result) => void) {
  try { return { result: await execute(tool, args, signal, onUpdate) }; }
  catch (error) { return { error: (error as Error).message }; }
}
function text(result: Result): string {
  return result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function withFileSystem(inner: ToolExecutor, fileSystem: ToolFileSystem): ToolExecutor {
  return { fileSystem, exec: inner.exec.bind(inner), readFile: inner.readFile.bind(inner),
    writeFile: inner.writeFile.bind(inner), list: inner.list.bind(inner) };
}

describe("native bash through injected process and output storage", () => {
  it("preserves bash arrays, pipefail, actual nonzero status, and both output streams", async () => {
    const args = { command: "items=(zero 中文); printf '%s\\n' \"${items[1]}\"; exit 7" };
    const expected = await outcome(native("bash"), args);
    const actual = await outcome(sandbox("bash"), args);
    expect(actual).toEqual(expected);
    expect(actual.error).toContain("中文");
    expect(actual.error).toContain("Command exited with code 7");
    // stdout and stderr are independent pipes: compare each deterministically
    // instead of assuming their cross-stream callback order is stable.
    const diagnostic = { command: "printf diagnostic >&2; exit 9" };
    const diagnosticResult = await outcome(sandbox("bash"), diagnostic);
    expect(diagnosticResult).toEqual(await outcome(native("bash"), diagnostic));
    expect(diagnosticResult.error).toBe("diagnostic\n\nCommand exited with code 9");
    const pipe = { command: "set -o pipefail; false | true" };
    expect(await outcome(sandbox("bash"), pipe)).toEqual(await outcome(native("bash"), pipe));
  });

  it.each([0, -1, NaN, Infinity, 2_147_484])("rejects invalid timeout %s exactly as native before execution", async (timeout) => {
    const execSpy = vi.spyOn(executor, "exec");
    const args = { command: "printf should-not-run", timeout };
    expect(await outcome(sandbox("bash"), args)).toEqual(await outcome(native("bash"), args));
    expect(execSpy).not.toHaveBeenCalled();
  });

  it("keeps already-produced output before a timeout", async () => {
    const args = { command: "printf 'prefix 中文\\n'; exec sleep 5", timeout: 0.3 };
    const expected = await outcome(native("bash"), args);
    expect(await outcome(sandbox("bash"), args)).toEqual(expected);
    expect(expected.error).toBe("prefix 中文\n\n\nCommand timed out after 0.3 seconds");
  });

  it("keeps already-produced output before cancellation", async () => {
    const args = { command: "printf 'prefix 中文\\n'; exec sleep 5" };
    async function cancelAfterOutput(tool: ToolDefinition) {
      const controller = new AbortController();
      return outcome(tool, args, controller.signal, (result) => {
        if (text(result).includes("prefix")) controller.abort();
      });
    }
    const expected = await cancelAfterOutput(native("bash"));
    expect(await cancelAfterOutput(sandbox("bash"))).toEqual(expected);
    expect(expected.error).toBe("prefix 中文\n\n\nCommand aborted");
  });

  it("uses the executor's environment for bash commands", async () => {
    vi.stubEnv("OMA_PI_IO_PARITY_ENV", "中文-environment");
    const execSpy = vi.spyOn(executor, "exec");
    const args = { command: "printf '%s' \"$OMA_PI_IO_PARITY_ENV\"" };
    const expected = await execute(native("bash"), args);
    expect(await execute(sandbox("bash"), args)).toEqual(expected);
    expect(text(expected)).toBe("中文-environment");
    expect(execSpy.mock.calls.at(-1)?.[1]?.env).toEqual({});
  });

  it("persists native large-output truncation through the injected FS and exposes a readable path", async () => {
    const args = { command: "for ((i=0; i<2300; i++)); do printf '%04d:%050d\\n' \"$i\" 0; done" };
    const expected = await execute(native("bash"), args);
    const nativePath = (expected.details as { fullOutputPath: string }).fullOutputPath;
    const full = await readFile(nativePath, "utf8");
    const create = vi.spyOn(executor.fileSystem, "createTempFile");
    const append = vi.spyOn(executor.fileSystem, "appendFile");
    const forbid = vi.spyOn(fs, "createWriteStream").mockImplementation(() => { throw new Error("HOST_TEMP_FORBIDDEN"); });
    syncBuiltinESMExports();
    const actual = await execute(sandbox("bash"), args);
    const path = (actual.details as { fullOutputPath: string }).fullOutputPath;
    expect(create).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalled();
    expect(forbid).not.toHaveBeenCalled();
    expect(path).not.toBe(nativePath);
    expect(Buffer.from(await executor.fileSystem.readFile(path)).toString()).toBe(full);
    const normalize = (result: Result, outputPath: string) => JSON.parse(JSON.stringify(result).replaceAll(outputPath, "<output>"));
    expect(normalize(actual, path)).toEqual(normalize(expected, nativePath));
    const page = await execute(sandbox("read"), { path, offset: 1, limit: 1 });
    expect(text(page)).toContain("0000:" + "0".repeat(50));
    expect(text(page)).toContain("Use offset=2 to continue");
    await rm(nativePath, { force: true });
  });
});

describe("native read/edit/ls through byte-preserving filesystem hooks", () => {
  it.each([
    { name: "nul.txt", bytes: Buffer.from("before\0after\n") },
    { name: "invalid.txt", bytes: Buffer.from([0x61, 0xff, 0xfe, 0x0a]) },
  ])("matches native decoding for $name", async ({ name, bytes }) => {
    await writeFile(join(root, name), bytes);
    const args = { path: name };
    expect(await execute(sandbox("read"), args)).toEqual(await execute(native("read"), args));
  });

  it("reads through a symlink and expands tilde to the sandbox home", async () => {
    await writeFile(join(root, "target.txt"), "symlink 中文");
    await symlink("target.txt", join(root, "alias.txt"));
    const expected = await execute(native("read"), { path: "alias.txt" });
    expect(await execute(sandbox("read"), { path: "~/alias.txt" })).toEqual(expected);
    expect(await execute(sandbox("read"), { path: "/home/user/alias.txt" })).toEqual(expected);
  });

  it("paginates text above the previous 32 MiB cap using native notices", async () => {
    const line = "x".repeat(1023) + "\n";
    await writeFile(join(root, "large.txt"), line.repeat(32 * 1024 + 1) + "last line");
    const args = { path: "large.txt", offset: 32 * 1024 + 1, limit: 1 };
    const expected = await execute(native("read"), args);
    expect(await execute(sandbox("read"), args)).toEqual(expected);
    expect(text(expected)).toContain("Use offset=32770 to continue");
  }, 15_000);

  it("edits through a symlink preserving BOM and CRLF exactly as native", async () => {
    const initial = Buffer.from("\uFEFFfirst\r\nsecond\r\n");
    await writeFile(join(root, "target.txt"), initial);
    await symlink("target.txt", join(root, "alias.txt"));
    const args = { path: "alias.txt", edits: [{ oldText: "second", newText: "updated" }] };
    const expected = await execute(native("edit"), args);
    const expectedBytes = await readFile(join(root, "target.txt"));
    await writeFile(join(root, "target.txt"), initial);
    expect(await execute(sandbox("edit"), args)).toEqual(expected);
    expect(await readFile(join(root, "target.txt"))).toEqual(expectedBytes);
    expect(expectedBytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect((await fsPromises.lstat(join(root, "alias.txt"))).isSymbolicLink()).toBe(true);
  });

  it("lists empty directories, links to files/directories, and dangling links as native", async () => {
    await mkdir(join(root, "empty"));
    await writeFile(join(root, "file.txt"), "text");
    await symlink("empty", join(root, "dir-link"));
    await symlink("file.txt", join(root, "file-link"));
    await symlink("missing", join(root, "dangling"));
    expect(await execute(sandbox("ls"), { path: "~" })).toEqual(await execute(native("ls"), { path: "." }));
    expect(await execute(sandbox("ls"), { path: "empty" })).toEqual(await execute(native("ls"), { path: "empty" }));
  });

  it("resolves native screenshot filename variants without any Host path probe", async () => {
    const fileSystem = new MemoryFileSystem(new Map([["Capture d’écran.png", "remote-only text"]]));
    const ex = withFileSystem(executor, fileSystem);
    const forbid = () => { throw new Error("HOST_IO_FORBIDDEN"); };
    const spies = [vi.spyOn(fs, "accessSync").mockImplementation(forbid),
      vi.spyOn(fsPromises, "access").mockImplementation(forbid),
      vi.spyOn(fsPromises, "readFile").mockImplementation(forbid),
      vi.spyOn(fsPromises, "stat").mockImplementation(forbid),
      vi.spyOn(fsPromises, "realpath").mockImplementation(forbid)];
    syncBuiltinESMExports();
    expect(text(await execute(sandbox("read", ex), { path: "~/Capture d'écran.png" }))).toBe("remote-only text");
    await execute(sandbox("write", ex), { path: "~/new/note.txt", content: "one" });
    await execute(sandbox("edit", ex), { path: "~/new/note.txt", edits: [{ oldText: "one", newText: "two" }] });
    expect(fileSystem.files.get("new/note.txt")).toBe("two");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("renders adapter edit previews through sandbox reads and read-only access", async () => {
    const fileSystem = new MemoryFileSystem(new Map([["story.txt", "old story\n"]]));
    const access = vi.spyOn(fileSystem, "access");
    const read = vi.spyOn(fileSystem, "readFile");
    const write = vi.spyOn(fileSystem, "writeFile");
    const forbid = () => { throw new Error("HOST_PREVIEW_IO_FORBIDDEN"); };
    const host = [vi.spyOn(fsPromises, "access").mockImplementation(forbid),
      vi.spyOn(fsPromises, "readFile").mockImplementation(forbid)];
    syncBuiltinESMExports();
    const tool = sandbox("edit", withFileSystem(executor, fileSystem));
    const invalidated = deferred();
    const state: { callComponent?: { preview?: { diff?: string; error?: string } } } = {};
    const theme = { fg: (_name: string, value: string) => value,
      bg: (_name: string, value: string) => value, bold: (value: string) => value };
    tool.renderCall!({ path: "~/story.txt", edits: [{ oldText: "old", newText: "new" }] }, theme as never, {
      state, cwd: "/home/user", argsComplete: true, invalidate: invalidated.resolve,
    } as never);
    await invalidated.promise;
    expect(state.callComponent?.preview?.error).toBeUndefined();
    expect(state.callComponent?.preview?.diff).toContain("new story");
    expect(access.mock.calls.map(([path, mode]) => ({ path, mode }))).toEqual([{ path: "story.txt", mode: fs.constants.R_OK }]);
    expect(read.mock.calls.map(([path]) => path)).toEqual(["story.txt"]);
    expect(write).not.toHaveBeenCalled();
    for (const spy of host) expect(spy).not.toHaveBeenCalled();
  });
});

describe("filesystem probe failures remain distinguishable from absent paths", () => {
  it.each(["bash", "ls", "find", "read"] as const)("surfaces the original %s RPC failure before process or file reads", async (name) => {
    const unavailable = new Error("RPC unavailable");
    vi.spyOn(executor.fileSystem, "access").mockRejectedValue(unavailable);
    const exec = vi.spyOn(executor, "exec");
    const read = vi.spyOn(executor.fileSystem, "readFile");
    const args = name === "bash" ? { command: "true" } : { path: "remote", pattern: "*.ts" };
    await expect(execute(sandbox(name), args)).rejects.toBe(unavailable);
    expect(exec).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("retains native ls Path not found for a real ENOENT", async () => {
    const name = "ls";
    const args = { path: join(root, "missing"), pattern: "*.ts" };
    vi.spyOn(executor.fileSystem, "access")
      .mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const exec = vi.spyOn(executor, "exec");
    const expected = await outcome(native(name), args);
    expect(expected).toEqual({ error: `Path not found: ${args.path}` });
    expect(await outcome(sandbox(name), args)).toEqual(expected);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["ls", "find", "read"] as const)("retains Operation aborted when %s is cancelled during an RPC probe", async (name) => {
    const controller = new AbortController();
    vi.spyOn(executor.fileSystem, "access").mockImplementation(async () => {
      controller.abort();
      throw new Error("RPC unavailable");
    });
    const exec = vi.spyOn(executor, "exec");
    expect(await outcome(sandbox(name), { path: "remote", pattern: "*.ts" }, controller.signal))
      .toEqual({ error: "Operation aborted" });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("native mutation queues use executor identity and sandbox realpaths", () => {
  it("serializes edit and write through aliases across separately built tool sets", async () => {
    await writeFile(join(root, "target.txt"), "before");
    await symlink("target.txt", join(root, "alias.txt"));
    const reading = deferred();
    const release = deferred();
    const rawRead = executor.fileSystem.readFile.bind(executor.fileSystem);
    const rawWrite = executor.fileSystem.writeFile.bind(executor.fileSystem);
    const writes: string[] = [];
    const fileSystem = { ...executor.fileSystem,
      async readFile(path: string) { reading.resolve(); await release.promise; return rawRead(path); },
      async writeFile(path: string, bytes: Uint8Array) { writes.push(Buffer.from(bytes).toString()); await rawWrite(path, bytes); },
    };
    const ex = withFileSystem(executor, fileSystem);
    const editing = execute(sandbox("edit", ex), { path: "alias.txt", edits: [{ oldText: "before", newText: "edited" }] });
    await reading.promise;
    const writing = execute(sandbox("write", ex), { path: "target.txt", content: "written-last" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(writes).toEqual([]);
    } finally { release.resolve(); }
    await Promise.all([editing, writing]);
    expect(writes).toEqual(["edited", "written-last"]);
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe("written-last");
  });

  it("keeps a new-file write locked after creation until its filesystem operation settles", async () => {
    await mkdir(join(root, "directory"));
    await symlink("directory", join(root, "alias"));
    const created = deferred();
    const release = deferred();
    const secondResolved = deferred();
    const rawWrite = executor.fileSystem.writeFile.bind(executor.fileSystem);
    const rawRealpath = executor.fileSystem.realpath.bind(executor.fileSystem);
    const writes: string[] = [];
    const fileSystem = { ...executor.fileSystem,
      async realpath(path: string) {
        const resolved = await rawRealpath(path);
        if (path === "alias/new.txt") secondResolved.resolve();
        return resolved;
      },
      async writeFile(path: string, bytes: Uint8Array) {
        const content = Buffer.from(bytes).toString();
        writes.push(content);
        await rawWrite(path, bytes);
        if (content === "first") { created.resolve(); await release.promise; }
      },
    };
    const ex = withFileSystem(executor, fileSystem);
    const first = execute(sandbox("write", ex), { path: "directory/new.txt", content: "first" });
    await created.promise;
    const second = execute(sandbox("write", ex), { path: "alias/new.txt", content: "second" });
    try {
      await secondResolved.promise;
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(writes).toEqual(["first"]);
    } finally { release.resolve(); await Promise.all([first, second]); }
    expect(writes).toEqual(["first", "second"]);
    expect(await readFile(join(root, "directory/new.txt"), "utf8")).toBe("second");
  });

  it("does not serialize the same virtual path across independent executor filesystems", async () => {
    const first = new MemoryFileSystem(new Map([["same.txt", "first"]]));
    const second = new MemoryFileSystem(new Map([["same.txt", "second"]]));
    const writing = deferred();
    const release = deferred();
    const original = first.writeFile.bind(first);
    first.writeFile = async (...args) => { writing.resolve(); await release.promise; await original(...args); };
    const blocked = execute(sandbox("write", withFileSystem(executor, first)), { path: "same.txt", content: "one" });
    await writing.promise;
    try {
      const independent = execute(sandbox("write", withFileSystem(executor, second)), { path: "same.txt", content: "two" });
      await Promise.race([independent, new Promise((_, reject) => setTimeout(() => reject(new Error("Cross-executor mutation lock")), 1_000))]);
      expect(second.files.get("same.txt")).toBe("two");
    } finally { release.resolve(); await blocked; }
    expect(first.files.get("same.txt")).toBe("one");
  });
});
