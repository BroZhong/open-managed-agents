import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import type {
  BashOperations,
  EditOperations,
  LsOperations,
  ReadOperations,
  ToolDefinition,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  SANDBOX_WORKSPACE_ROOT,
  type ToolExecutor,
} from "@open-managed-agents/adapter-core";
import { sandboxSearchFiles, sandboxSearchSpawn } from "./sandbox-search.js";

/**
 * Build the set of Pi `ToolDefinition`s the model calls, using Pi's own native
 * tool factories (ADR-0005 §2, design doc "方案一"). We do NOT hand-write any
 * schema: each `create*ToolDefinition` owns the exact schema, argument
 * validation, and rendering Pi ships. A pinned Pi patch exposes per-tool
 * process hooks for native rg/fd, alongside the filesystem operation seams.
 * Every operation
 * ultimately goes through the injected {@link ToolExecutor} (the sandbox), so
 * nothing touches the Host's local disk.
 *
 * These are passed to `createAgentSession({ customTools, noTools: "builtin" })`
 * so that Pi's default fs/bash tools (which would hit the Host disk) are
 * disabled and every tool the model calls runs through the per-run() executor.
 *
 * This is intentionally Pi-specific with zero reuse reservation (ADR-0005 §2):
 * we couple freely to Pi's factories and operation shapes rather than abstract
 * a neutral tool package for a second, hypothetical runtime.
 */
export function buildCustomTools(executor: ToolExecutor): ToolDefinition[] {
  // Each factory returns a `ToolDefinition` parameterized by its own concrete
  // schema; those specialized types are invariant and do not widen to the
  // default-generic `ToolDefinition[]`. Passing each through `defineTool`
  // intersects it with Pi's `AnyToolDefinition` (the same bridge Pi uses
  // internally), making the set assignable without touching the schemas.
  return [
    defineTool(
      createBashToolDefinition(SANDBOX_WORKSPACE_ROOT, {
        operations: bashOperations(executor),
      }),
    ),
    defineTool(createSandboxReadToolDefinition(executor)),
    defineTool(
      createWriteToolDefinition(SANDBOX_WORKSPACE_ROOT, {
        operations: writeOperations(executor),
      }),
    ),
    defineTool(
      createEditToolDefinition(SANDBOX_WORKSPACE_ROOT, {
        operations: editOperations(executor),
      }),
    ),
    defineTool(
      createLsToolDefinition(SANDBOX_WORKSPACE_ROOT, {
        operations: lsOperations(executor),
      }),
    ),
    defineTool(createSandboxGrepToolDefinition(executor)),
    defineTool(createSandboxFindToolDefinition(executor)),
  ];
}

/**
 * Map a Pi-resolved absolute path back to the workspace-relative POSIX path the
 * {@link ToolExecutor} expects. Pi resolves each model path against
 * {@link SANDBOX_WORKSPACE_ROOT}; `/home/user/note.txt` therefore becomes
 * `note.txt`, while the root itself becomes `.`. Absolute read-only projections
 * such as `/skills/<id>` stay absolute so the SandboxManager can route them
 * outside the writable Workspace.
 */
function toRelative(absolutePath: string): string {
  if (absolutePath === SANDBOX_WORKSPACE_ROOT) return ".";
  const prefix = `${SANDBOX_WORKSPACE_ROOT}/`;
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
}

/**
 * Bridge Pi's bash tool onto the executor. Pi hands us a single shell `command`
 * string plus an `onData(Buffer)` sink and expects an exit code; the executor
 * takes argv and streams `{ text }` chunks with no exit code. We run the
 * command via `["/bin/sh","-c",command]` (mirroring the old execTool's string
 * path), feed each chunk's text to `onData`, and — since the executor surface
 * has no exit code — return `{ exitCode: 0 }` on normal completion. A failed
 * command that the executor surfaces as a thrown error propagates out of
 * `exec()`, which Pi's bash tool catches and renders as an error result (its
 * own `Command exited with code N` path only fires for a non-zero numeric
 * code, which the executor cannot report — a thrown error is the failure
 * signal here).
 */
