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
  if (name === "bash") return defineTool(createBashToolDefinition(root, { exposeSessionEnvironment: false }));

  // Match the managed tool's explicit environment policy; this direct factory
  // harness has no AgentSession from which to expose PI_SESSION_* variables.
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
    expect(execSpy).toHaveBeenCalled();
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
    expect(execSpy.mock.calls.at(-1)?.[1]?.env).toBeUndefined();
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
    expect(append).not.toHaveBeenCalled();
    expect(forbid).not.toHaveBeenCalled();
    expect(path).not.toBe(nativePath);
    expect(await readFile(path, "utf8")).toBe(full);
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
    expect(await execute(sandbox("read"), { path: "~/workspace/alias.txt" })).toEqual(expected);
    expect(await execute(sandbox("read"), { path: "/home/user/workspace/alias.txt" })).toEqual(expected);
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
    expect(await execute(sandbox("ls"), { path: "~/workspace" })).toEqual(await execute(native("ls"), { path: "." }));
    expect(await execute(sandbox("ls"), { path: "empty" })).toEqual(await execute(native("ls"), { path: "empty" }));
  });

});


describe("mutation ordering across native tool processes", () => {
  it.each([false, true])("holds alias locks until the process settles (new=%s)", async newFile => {
    await mkdir(join(root, "directory"));
    await symlink("directory", join(root, "alias"));
    if (!newFile) await writeFile(join(root, "directory/note.txt"), "before");
    const completed = deferred(); const release = deferred();
    const rawExec = executor.exec.bind(executor);
    let calls = 0;
    executor.exec = async function* (command, options) {
      const first = ++calls === 1;
      yield* rawExec(command, options);
      if (first) { completed.resolve(); await release.promise; }
    };
    const first = execute(sandbox("write"), { path: "directory/note.txt", content: "first" });
    await completed.promise;
    const second = execute(sandbox("write"), { path: "alias/note.txt", content: "second" });
    try { await new Promise(resolve => setTimeout(resolve, 30)); expect(calls).toBe(1); }
    finally { release.resolve(); }
    await Promise.all([first, second]);
    expect(await readFile(join(root, "directory/note.txt"), "utf8")).toBe("second");
  });
});

describe("native execution boundary regressions", () => {
  it("confirms Pi bash cancellation before returning and leaves no delayed writer", async () => {
    const controller = new AbortController();
    const operation = outcome(sandbox("bash"), { command: "printf ready; sleep 1; printf survived > cancel-survived.txt" }, controller.signal, update => {
      if (text(update).includes("ready")) controller.abort();
    });
    expect((await operation).error).toContain("Command aborted");
    await new Promise(resolve => setTimeout(resolve, 1400));
    await expect(readFile(join(root, "cancel-survived.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves at-prefixed filenames and file URLs", async () => {
    await writeFile(join(root, "@note.txt"), "at-file");
    await writeFile(join(root, "note.txt"), "plain-file");
    for (const path of ["@@note.txt", new URL(`file://${join(root, "note.txt")}`).href]) {
      expect(await execute(sandbox("read"), { path })).toEqual(await execute(native("read"), { path }));
    }
    await execute(sandbox("write"), { path: "@@note.txt", content: "updated" });
    expect(await readFile(join(root, "@note.txt"), "utf8")).toBe("updated");
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("plain-file");
  });
  it("shares mutation locks for native Unicode-space aliases", async () => {
    await writeFile(join(root, "a b.txt"), "before");
    const completed = deferred(); const release = deferred();
    const rawExec = executor.exec.bind(executor); let calls = 0;
    executor.exec = async function* (command, options) {
      const first = ++calls === 1; yield* rawExec(command, options);
      if (first) { completed.resolve(); await release.promise; }
    };
    const first = execute(sandbox("write"), { path: "a b.txt", content: "first" });
    await completed.promise;
    const second = execute(sandbox("write"), { path: "a\u00a0b.txt", content: "last" });
    try { await new Promise(resolve => setTimeout(resolve, 30)); expect(calls).toBe(1); }
    finally { release.resolve(); }
    await Promise.all([first, second]);
    expect(await readFile(join(root, "a b.txt"), "utf8")).toBe("last");
  });
});
