import type { WorkspaceMountTarget } from "./workspace-mount.js";

/**
 * Low-level port over a disposable E2B sandbox. Workspace files reside in the
 * identity-scoped OSS mount; local HOME and Skill projections are disposable.
 */

import type { ToolFileSystem } from "@open-managed-agents/adapter-core";

/** A chunk of output from a running command inside the sandbox. */
export interface SandboxExecChunk {
  stream: "stdout" | "stderr";
  text: string;
  bytes?: Uint8Array;
}

/** Options for a single sandbox `exec` invocation. */
export interface SandboxExecOptions {
  /** Working directory for the command (absolute path inside the sandbox). */
  cwd?: string;
  /**
   * Kill the command after this many seconds. `0` means **disable the timeout**
   * (mirrors the e2b SDK's `timeoutMs: 0`), distinct from `undefined` = backend
   * default (issue #81).
   */
  timeoutSeconds?: number;
  /** Extra environment variables layered onto the command. */
  env?: Record<string, string>;
  /**
   * Abort the running process, not just the transport receiving its output.
   */
  signal?: AbortSignal;
  /**
   * Called once on an observed process exit, before the iterable completes.
   * Startup/transport failures without an exit result do not call this hook.
   */
  onExit?: (result: { exitCode: number | null; signal?: string }) => void;
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
 * Low-level sandbox lifecycle + file/exec port. Production uses the E2B SDK; a fake implements the same surface in-memory for tests.
 */
export interface SandboxClient {
  /** Native I/O primitives at absolute sandbox paths, separate from persistence. */
  fileSystem?(id: string): ToolFileSystem;

  /** Create (schedule) a sandbox and resolve once it is ready to accept ops. */
  create(opts?: SandboxCreateOptions): Promise<SandboxHandle>;
  /** Attach a Host to a persisted, trusted Sandbox identity without creating it. */
  reconnect?(id: string, metadata: Record<string, string>): Promise<boolean>;

  /** Verify the real OSS mount, exact prefix and ordinary-user read/write access. */
  verifyWorkspaceMount(id: string, target: WorkspaceMountTarget): Promise<void>;

  /** Run a command (argv form — no shell parsing implied) and stream output. */
  exec(
    id: string,
    command: string[],
    opts?: SandboxExecOptions,
  ): AsyncIterable<SandboxExecChunk>;

  /** Read a UTF-8 file at an absolute path inside the sandbox. */
  readFile(id: string, path: string): Promise<string>;

  /** Read exact file bytes without UTF-8 decoding (including binary Workspace files). */
  readFileBytes(id: string, path: string): Promise<Uint8Array>;

  /** Write a UTF-8 file, creating parent directories as needed. */
  writeFile(id: string, path: string, content: string): Promise<void>;

  /** Write exact file bytes, creating parent directories as needed. */
  writeFileBytes(id: string, path: string, content: Uint8Array): Promise<void>;

  /** Remove a file or directory tree. Missing paths are an idempotent no-op. */
  remove(id: string, path: string): Promise<void>;

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

export interface SandboxFsAccess {
  /** Write a UTF-8 file at an absolute sandbox path, creating parents. */
  writeFile(path: string, content: string): Promise<void>;
  /** Read a UTF-8 file at an absolute sandbox path. */
  readFile(path: string): Promise<string>;
  /** Write exact bytes at an absolute sandbox path, creating parents. */
  writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  /** Read exact bytes at an absolute sandbox path. */
  readFileBytes(path: string): Promise<Uint8Array>;
  /** Remove a file or directory tree. Missing paths are an idempotent no-op. */
  remove(path: string): Promise<void>;
  /** List files under an absolute sandbox directory (recursively). */
  list(dir: string): Promise<SandboxFileEntry[]>;
}