function bashOperations(executor: ToolExecutor): BashOperations {
  return {
    async exec(command, cwd, options) {
      for await (const chunk of executor.exec(["/bin/sh", "-c", command], {
        cwd: toRelative(cwd),
        // Pi's bash `timeout` is already in SECONDS ("Timeout in seconds") — the
        // executor's `timeoutSeconds` is the same unit, so it passes straight
        // through (the old `/1000` turned 40s into 0.04s → deadline_exceeded,
        // issue #81). When the model omits `timeout`, Pi's contract is "no
        // default timeout"; we encode that as `timeoutSeconds: 0` (= disabled,
        // mirroring the e2b SDK's `timeoutMs: 0`), NOT `undefined` — undefined
        // would fall through to a backend default.
        timeoutSeconds: options.timeout ?? 0,
        // Thread the turn's native abort signal down so a hung exec is
        // cancellable end-to-end (issue #84).
        signal: options.signal,
      })) {
        options.onData(Buffer.from(chunk.text));
      }
      return { exitCode: 0 };
    },
  };
}

function createSandboxReadToolDefinition(executor: ToolExecutor) {
  const native = createReadToolDefinition(SANDBOX_WORKSPACE_ROOT);
  const execute: typeof native.execute = (id, args, signal, onUpdate, ctx) => {
    // Keep bytes scoped to this invocation: MIME detection and read share one
    // sandbox read, while concurrent or subsequent reads never share a cache.
    return createReadToolDefinition(SANDBOX_WORKSPACE_ROOT, {
      operations: readOperations(executor, signal),
    }).execute(id, args, signal, onUpdate, ctx);
  };
  return { ...native, execute };
}

function readOperations(executor: ToolExecutor, signal?: AbortSignal): ReadOperations {
  const reads = new Map<string, Promise<{ bytes: Buffer; mimeType?: string }>>();
  const read = (absolutePath: string) => {
    let pending = reads.get(absolutePath);
    if (!pending) {
      pending = readSandboxBytes(executor, toRelative(absolutePath), signal);
      reads.set(absolutePath, pending);
    }
    return pending;
  };
  return {
    async readFile(absolutePath) {
      return (await read(absolutePath)).bytes;
    },
    async detectImageMimeType(absolutePath) {
      return (await read(absolutePath)).mimeType;
    },
    // The executor has no dedicated readability probe; a failed read is the
    // access failure. Reading here would double-read, so probe via `list`.
    async access(absolutePath) {
      await statOrThrow(executor, absolutePath);
    },
  };
}

const MAX_SANDBOX_READ_BYTES = 32 * 1024 * 1024;

async function readSandboxBytes(executor: ToolExecutor, path: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();
  let output = "";
  try {
    for await (const chunk of executor.exec(
      ["python3", "-I", "-c", SANDBOX_READ_PROGRAM, path, String(MAX_SANDBOX_READ_BYTES)],
      { cwd: ".", timeoutSeconds: 30, signal: controller.signal },
    )) {
      if (chunk.stream !== "stdout") continue;
      if (output.length + chunk.text.length > Math.ceil(MAX_SANDBOX_READ_BYTES / 3) * 4 + 4096) {
        controller.abort();
        throw new Error("Read output exceeded its transport limit; use bash or a media tool to inspect or resize the file.");
      }
      output += chunk.text;
    }
    if (signal?.aborted) throw new Error("Operation aborted");
    let response: { data?: string; mimeType?: string; error?: string };
    try {
      response = JSON.parse(output);
    } catch {
      throw new Error("Sandbox read failed to return file bytes; inspect the file with bash or a media tool.");
    }
    if (response.error) throw new Error(response.error);
    if (typeof response.data !== "string") throw new Error("Sandbox read returned no file bytes.");
    return { bytes: Buffer.from(response.data, "base64"), mimeType: response.mimeType };
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
  }
}

// ToolExecutor.readFile is UTF-8-only. Transfer raw bytes through sandbox exec,
// never through that lossy string seam or a Host filesystem fallback. Pi owns
// image processing/base64 content blocks and text pagination after this read.
const SANDBOX_READ_PROGRAM = String.raw`
import base64
import json
import sys
from pathlib import Path

try:
    maximum = int(sys.argv[2])
    with Path(sys.argv[1]).open("rb") as source:
        data = source.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError("File exceeds the 32 MiB read limit; use bash or a media tool to inspect or resize it.")
    mime = None
    if data.startswith(b"\x89PNG\r\n\x1a\n") and data[12:16] == b"IHDR":
        mime = "image/png"
    elif data.startswith(b"\xff\xd8\xff") and data[3:4] != b"\xf7":
        mime = "image/jpeg"
    elif data[:6] in (b"GIF87a", b"GIF89a"):
        mime = "image/gif"
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        mime = "image/webp"
    elif data.startswith(b"BM") and len(data) >= 26:
        mime = "image/bmp"
    if mime is None:
        try:
            if b"\x00" in data:
                raise ValueError("NUL bytes")
            data.decode("utf-8")
        except (UnicodeDecodeError, ValueError):
            raise ValueError("Unsupported binary file: read supports UTF-8 text and PNG/JPEG/GIF/WebP/BMP images. Use bash or a media tool to inspect or convert this file.")
    print(json.dumps({"data": base64.b64encode(data).decode("ascii"), "mimeType": mime}))
except Exception as error:
    print(json.dumps({"error": str(error)}))
`;

