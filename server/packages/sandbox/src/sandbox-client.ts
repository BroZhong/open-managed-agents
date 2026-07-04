/**
 * SandboxClient — the low-level port over a single disposable sandbox.
 *
 * Per ADR-0002 §4 and the #37 spike, the sandbox backend is the OpenKruise
 * `agents.kruise.io` CRD (NOT `@alibaba-group/opensandbox`). Sandboxes are
 * short-lived and hold no authoritative state: created lazily, hydrated from
 * S3, and destroyed at session end — there is no pause/resume, because that
 * model is 1:1 per-instance and conflicts with 1:N Workspace sharing.
 *
 * This port is deliberately small (`create/exec/readFile/writeFile/list/
 * destroy`) so it can be backed by the kruise CRD in production and by a fake
 * in tests, and so the {@link SandboxToolExecutor} above it never learns which
 * backend it is talking to.
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
  /** Container image / kruise template the sandbox runtime should use. */
  image?: string;
  /** Environment variables baked into the sandbox runtime. */
  env?: Record<string, string>;
  /** Free-form labels/metadata (e.g. sessionId, workspaceId) for tracing. */
  metadata?: Record<string, string>;
  /** Overall sandbox lifetime cap in seconds. */
  timeoutSeconds?: number;
}

/**
 * A handle to one live sandbox. The `id` is backend-specific (the kruise
 * Sandbox CR name); everything else is done through the client keyed by it.
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

  /** Tear the sandbox down. Idempotent — destroying twice is a no-op. */
  destroy(id: string): Promise<void>;
}
