import childProcess from "node:child_process";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExecOptions, ExecOutputChunk, ToolExecutor } from "@open-managed-agents/adapter-core";
import { MemoryFileSystem } from "./memory-file-system.js";
import { buildCustomTools } from "../src/custom-tools.js";

const original = {
  spawn: childProcess.spawn, spawnSync: childProcess.spawnSync,
  readFile: fsPromises.readFile, stat: fsPromises.stat, access: fsPromises.access,
};
const forbidden = vi.fn(() => { throw new Error("HOST_IO_FORBIDDEN"); });
beforeEach(() => {
  forbidden.mockClear();
  childProcess.spawn = forbidden as unknown as typeof childProcess.spawn;
  childProcess.spawnSync = forbidden as unknown as typeof childProcess.spawnSync;
  fsPromises.readFile = forbidden as unknown as typeof fsPromises.readFile;
  fsPromises.stat = forbidden as unknown as typeof fsPromises.stat;
  fsPromises.access = forbidden as unknown as typeof fsPromises.access;
  syncBuiltinESMExports();
});
afterEach(() => {
  Object.assign(childProcess, { spawn: original.spawn, spawnSync: original.spawnSync });
  Object.assign(fsPromises, { readFile: original.readFile, stat: original.stat, access: original.access });
  syncBuiltinESMExports();
});

class CapturingExecutor implements ToolExecutor {
  readonly calls: Array<{ command: string[]; options?: ExecOptions }> = [];
  code = 0;
  stderr = "";
  omitExit = false;
  newline = false;
  duringStat?: () => void;
  readonly probes: string[] = [];
  readonly fileSystem = Object.assign(new MemoryFileSystem(), {
    stat: async (path: string) => {
      this.probes.push(`stat ${path}`);
      this.duringStat?.();
      return { isDirectory: true, isFile: false, isSymbolicLink: false, size: 0, mtimeMs: 0 };
    },
    access: async (path: string) => {
      this.probes.push(`access ${path}`);
      if (!path.endsWith("/.git")) this.duringStat?.();
      if (path.endsWith("/.git")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    readFile: async (path: string) => {
      this.probes.push(`read ${path}`);
      return Buffer.from("before\nNeedle\nafter");
    },
  });
  async *exec(command: string[], options?: ExecOptions): AsyncIterable<ExecOutputChunk> {
    this.calls.push({ command, options });
    if (this.stderr) yield { stream: "stderr", text: this.stderr };
    if (this.code === 0) {
      // No final newline: close must follow readline's last buffered line.
      yield { stream: "stdout", text: command[0] === "fd"
        ? "/skills/fixture/nested/a.ts"
        : JSON.stringify({ type: "match", data: {
          path: { text: "/home/user/src/a.ts" }, line_number: 2,
          lines: { text: "Needle\n" },
        } }) + (this.newline ? "\n" : "") };
    }
    if (!this.omitExit) options?.onExit?.({ exitCode: this.code });
  }
  async readFile(): Promise<string> { throw new Error("unexpected text read"); }
  async writeFile(): Promise<void> { throw new Error("unexpected write"); }
  async list(): Promise<never[]> { throw new Error("search must not use file-list matching"); }
}

async function run(executor: ToolExecutor, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const tool = buildCustomTools(executor).find((tool) => tool.name === name) as ToolDefinition;
  return tool.execute("search", args as never, signal, undefined, {} as never);
}

describe("native search sandbox boundary", () => {
  it("executes native rg argv through the executor without Host discovery or I/O", async () => {
    const executor = new CapturingExecutor();
    const pattern = "Need(le|less); $(touch should-never-run)";
    const result = await run(executor, "grep", {
      pattern, path: "~/src", glob: "*.{ts,js}", ignoreCase: true, literal: true, context: 1,
    });
    expect(result.content).toEqual([{ type: "text", text: "a.ts-1- before\na.ts:2: Needle\na.ts-3- after" }]);
    const rg = executor.calls.find(({ command }) => command[0] === "rg")!;
    expect(rg.command).toEqual(["rg", "--json", "--line-number", "--color=never", "--hidden",
      "--ignore-case", "--fixed-strings", "--glob", "*.{ts,js}", "--", pattern, "/home/user/src"]);
    expect(rg.options?.timeoutSeconds).toBe(0);
    expect(rg.options?.onExit).toBeTypeOf("function");
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("executes native fd and probes all .git ancestors in the sandbox", async () => {
    const executor = new CapturingExecutor();
    const result = await run(executor, "find", { pattern: "src/?hild.ts", path: "/skills/fixture" });
    expect(result.content).toEqual([{ type: "text", text: "nested/a.ts" }]);
    expect(executor.calls.find(({ command }) => command[0] === "fd")?.command).toEqual([
      "fd", "--glob", "--color=never", "--hidden", "--no-require-git", "--max-results", "1000",
      "--full-path", "--", "**/src/?hild.ts", "/skills/fixture",
    ]);
    expect(executor.probes.filter((call) => call.startsWith("access ") && call.endsWith("/.git")))
      .toEqual(["access /skills/fixture/.git", "access /skills/.git", "access /.git"]);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it.each(["grep", "find"])("preserves %s process failures", async (name) => {
    const executor = new CapturingExecutor();
    executor.code = 2;
    executor.stderr = "invalid search syntax";
    await expect(run(executor, name, { pattern: "[" })).rejects.toThrow("invalid search syntax");
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("does not fabricate a successful exit when the executor loses status", async () => {
    const executor = new CapturingExecutor();
    executor.omitExit = true;
    await expect(run(executor, "grep", { pattern: "Needle" })).rejects.toThrow("did not report process exit");
  });

  it.each(["grep", "find"])("does not start %s when cancelled during filesystem probes", async (name) => {
    const executor = new CapturingExecutor();
    const controller = new AbortController();
    executor.duringStat = () => controller.abort();
    await expect(run(executor, name, { pattern: "Needle" }, controller.signal)).rejects.toThrow();
    expect(executor.calls).toEqual([]);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("retains native match-limit notices and kills the underlying search", async () => {
    const executor = new CapturingExecutor();
    executor.newline = true;
    const result = await run(executor, "grep", { pattern: "Needle", limit: 1 });
    expect(result.details).toEqual({ matchLimitReached: 1 });
    expect(executor.calls.find(({ command }) => command[0] === "rg")?.options?.signal?.aborted).toBe(true);
  });
});