function writeOperations(executor: ToolExecutor): WriteOperations {
  return {
    async writeFile(absolutePath, content) {
      await executor.writeFile(toRelative(absolutePath), content);
    },
    // The executor creates parent directories on writeFile, so there is no
    // separate directory to make.
    async mkdir() {},
  };
}

function editOperations(executor: ToolExecutor): EditOperations {
  return {
    async readFile(absolutePath) {
      return Buffer.from(await executor.readFile(toRelative(absolutePath)));
    },
    async writeFile(absolutePath, content) {
      await executor.writeFile(toRelative(absolutePath), content);
    },
    async access(absolutePath) {
      await statOrThrow(executor, absolutePath);
    },
  };
}

function lsOperations(executor: ToolExecutor): LsOperations {
  return {
    async exists(absolutePath) {
      return (await executor.list(toRelative(absolutePath))).length > 0;
    },
    async stat(absolutePath) {
      const rel = toRelative(absolutePath);
      const entries = await executor.list(rel);
      if (entries.length === 0) throw new Error(`Path not found: ${absolutePath}`);
      return { isDirectory: () => isDirectoryListing(rel, entries) };
    },
    async readdir(absolutePath) {
      const rel = toRelative(absolutePath);
      return immediateChildren(rel, await executor.list(rel));
    },
  };
}

/** Per-invocation operations keep cancellation and file access scoped to a Turn. */
function createSandboxGrepToolDefinition(executor: ToolExecutor) {
  const native = createGrepToolDefinition(SANDBOX_WORKSPACE_ROOT);
  const execute: typeof native.execute = (id, args, signal, onUpdate, ctx) =>
    createGrepToolDefinition(SANDBOX_WORKSPACE_ROOT, {
      operations: sandboxSearchFiles(executor, signal),
      spawn: sandboxSearchSpawn(executor),
      homeDir: SANDBOX_WORKSPACE_ROOT,
    }).execute(id, args, signal, onUpdate, ctx);
  return { ...native, execute };
}

function createSandboxFindToolDefinition(executor: ToolExecutor) {
  const native = createFindToolDefinition(SANDBOX_WORKSPACE_ROOT);
  const execute: typeof native.execute = (id, args, signal, onUpdate, ctx) =>
    createFindToolDefinition(SANDBOX_WORKSPACE_ROOT, {
      operations: { exists: sandboxSearchFiles(executor, signal).exists },
      spawn: sandboxSearchSpawn(executor),
      homeDir: SANDBOX_WORKSPACE_ROOT,
    }).execute(id, args, signal, onUpdate, ctx);
  return { ...native, execute };
}

/**
 * `list` returns the entries under a path (recursively) with directories
 * omitted; a single entry whose path equals the queried path is that path as a
 * file. Everything else — multiple entries, or a nested entry — means the path
 * is a directory (or empty, which for our purposes is not a plain file).
 */
function isDirectoryListing(
  rel: string,
  entries: readonly { path: string }[],
): boolean {
  if (entries.length === 1 && entries[0].path === rel) return false;
  return true;
}

/** Throw if the path does not exist in the executor (readability probe). */
async function statOrThrow(executor: ToolExecutor, absolutePath: string): Promise<void> {
  if ((await executor.list(toRelative(absolutePath))).length === 0) {
    throw new Error(`Path not found: ${absolutePath}`);
  }
}

/**
 * Immediate child names of a directory, derived from `list`'s recursive
 * workspace-relative entries. For `rel === "."` (workspace root) the entries
 * are already root-relative; otherwise strip the `dir/` prefix and keep only
 * the first path segment, de-duplicated (so nested files surface their top
 * directory once).
 */
function immediateChildren(rel: string, entries: readonly { path: string }[]): string[] {
  const prefix = rel === "." ? "" : `${rel}/`;
  const names = new Set<string>();
  for (const { path } of entries) {
    if (prefix && !path.startsWith(prefix)) continue;
    const remainder = path.slice(prefix.length);
    const first = remainder.split("/")[0];
    if (first) names.add(first);
  }
  return [...names].sort();
}
