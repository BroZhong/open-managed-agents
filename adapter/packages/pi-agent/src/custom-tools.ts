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
  LsOperations,
  ReadOperations,
  ToolDefinition,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  SANDBOX_WORKSPACE_ROOT,
  type ToolExecutor,
} from "@open-managed-agents/adapter-core";

/**
 * Build the set of Pi `ToolDefinition`s the model calls, using Pi's own native
 * tool factories (ADR-0005 §2, design doc "方案一"). We do NOT hand-write any
 * schema: each `create*ToolDefinition` owns the exact schema, argument
 * validation, and rendering Pi ships. Six tools use Pi's pluggable operation
 * seams; grep retains Pi's schema/renderers but replaces execute because Pi
 * 0.80.3 still Host-spawns `rg` with custom `GrepOperations`. Every operation
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
    defineTool(
      createReadToolDefinition(SANDBOX_WORKSPACE_ROOT, {
        operations: readOperations(executor),
      }),
    ),
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
    defineTool(
      createFindToolDefinition(SANDBOX_WORKSPACE_ROOT, {
        operations: findOperations(executor),
      }),
    ),
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

/** Map a workspace-relative executor path back into Pi's absolute space. */
function toAbsolute(relativePath: string): string {
  return relativePath === "."
    ? SANDBOX_WORKSPACE_ROOT
    : `${SANDBOX_WORKSPACE_ROOT}/${relativePath}`;
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

/**
 * Keep Pi's native grep schema and renderers, but replace its
 * implementation. Pi 0.80.3's `GrepOperations` virtualize stat/read only; the
 * native execute path still spawns Host `rg` against the model-visible cwd.
 * A sandbox-backed tool must instead perform the complete search through the
 * injected executor.
 */
function createSandboxGrepToolDefinition(executor: ToolExecutor) {
  const native = createGrepToolDefinition(SANDBOX_WORKSPACE_ROOT);
  const execute: typeof native.execute = async (
    _toolCallId,
    { pattern, path: searchDir, glob, ignoreCase, literal, context, limit },
    signal,
  ) => {
    if (signal?.aborted) throw new Error("Operation aborted");

    const request = {
      pattern,
      path: resolveExecutorPath(searchDir),
      glob: glob ?? null,
      ignoreCase: ignoreCase ?? false,
      literal: literal ?? false,
      context: context && context > 0 ? Math.floor(context) : 0,
      limit: Math.max(1, Math.floor(limit ?? 100)),
    };
    const executionController = new AbortController();
    const forwardAbort = () => executionController.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    // Close the narrow race between the initial check and listener install.
    if (signal?.aborted) forwardAbort();

    let stdout = "";
    let stderr = "";
    let transportBytes = 0;
    try {
      for await (const chunk of executor.exec(
        ["python3", "-I", "-c", SANDBOX_GREP_PROGRAM, JSON.stringify(request)],
        {
          cwd: ".",
          timeoutSeconds: 30,
          signal: executionController.signal,
        },
      )) {
        const chunkBytes = Buffer.byteLength(chunk.text, "utf8");
        if (transportBytes + chunkBytes > MAX_SANDBOX_GREP_TRANSPORT_BYTES) {
          executionController.abort();
          throw new Error(
            "Sandbox grep output exceeded 512KB transport limit",
          );
        }
        transportBytes += chunkBytes;
        if (chunk.stream === "stdout") stdout += chunk.text;
        else stderr += chunk.text;
      }
    } catch (error) {
      if (signal?.aborted) throw new Error("Operation aborted");
      throw error;
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
    }
    if (signal?.aborted) throw new Error("Operation aborted");

    let response: SandboxGrepResponse;
    try {
      response = JSON.parse(stdout.trim()) as SandboxGrepResponse;
    } catch {
      const reason = stderr.trim() || "sandbox grep returned invalid output";
      throw new Error(reason);
    }
    if (response.error) throw new Error(response.error);

    const details: {
      matchLimitReached?: number;
      linesTruncated?: boolean;
    } = {};
    if (response.matchLimitReached !== undefined) {
      details.matchLimitReached = response.matchLimitReached;
    }
    if (response.linesTruncated) details.linesTruncated = true;

    return {
      content: [{ type: "text", text: response.output ?? "No matches found" }],
      details: Object.keys(details).length > 0 ? details : undefined,
    };
  };
  return {
    ...native,
    // The executor API exposes a file tree, not gitignore semantics, and this
    // implementation does not apply Pi's byte/line truncators. Do not retain
    // native copy that promises behavior unavailable at this boundary.
    description:
      "Search sandbox file contents for a pattern. Returns matching lines " +
      "with file paths and line numbers, up to the requested limit " +
      "(default: 100 matches).",
    promptSnippet: "Search sandbox file contents for patterns",
    execute,
  };
}

/** Resolve a raw grep path into the path vocabulary understood by ToolExecutor. */
function resolveExecutorPath(searchPath = "."): string {
  if (searchPath.startsWith("/")) return toRelative(searchPath);
  return searchPath.replace(/^\.\//, "") || ".";
}

interface SandboxGrepResponse {
  output?: string;
  error?: string;
  matchLimitReached?: number;
  linesTruncated?: boolean;
}

/**
 * Defense in depth around a sandbox process that is expected to emit at most
 * 50KB of JSON. JSON escaping can expand that payload, so allow generous
 * framing headroom while still bounding Host memory if the process is faulty
 * or hostile.
 */
const MAX_SANDBOX_GREP_TRANSPORT_BYTES = 512 * 1024;

/**
 * Executed by isolated-mode `python3 -I -c` inside the ToolExecutor boundary.
 * Isolated mode prevents a Workspace file such as `json.py` from shadowing a
 * standard-library import. Regex evaluation, directory traversal, file reads,
 * and output truncation therefore consume disposable Sandbox resources rather
 * than the resident Host process.
 */
const SANDBOX_GREP_PROGRAM = String.raw`
import fnmatch
import json
import re
import sys
from pathlib import Path

MAX_LINE_CHARS = 500
MAX_OUTPUT_LINES = 2000
MAX_OUTPUT_BYTES = 50 * 1024

def truncate_line(value):
    if len(value) <= MAX_LINE_CHARS:
        return value, False
    return value[:MAX_LINE_CHARS] + "... [truncated]", True

def matches_glob(relative_path, name, pattern):
    if not pattern:
        return True
    target = relative_path if "/" in pattern else name
    if fnmatch.fnmatchcase(target, pattern):
        return True
    return pattern.startswith("**/") and fnmatch.fnmatchcase(
        relative_path, pattern[3:]
    )

def cap_output(lines):
    kept = []
    used = 0
    truncated = False
    for line in lines:
        encoded = line.encode("utf-8")
        extra = len(encoded) + (1 if kept else 0)
        if len(kept) >= MAX_OUTPUT_LINES or used + extra > MAX_OUTPUT_BYTES:
            truncated = True
            break
        kept.append(line)
        used += extra
    if truncated:
        notice = "[Output truncated at 2000 lines or 50KB]"
        notice_bytes = len(notice.encode("utf-8")) + (1 if kept else 0)
        while kept and used + notice_bytes > MAX_OUTPUT_BYTES:
            removed = kept.pop()
            used -= len(removed.encode("utf-8")) + (1 if kept else 0)
        kept.append(notice)
    return "\n".join(kept), truncated

try:
    config = json.loads(sys.argv[1])
    target = Path(config["path"])
    if not target.exists():
        raise FileNotFoundError(f"Path not found: {config['path']}")

    is_directory = target.is_dir()
    candidates = (
        sorted((path for path in target.rglob("*") if path.is_file()),
               key=lambda path: path.as_posix())
        if is_directory else [target]
    )
    flags = re.IGNORECASE if config["ignoreCase"] else 0
    source = re.escape(config["pattern"]) if config["literal"] else config["pattern"]
    expression = re.compile(source, flags)
    context = config["context"]
    limit = config["limit"]
    output = []
    matches = 0
    limit_reached = False
    lines_truncated = False

    for candidate in candidates:
        relative = (
            candidate.relative_to(target).as_posix()
            if is_directory else candidate.name
        )
        if not matches_glob(relative, candidate.name, config["glob"]):
            continue
        lines = candidate.read_text(encoding="utf-8", errors="replace").splitlines()
        for index, line in enumerate(lines):
            if expression.search(line) is None:
                continue
            matches += 1
            first = max(0, index - context)
            last = min(len(lines) - 1, index + context)
            for context_index in range(first, last + 1):
                rendered, was_truncated = truncate_line(lines[context_index])
                lines_truncated = lines_truncated or was_truncated
                separator = ":" if context_index == index else "-"
                output.append(
                    f"{relative}{separator}{context_index + 1}{separator} {rendered}"
                )
            if matches >= limit:
                limit_reached = True
                break
        if limit_reached:
            break

    if not output:
        output.append("No matches found")
    if limit_reached:
        output.extend([
            "",
            f"[{limit} matches limit reached. Use limit={limit * 2} for more, or refine pattern]",
        ])
    if lines_truncated:
        output.extend(["", "[Some lines truncated to 500 characters]"])
    rendered, output_truncated = cap_output(output)
    print(json.dumps({
        "output": rendered,
        "matchLimitReached": limit if limit_reached else None,
        "linesTruncated": lines_truncated,
        "outputTruncated": output_truncated,
    }, ensure_ascii=False))
except Exception as error:
    print(json.dumps({"error": str(error)}, ensure_ascii=False))
`;

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
