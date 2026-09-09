import { randomUUID } from "node:crypto";
import type {
  ToolFileStat,
  ToolFileSystem,
  ToolFileSystemOptions,
} from "@open-managed-agents/adapter-core";
import type { SandboxExecChunk, SandboxExecOptions } from "./sandbox-client.js";

const RESPONSE_PREFIX = "\u001eoma-fs:";

/**
 * Execute the same Node filesystem operations inside the sandbox. The SDK's
 * file API creates parent directories on write and does not distinguish
 * stat/lstat, so it cannot implement these native contracts directly.
 * Only binary staging uses that API; target paths always reach Node fs.
 */
export const SANDBOX_FILE_SYSTEM_SCRIPT = String.raw`
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const request = JSON.parse(process.argv[1]);
const describe = (s) => ({
  isFile: s.isFile(), isDirectory: s.isDirectory(),
  isSymbolicLink: s.isSymbolicLink(), size: s.size, mtimeMs: s.mtimeMs,
});
(async () => {
  let value;
  switch (request.operation) {
    case "readFile": value = (await fs.readFile(request.path)).toString("base64"); break;
    case "writeFile": await fs.writeFile(request.path, await fs.readFile(request.dataPath)); break;
    case "appendFile": await fs.appendFile(request.path, await fs.readFile(request.dataPath)); break;
    case "access": await fs.access(request.path, request.mode); break;
    case "stat": value = describe(await fs.stat(request.path)); break;
    case "lstat": value = describe(await fs.lstat(request.path)); break;
    case "realpath": value = await fs.realpath(request.path); break;
    case "readdir": value = await fs.readdir(request.path); break;
    case "mkdir": await fs.mkdir(request.path, { recursive: true }); break;
    case "createTempFile": {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oma-pi-"));
      value = path.join(directory, "output.log");
      const file = await fs.open(value, "wx", 0o600);
      await file.close();
      break;
    }
    default: throw new Error("Unknown filesystem operation");
  }
  process.stdout.write("\u001eoma-fs:" + JSON.stringify({ ok: true, value }) + "\n");
})().catch((error) => {
  const details = {};
  for (const key of ["name", "message", "code", "errno", "syscall", "path", "dest"]) {
    if (error[key] !== undefined) details[key] = error[key];
  }
  process.stdout.write("\u001eoma-fs:" + JSON.stringify({ ok: false, error: details }) + "\n");
});
`;

interface SandboxFileSystemBackend {
  exec(command: string[], options?: SandboxExecOptions): AsyncIterable<SandboxExecChunk>;
  writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

interface NativeRequest {
  operation: keyof ToolFileSystem;
  path?: string;
  mode?: number;
  dataPath?: string;
}

type NativeResponse =
  | { ok: true; value?: unknown }
  | { ok: false; error: Record<string, unknown> };

/** Build one stable capability object for a specific sandbox handle. */
export function createSandboxFileSystem(backend: SandboxFileSystemBackend): ToolFileSystem {
  const call = async <T>(
    request: NativeRequest,
    options?: ToolFileSystemOptions,
    content?: Uint8Array,
  ): Promise<T> => {
    options?.signal?.throwIfAborted();
    // argv has a small per-argument limit on Linux. Staging avoids embedding
    // image bytes or large writes into a shell command or its environment.
    const dataPath = content === undefined ? undefined : `/tmp/oma-pi-io-${randomUUID()}`;
    try {
      if (dataPath) {
        await backend.writeFileBytes(dataPath, content!);
        options?.signal?.throwIfAborted();
      }
      let stdout = "";
      let stderr = "";
      let exitCode: number | null | undefined;
      const mutates = ["writeFile", "appendFile", "mkdir", "createTempFile"].includes(request.operation);
      for await (const chunk of backend.exec(
        ["node", "--input-type=commonjs", "-e", SANDBOX_FILE_SYSTEM_SCRIPT, JSON.stringify({ ...request, dataPath })],
        {
          // Native filesystem calls have no implicit command deadline.
          timeoutSeconds: 0,
          // Mutations must finish before rejecting cancellation. A transport
          // race would release the caller's lock while the write still runs.
          ...(!mutates && options?.signal ? { signal: options.signal } : {}),
          onExit: (result) => { exitCode = result.exitCode; },
        },
      )) {
        if (chunk.stream === "stdout") stdout += chunk.text;
        else stderr += chunk.text;
      }
      const marker = stdout.lastIndexOf(RESPONSE_PREFIX);
      if (exitCode !== 0 || marker === -1) {
        throw new Error(`Sandbox filesystem helper failed (exit ${exitCode ?? "unknown"}): ${stderr || stdout}`);
      }
      const response = JSON.parse(stdout.slice(marker + RESPONSE_PREFIX.length).trim()) as NativeResponse;
      if (!response.ok) {
        const error = new Error(String(response.error.message ?? "Sandbox filesystem operation failed"));
        for (const key of ["name", "code", "errno", "syscall", "path", "dest"]) {
          if (response.error[key] !== undefined) Object.defineProperty(error, key, {
            value: response.error[key], configurable: true, writable: true, enumerable: key !== "name",
          });
        }
        throw error;
      }
      options?.signal?.throwIfAborted();
      return response.value as T;
    } finally {
      if (dataPath) {
        // Cleanup uses its own request: an already-aborted turn must not
        // prevent removal of the temporary transport payload. Cleanup failure
        // must not mask an errno or turn a completed append into a retry.
        // Any leftover staging file expires with this disposable sandbox.
        try { await backend.remove(dataPath); } catch { /* Preserve the operation outcome. */ }
      }
    }
  };

  return {
    readFile: async (path, options) => Buffer.from(await call<string>({ operation: "readFile", path }, options), "base64"),
    writeFile: (path, content, options) => call<void>({ operation: "writeFile", path }, options, content),
    appendFile: (path, content, options) => call<void>({ operation: "appendFile", path }, options, content),
    access: (path, mode, options) => call<void>({ operation: "access", path, mode }, options),
    stat: (path, options) => call<ToolFileStat>({ operation: "stat", path }, options),
    lstat: (path, options) => call<ToolFileStat>({ operation: "lstat", path }, options),
    realpath: (path, options) => call<string>({ operation: "realpath", path }, options),
    readdir: (path, options) => call<string[]>({ operation: "readdir", path }, options),
    mkdir: (path, options) => call<void>({ operation: "mkdir", path }, options),
    createTempFile: (options) => call<string>({ operation: "createTempFile" }, options),
  };
}
