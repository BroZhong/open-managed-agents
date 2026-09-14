import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { GrepToolOptions } from "@earendil-works/pi-coding-agent";
import {
  type ExecExitResult,
  type ToolExecutor,
} from "@open-managed-agents/adapter-core";

import { executorFileSystem, fileExists, toExecutorPath } from "./native-files.js";

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
        if (!this.killed) this[chunk.stream].write(chunk.bytes ?? chunk.text);
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
  const fs = executorFileSystem(executor);
  return {
    async isDirectory(path: string): Promise<boolean> {
      return (await fs.stat(toExecutorPath(path), { signal })).isDirectory;
    },
    exists: (path: string) => fileExists(fs, path, signal),
    async readFile(path: string): Promise<string> {
      // Match native Node UTF-8 decoding, including BOM and invalid bytes.
      return Buffer.from(await fs.readFile(toExecutorPath(path), { signal })).toString("utf8");
    },
  };
}
