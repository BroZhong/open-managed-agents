import { constants } from "node:fs";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  detectSupportedImageMimeType,
} from "@earendil-works/pi-coding-agent";
import type { BashOperations, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  SANDBOX_WORKSPACE_ROOT,
  type ExecExitResult,
  type ToolExecutor,
} from "@open-managed-agents/adapter-core";
import { executorFileSystem, fileExists, toExecutorPath } from "./native-files.js";
import { canonicalMutationPath } from "./mutation-path.js";
import { sandboxSearchFiles, sandboxSearchSpawn } from "./sandbox-search.js";

/**
 * Keep Pi's schemas, algorithms, truncation and rendering. Only native I/O is
 * redirected through the per-run executor (ADR-0005). Filesystem metadata is
 * distinct from the recursive, regular-file-only Workspace persistence list.
 */
export function buildCustomTools(executor: ToolExecutor): ToolDefinition[] {
  const fs = executorFileSystem(executor);
  const cwd = SANDBOX_WORKSPACE_ROOT;
  const homeDir = cwd;
  return [
    defineTool(createBashToolDefinition(cwd, {
      operations: bashOperations(executor),
      // Environment belongs to the executor/Sandbox, never the Host process.
      env: {},
      async createOutputSink() {
        const path = await fs.createTempFile();
        let chunks: Buffer[] = [];
        let size = 0;
        const flush = async () => {
          if (size === 0) return;
          const bytes = Buffer.concat(chunks, size);
          chunks = [];
          size = 0;
          await fs.appendFile(toExecutorPath(path), bytes);
        };
        return {
          path,
          // Coalesce small process chunks into bounded transport writes. Pi's
          // accumulator serializes these calls and awaits close before return.
          write(data: Buffer) {
            chunks.push(data);
            size += data.length;
            if (size >= 256 * 1024) return flush();
          },
          close: flush,
        };
      },
    })),
    defineTool(perInvocation((signal) => {
      // MIME sniffing and reading share exactly one byte read per invocation.
      const reads = new Map<string, Promise<Buffer>>();
      const read = (path: string) => {
        let pending = reads.get(path);
        if (!pending) {
          pending = fs.readFile(toExecutorPath(path), { signal }).then((bytes) => Buffer.from(bytes));
          reads.set(path, pending);
        }
        return pending;
      };
      return createReadToolDefinition(cwd, {
        homeDir,
        operations: {
          readFile: read,
          access: (path) => fs.access(toExecutorPath(path), constants.R_OK, { signal }),
          exists: (path) => fileExists(fs, path, signal),
          detectImageMimeType: async (path) =>
            detectSupportedImageMimeType((await read(path)).subarray(0, 4100)),
        },
      });
    })),
    defineTool(perInvocation((signal) =>
      createWriteToolDefinition(cwd, {
        homeDir,
        mutationScope: fs,
        operations: {
          writeFile: (path, content) => fs.writeFile(toExecutorPath(path), Buffer.from(content), { signal }),
          mkdir: (path) => fs.mkdir(toExecutorPath(path), { signal }),
          realpath: (path) => canonicalMutationPath(fs, path, signal),
        },
      }))),
    defineTool(perInvocation((signal) =>
      createEditToolDefinition(cwd, {
        homeDir,
        mutationScope: fs,
        operations: {
          readFile: async (path) => Buffer.from(await fs.readFile(toExecutorPath(path), { signal })),
          writeFile: (path, content) => fs.writeFile(toExecutorPath(path), Buffer.from(content), { signal }),
          access: (path, mode = constants.R_OK | constants.W_OK) => fs.access(toExecutorPath(path), mode, { signal }),
          realpath: (path) => canonicalMutationPath(fs, path, signal),
        },
      }))),
    defineTool(perInvocation((signal) =>
      createLsToolDefinition(cwd, {
        homeDir,
        operations: {
          exists: (path) => fileExists(fs, path, signal),
          stat: async (path) => {
            const info = await fs.stat(toExecutorPath(path), { signal });
            return { isDirectory: () => info.isDirectory };
          },
          readdir: (path) => fs.readdir(toExecutorPath(path), { signal }),
        },
      }))),
    defineTool(perInvocation((signal) =>
      createGrepToolDefinition(cwd, {
        operations: sandboxSearchFiles(executor, signal),
        spawn: sandboxSearchSpawn(executor),
        homeDir,
      }))),
    defineTool(perInvocation((signal) =>
      createFindToolDefinition(cwd, {
        operations: { exists: (path) => fileExists(fs, path, signal) },
        spawn: sandboxSearchSpawn(executor),
        homeDir,
      }))),
  ];
}

/** File hooks receive this invocation's signal without sharing mutable state. */
function perInvocation<T extends TSchema, D>(
  create: (signal?: AbortSignal) => ToolDefinition<T, D>,
): ToolDefinition<T, D> {
  return {
    ...create(),
    execute: (id, args, signal, onUpdate, ctx) => create(signal).execute(id, args, signal, onUpdate, ctx),
  };
}

function bashOperations(executor: ToolExecutor): BashOperations {
  const fs = executorFileSystem(executor);
  return {
    async exec(command, cwd, options) {
      if (options.signal?.aborted) throw new Error("aborted");
      if (!await fileExists(fs, cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      let timedOut = false;
      let result: ExecExitResult | undefined;
      const timeout = options.timeout === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeout * 1000);
      const cancellation = () => new Error(options.signal?.aborted ? "aborted" : `timeout:${options.timeout}`);
      try {
        try {
          for await (const chunk of executor.exec(["/bin/bash", "-c", command], {
            cwd: toExecutorPath(cwd),
            // This layer owns Pi's deadline so timeout and user cancellation
            // retain the native result wording and preceding command output.
            timeoutSeconds: 0,
            signal: controller.signal,
            env: Object.fromEntries(Object.entries(options.env ?? {}).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            )),
            onExit: (exit) => { result = exit; },
          })) {
            options.onData(Buffer.from(chunk.bytes ?? chunk.text));
          }
        } catch (error) {
          const neverStarted = typeof error === "object" && error !== null
            && "code" in error && error.code === "EXEC_ABORTED_BEFORE_START";
          // A transport cancellation alone cannot prove a remote process ended.
          if ((result || neverStarted) && (options.signal?.aborted || timedOut)) throw cancellation();
          throw error;
        }
        if (!result) throw new Error("Bash executor did not report process exit status");
        if (options.signal?.aborted || timedOut) throw cancellation();
        return { exitCode: result.exitCode };
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
