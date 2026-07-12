/**
 * ToolExecutor — the single seam between the pure Adapter and all
 * infrastructure (sandbox, S3, PostgreSQL, Redis).
 *
 * Per ADR-0002 §2, this is injected as a **per-`run()`-call parameter**
 * (carried on `AdapterInput.toolExecutor`), never as Adapter constructor
 * state and never as a shared mutable registry. The Adapter knows only
 * this abstract executor — it does not know a sandbox (or anything else)
 * exists. Per-call injection is what makes true per-agent concurrency safe
 * (the FastClaw shared-registry hazard we are explicitly avoiding).
 *
 * Concrete implementations:
 *  - in-process / local executor over a per-call temp dir (#39, verifies the
 *    seam before the real sandbox lands)
 *  - sandbox-backed executor that hydrates from / syncs to an S3 Workspace and
 *    proxies into a kruise Sandbox (#42/#43)
 */

/** A chunk of output from a running command. */
export interface ExecOutputChunk {
  stream: "stdout" | "stderr";
  text: string;
}

/**
 * Canonical model-visible root of a sandboxed Agent's writable Workspace.
 *
 * Pi's custom tools, Pi session context, and the concrete SandboxManager must
 * agree on this exact path. Keeping it beside the ToolExecutor contract avoids
 * a split-brain cwd where path tools are virtualized under one root while bash
 * and extensions (including subagents) inherit another.
 */
export const SANDBOX_WORKSPACE_ROOT = "/home/user";

/** Options for a single `exec` invocation. */
export interface ExecOptions {
  /** Working directory for the command, relative to the executor root. */
  cwd?: string;
  /**
   * Kill the command after this many seconds. `0` means **disable the timeout**
   * (run with no deadline — mirrors the e2b SDK's `timeoutMs: 0`); this is
   * distinct from `undefined`, which lets the backend apply its own default
   * (issue #81).
   */
  timeoutSeconds?: number;
  /** Extra environment variables to layer onto the command. */
  env?: Record<string, string>;
  /**
   * The turn's abort signal (issue #84). Passed straight through to the backend
   * so a hung command is cancelled when the router aborts the turn — a pure
   * passthrough of the runtime's native cancel, not a separate watchdog.
   */
  signal?: AbortSignal;
}

/** An entry returned by `list`. */
export interface FileListEntry {
  /** Path relative to the executor root, using POSIX separators. */
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Abstract, infrastructure-free file + command executor.
 *
 * All paths are interpreted relative to the executor's own root; an
 * implementation MUST NOT let a path escape that root. Nothing here references
 * a sandbox, S3, a database, or any concrete backend — that is the point.
 */
export interface ToolExecutor {
  /**
   * Run a command (argv form — no shell parsing implied) and stream its
   * output. The returned iterable completes when the process exits.
   */
  exec(command: string[], opts?: ExecOptions): AsyncIterable<ExecOutputChunk>;

  /** Read a UTF-8 file. Rejects if the file does not exist. */
  readFile(path: string): Promise<string>;

  /** Write a UTF-8 file, creating parent directories as needed. */
  writeFile(path: string, content: string): Promise<void>;

  /**
   * List files. With no argument, lists the full tree. With a directory or
   * glob, lists matching entries. Directories themselves are not returned.
   */
  list(globOrDir?: string): Promise<FileListEntry[]>;
}
