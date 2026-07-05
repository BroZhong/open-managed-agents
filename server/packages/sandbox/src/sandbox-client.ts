/**
 * SandboxClient — the low-level port over a single disposable sandbox.
 *
 * Per ADR-0002 §4, the sandbox backend is the official `e2b` SDK against a
 * self-hosted gateway (#53, replacing the kruise CRD; NOT
 * `@alibaba-group/opensandbox`). Sandboxes are short-lived and hold no
 * authoritative state: created lazily, hydrated from S3, and destroyed at
 * session end — there is no pause/resume, because that model is 1:1
 * per-instance and conflicts with 1:N Workspace sharing.
 *
 * This port is deliberately small (`create/exec/readFile/writeFile/list/
 * destroy`) so it can be backed by e2b in production and by a fake in tests,
 * and so the {@link SandboxToolExecutor} above it never learns which backend it
 * is talking to.
 */

/** A chunk of output from a running command inside the sandbox. */
export interface SandboxExecChunk {
  stream: "stdout" | "stderr";
  text: string;
}

/** Options for a single sandbox `exec` invocation. */
export interface SandboxExecOptions {
  /** Working directory for the command (absolute path inside the sandbox). */
  cwd?: string;
  /** Kill the command after this many seconds. */
  timeoutSeconds?: number;
  /** Extra environment variables layered onto the command. */
  env?: Record<string, string>;
}

/** A file entry returned by {@link SandboxClient.list}. */
export interface SandboxFileEntry {
  /** Absolute path inside the sandbox. */
  path: string;
  size: number;
  mtimeMs: number;
}

/** Options for creating a sandbox. */
export interface SandboxCreateOptions {
  /** Container image / e2b template the sandbox runtime should use. */
  image?: string;
  /** Environment variables baked into the sandbox runtime. */
  env?: Record<string, string>;
  /** Free-form labels/metadata (e.g. sessionId, workspaceId) for tracing. */
  metadata?: Record<string, string>;
  /** Overall sandbox lifetime cap in seconds. */
  timeoutSeconds?: number;
}

/**
 * A handle to one live sandbox. The `id` is backend-specific (the e2b
 * `sandboxId`); everything else is done through the client keyed by it.
 */
export interface SandboxHandle {
  id: string;
}

/**
 * Low-level sandbox lifecycle + file/exec port. One implementation targets the
 * kruise CRD; a fake implements the same surface in-memory for tests.
 */
export interface SandboxClient {
  /** Create (schedule) a sandbox and resolve once it is ready to accept ops. */
  create(opts?: SandboxCreateOptions): Promise<SandboxHandle>;

  /** Run a command (argv form — no shell parsing implied) and stream output. */
  exec(
    id: string,
    command: string[],
    opts?: SandboxExecOptions,
  ): AsyncIterable<SandboxExecChunk>;

  /** Read a UTF-8 file at an absolute path inside the sandbox. */
  readFile(id: string, path: string): Promise<string>;

  /** Write a UTF-8 file, creating parent directories as needed. */
  writeFile(id: string, path: string, content: string): Promise<void>;

  /** List files under an absolute directory (recursively). */
  list(id: string, dir: string): Promise<SandboxFileEntry[]>;

  /**
   * True when the sandbox `id` is still live and able to accept ops. Because
   * sandboxes are reclaimed by the gateway after their lifetime (ADR-0002 §4),
   * a memoized handle can go stale between turns; the executor calls this before
   * a tool op and rebuilds when it returns false. An unknown id (never created,
   * already destroyed) is not alive.
   */
  isAlive(id: string): Promise<boolean>;

  /** Tear the sandbox down. Idempotent — destroying twice is a no-op. */
  destroy(id: string): Promise<void>;
}
