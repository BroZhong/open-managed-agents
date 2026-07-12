import childProcess from "node:child_process";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  ExecOptions,
  ExecOutputChunk,
  FileListEntry,
  ToolExecutor,
} from "@open-managed-agents/adapter-core";

const hostIo = {
  spawn: vi.fn(() => {
    throw new Error("HOST_SPAWN_FORBIDDEN");
  }),
  readFile: vi.fn(() => {
    throw new Error("HOST_READ_FORBIDDEN");
  }),
  stat: vi.fn(() => {
    throw new Error("HOST_STAT_FORBIDDEN");
  }),
};

const originalHostIo = {
  spawn: childProcess.spawn,
  readFile: fsPromises.readFile,
  stat: fsPromises.stat,
};

beforeEach(() => {
  hostIo.spawn.mockClear();
  hostIo.readFile.mockClear();
  hostIo.stat.mockClear();
  childProcess.spawn = hostIo.spawn as unknown as typeof childProcess.spawn;
  fsPromises.readFile = hostIo.readFile as unknown as typeof fsPromises.readFile;
  fsPromises.stat = hostIo.stat as unknown as typeof fsPromises.stat;
  syncBuiltinESMExports();
});

afterEach(() => {
  childProcess.spawn = originalHostIo.spawn;
  fsPromises.readFile = originalHostIo.readFile;
  fsPromises.stat = originalHostIo.stat;
  syncBuiltinESMExports();
});

import { buildCustomTools } from "../src/custom-tools.js";

class CapturingExecutor implements ToolExecutor {
  readonly calls: Array<{ command: string[]; options?: ExecOptions }> = [];

  constructor(
    private readonly response: Record<string, unknown> = {
      output: "src/a.ts:2: const Needle = 1;",
    },
  ) {}

  async *exec(
    command: string[],
    options?: ExecOptions,
  ): AsyncIterable<ExecOutputChunk> {
    this.calls.push({ command, options });
    yield { stream: "stdout", text: JSON.stringify(this.response) };
  }

  async readFile(): Promise<string> {
    throw new Error("grep must not read files in the Host process");
  }

  async writeFile(): Promise<void> {
    throw new Error("not used");
  }

  async list(): Promise<FileListEntry[]> {
    throw new Error("grep must delegate traversal to the sandbox process");
  }
}

function grepTool(executor: ToolExecutor): ToolDefinition {
  const tool = buildCustomTools(executor).find(({ name }) => name === "grep");
  if (!tool) throw new Error("grep tool missing");
  return tool;
}

async function runGrep(
  executor: ToolExecutor,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ text: string; details: unknown }> {
  const result = await grepTool(executor).execute(
    "grep-call",
    args as never,
    signal as never,
    undefined,
    {} as never,
  );
  return {
    text: result.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map(({ text }) => text)
      .join("\n"),
    details: result.details,
  };
}

describe("sandbox-backed grep boundary", () => {
  it("runs the search program only through ToolExecutor.exec", async () => {
    const executor = new CapturingExecutor();
    const controller = new AbortController();

    const result = await runGrep(
      executor,
      {
        pattern: "Need(le|less)",
        path: "/home/user/src",
        glob: "**/*.ts",
        ignoreCase: true,
        literal: false,
        context: 1.9,
        limit: 20.8,
      },
      controller.signal,
    );

    expect(result.text).toBe("src/a.ts:2: const Needle = 1;");
    expect(executor.calls).toHaveLength(1);
    const [{ command, options }] = executor.calls;
    expect(command.slice(0, 3)).toEqual(["python3", "-I", "-c"]);
    expect(command[3]).toContain("import fnmatch");
    expect(JSON.parse(command[4])).toMatchObject({
      pattern: "Need(le|less)",
      path: "src",
      glob: "**/*.ts",
      ignoreCase: true,
      literal: false,
      context: 1,
      limit: 20,
    });
    expect(options).toMatchObject({ cwd: ".", timeoutSeconds: 30 });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(hostIo.spawn).not.toHaveBeenCalled();
    expect(hostIo.readFile).not.toHaveBeenCalled();
    expect(hostIo.stat).not.toHaveBeenCalled();
  });

  it("passes an absolute Skill projection path through to the sandbox program", async () => {
    const executor = new CapturingExecutor({ output: "SKILL.md:2: staged agents" });

    await runGrep(executor, {
      pattern: "staged agents",
      path: "/skills/storyboard",
    });

    expect(JSON.parse(executor.calls[0].command[4]).path).toBe(
      "/skills/storyboard",
    );
  });

  it("surfaces a structured sandbox search error", async () => {
    const executor = new CapturingExecutor({ error: "Path not found: missing" });

    await expect(
      runGrep(executor, { pattern: "x", path: "missing" }),
    ).rejects.toThrow("Path not found: missing");
  });

  it("accepts a fully escaped legitimate 50KB sandbox result", async () => {
    const output = "\0".repeat(50 * 1024);
    const executor = new CapturingExecutor({ output });

    await expect(runGrep(executor, { pattern: "x" })).resolves.toMatchObject({
      text: output,
    });
  });

  it("aborts before buffering unbounded sandbox output", async () => {
    const executor = new CapturingExecutor({ output: "x".repeat(600_000) });

    await expect(
      runGrep(executor, { pattern: "x" }),
    ).rejects.toThrow(/output exceeded/i);
    expect(executor.calls[0].options?.signal?.aborted).toBe(true);
  });
});
