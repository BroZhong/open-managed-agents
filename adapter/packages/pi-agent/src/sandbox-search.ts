import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { GrepToolOptions } from "@earendil-works/pi-coding-agent";
import {
  SANDBOX_WORKSPACE_ROOT,
  type ExecExitResult,
  type ToolExecutor,
} from "@open-managed-agents/adapter-core";

type SearchSpawn = NonNullable<GrepToolOptions["spawn"]>;

/** Pi keeps ownership of rg/fd arguments, parsing, limits and tool results. */
export function sandboxSearchSpawn(executor: ToolExecutor): SearchSpawn {
  return (command, args) => new SandboxSearchProcess(executor, [command, ...args]);
}

/** The ChildProcess surface Pi consumes, backed by one sandbox command. */
class SandboxSearchProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  private closed = false;
  private readonly controller = new AbortController();

  constructor(executor: ToolExecutor, command: string[]) {
    super();
    // Like spawn(), return before delivering output/errors so Pi can attach
    // readline and error/close listeners. No Host process is created here.
    queueMicrotask(() => { void this.run(executor, command); });
  }

  kill(): boolean {
    if (this.closed || this.killed) return false;
    this.killed = true;
    this.controller.abort();
    return true;
  }

  private async run(executor: ToolExecutor, command: string[]): Promise<void> {
    let result: ExecExitResult | undefined;
    let failure: Error | undefined;
    try {
      for await (const chunk of executor.exec(command, {
        cwd: ".",
        timeoutSeconds: 0,
        signal: this.controller.signal,
        onExit: (exit) => { result = exit; },
      })) {
        // Pi's readline consumer kills rg at the match limit. Discard further
        // queued output while the backend confirms process termination.
        if (!this.killed) this[chunk.stream].write(chunk.text);
      }
      if (!result) throw new Error("Search executor did not report process exit status");
    } catch (error) {
      // A confirmed kill is a normal ChildProcess close. An RPC cancellation
      // without a termination result remains an error, never a fake exit 0.
      // Backend allocation can also be cancelled before any process exists.
      // Recognize its explicit contract across pnpm package snapshots; a
      // generic AbortError alone does not prove that a remote process stopped.
      const neverStarted = typeof error === "object" && error !== null
        && "code" in error && error.code === "EXEC_ABORTED_BEFORE_START";
      if (!(this.killed && (result || neverStarted))) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    }
    this.closed = true;
    // Node emits close after stdout/stderr end. readline must consume its last
    // (possibly unterminated) line before Pi formats the tool result.
    const ended = Promise.all([this.stdout, this.stderr].map((stream) =>
      new Promise<void>((resolve) => { stream.once("end", resolve); stream.end(); }),
    ));
    await ended;
    if (failure) this.emit("error", failure);
    this.emit("close", result?.exitCode ?? null);
  }
}

/** Filesystem operations only; search itself always runs the real rg/fd. */
export function sandboxSearchFiles(executor: ToolExecutor, signal?: AbortSignal) {
  async function query(action: "stat" | "exists" | "read", absolutePath: string) {
    if (signal?.aborted) throw new Error("Operation aborted");
    const prefix = `${SANDBOX_WORKSPACE_ROOT}/`;
    const filePath = absolutePath === SANDBOX_WORKSPACE_ROOT ? "."
      : absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
    let output = "";
    for await (const chunk of executor.exec(
      ["python3", "-I", "-c", SEARCH_FILE_PROGRAM, action, filePath],
      { cwd: ".", timeoutSeconds: 0, signal },
    )) {
      if (chunk.stream === "stdout") output += chunk.text;
    }
    if (signal?.aborted) throw new Error("Operation aborted");
    const response = JSON.parse(output) as {
      error?: string; exists?: boolean; isDirectory?: boolean; data?: string;
    };
    if (response.error) throw new Error(response.error);
    return response;
  }
  return {
    async isDirectory(path: string): Promise<boolean> {
      const result = await query("stat", path);
      if (typeof result.isDirectory !== "boolean") throw new Error("Invalid sandbox stat result");
      return result.isDirectory;
    },
    async exists(path: string): Promise<boolean> {
      const result = await query("exists", path);
      if (typeof result.exists !== "boolean") throw new Error("Invalid sandbox exists result");
      return result.exists;
    },
    async readFile(path: string): Promise<string> {
      const result = await query("read", path);
      if (typeof result.data !== "string") throw new Error("Invalid sandbox read result");
      // Match fs.readFile(path, 'utf8'), including BOM and replacement decoding.
      return Buffer.from(result.data, "base64").toString("utf8");
    },
  };
}

// Isolated Python provides stat/access/raw bytes missing from ToolExecutor's
// file-list/text-only surface. It performs no matching, traversal or formatting.
const SEARCH_FILE_PROGRAM = String.raw`
import base64
import json
import os
import stat
import sys
from pathlib import Path

try:
    action, name = sys.argv[1:]
    if action == "exists":
        result = {"exists": os.access(name, os.F_OK)}
    elif action == "stat":
        result = {"isDirectory": stat.S_ISDIR(os.stat(name).st_mode)}
    elif action == "read":
        result = {"data": base64.b64encode(Path(name).read_bytes()).decode("ascii")}
    else:
        raise ValueError("Unknown filesystem operation")
    print(json.dumps(result))
except Exception as error:
    print(json.dumps({"error": str(error)}))
`;
