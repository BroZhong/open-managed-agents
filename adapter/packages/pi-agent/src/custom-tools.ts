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
  FindOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
  ToolDefinition,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { ToolExecutor } from "@open-managed-agents/adapter-core";

/**
 * Build the set of Pi `ToolDefinition`s the model calls, using Pi's own native
 * tool factories (ADR-0005 §2, design doc "方案一"). We do NOT hand-write any
 * schema: each `create*ToolDefinition` owns the exact schema, argument
 * validation, rendering, and truncation Pi ships — so the model-visible tool
 * surface is 100% identical to Pi native and tracks Pi upgrades for free. All
 * we supply is one set of `*Operations` that redirect every filesystem read /
 * write and command execution into the injected {@link ToolExecutor} (the
 * sandbox), so nothing ever touches the Host's local disk.
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
    defineTool(createBashToolDefinition(WORKSPACE_ROOT, { operations: bashOperations(executor) })),
    defineTool(createReadToolDefinition(WORKSPACE_ROOT, { operations: readOperations(executor) })),
    defineTool(createWriteToolDefinition(WORKSPACE_ROOT, { operations: writeOperations(executor) })),
    defineTool(createEditToolDefinition(WORKSPACE_ROOT, { operations: editOperations(executor) })),
    defineTool(createLsToolDefinition(WORKSPACE_ROOT, { operations: lsOperations(executor) })),
    defineTool(createGrepToolDefinition(WORKSPACE_ROOT, { operations: grepOperations(executor) })),
    defineTool(createFindToolDefinition(WORKSPACE_ROOT, { operations: findOperations(executor) })),
  ];
}

/**
 * The sandbox workspace root we hand to every `create*ToolDefinition` as its
 * `cwd`. Pi resolves the model's `path` arg against this root and hands our
 * operations an ABSOLUTE path under it (e.g. `path: "note.txt"` →
 * `/workspace/note.txt`). Our operations strip this prefix back to the
 * workspace-relative path the {@link ToolExecutor} expects (its own root is
 * this workspace; it re-resolves relative → absolute under that root).
 *
 * It is a synthetic label, not a real Host directory — the executor is
 * abstract and never exposes a concrete path.
 */
const WORKSPACE_ROOT = "/workspace";

/**
 * Map a Pi-resolved absolute path back to the workspace-relative POSIX path the
 * {@link ToolExecutor} expects. Pi always resolves `path` args against
 * {@link WORKSPACE_ROOT}, so an in-root path starts with `"/workspace/"`; the
 * root itself maps to `"."`. A path outside the root (should not happen for
 * model-supplied relative paths) is passed through unchanged so the executor's
 * own containment check rejects it loudly.
 */
function toRelative(absolutePath: string): string {
  if (absolutePath === WORKSPACE_ROOT) return ".";
  const prefix = `${WORKSPACE_ROOT}/`;
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
}

/** Map a workspace-relative executor path back into Pi's absolute space. */
function toAbsolute(relativePath: string): string {
  return relativePath === "." ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}/${relativePath}`;
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

function readOperations(executor: ToolExecutor): ReadOperations {
  return {
    async readFile(absolutePath) {
      return Buffer.from(await executor.readFile(toRelative(absolutePath)));
    },
    // The executor has no dedicated readability probe; a failed read is the
    // access failure. Reading here would double-read, so probe via `list`.
    async access(absolutePath) {
      await statOrThrow(executor, absolutePath);
    },
  };
}

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

function grepOperations(executor: ToolExecutor): GrepOperations {
  return {
    async isDirectory(absolutePath) {
      const rel = toRelative(absolutePath);
      const entries = await executor.list(rel);
      if (entries.length === 0) throw new Error(`Path not found: ${absolutePath}`);
      return isDirectoryListing(rel, entries);
    },
    async readFile(absolutePath) {
      return executor.readFile(toRelative(absolutePath));
    },
  };
}

function findOperations(executor: ToolExecutor): FindOperations {
  return {
    async exists(absolutePath) {
      return (await executor.list(toRelative(absolutePath))).length > 0;
    },
    async glob(pattern, cwd, options) {
      // The executor's `list` takes one glob relative to its own root. Anchor
      // the caller's pattern under the search dir, list matches, then hand Pi
      // back absolute paths (it relativizes them against `cwd` itself).
      const searchDir = toRelative(cwd);
      const scoped = searchDir === "." ? pattern : `${searchDir}/${pattern}`;
      const entries = await executor.list(scoped);
      return entries.slice(0, options.limit).map((e) => toAbsolute(e.path));
    },
  };
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
