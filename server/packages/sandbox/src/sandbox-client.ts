export const SANDBOX_RUNNING_SECONDS = 24 * 60 * 60;
export const SANDBOX_IDLE_SECONDS = 30 * 60;

/**
 * The gateway's real bound on a claim, including the waits for a claim worker
 * and for readiness. Every creation budget derives from it (ADR-0023). The
 * Runner calls the gateway in-cluster, so no ALB or proxy bounds them.
 *
 * wait-ready 135 s < claim 150 s < create request 170 s < intent deadline 180 s:
 * - wait-ready runs inside the claim and leaves it time for init and mount;
 * - the create request outwaits the claim, so the creator normally learns the
 *   outcome itself instead of timing out;
 * - the deadline outwaits the create request, and a client abort cancels the
 *   gateway's claim, so after the deadline no create of that attempt is still
 *   in flight;
 * - the create request stays under the SDK HTTP client's 300 s header timeout,
 *   which would otherwise end it first.
 */
export const CLAIM_SECONDS = 150;
/** The readiness wait inside the claim. */
export const WAIT_READY_SECONDS = CLAIM_SECONDS - 15;
/** Client timeout of the create request. */
export const CREATE_REQUEST_MS = (CLAIM_SECONDS + 20) * 1000;
/** Counted from the committed creation intent; after it, no create of that attempt is in flight. */
export const INTENT_DEADLINE_SECONDS = CLAIM_SECONDS + 30;

/** When the creation intent committed at `creatingSince`, by the database clock, reaches its deadline (epoch ms). */
export function intentExpiresAt(creatingSince: Date, deadlineSeconds = INTENT_DEADLINE_SECONDS): number {
  return creatingSince.getTime() + deadlineSeconds * 1000;
}

/** Whether the creation intent committed at `creatingSince` is past its deadline at `now`, both by the database clock. */
export function intentExpired(creatingSince: Date, now: Date, deadlineSeconds = INTENT_DEADLINE_SECONDS): boolean {
  return now.getTime() >= intentExpiresAt(creatingSince, deadlineSeconds);
}

import type { WorkspaceMountTarget } from "./workspace-mount.js";

/**
 * Low-level port over a disposable E2B sandbox. Workspace files reside in the
 * identity-scoped OSS mount; local HOME and installed Skills are disposable.
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
   * Command timeout in seconds; expiry attempts process cleanup, while onExit
   * reports observed termination. `0` means **disable the timeout**
   * (mirrors the e2b SDK's `timeoutMs: 0`), distinct from `undefined` = backend
   * default (issue #81).
   */
  timeoutSeconds?: number;
  /** Extra environment variables layered onto the command. */
  env?: Record<string, string>;
  /** Run as root instead of the Sandbox's ordinary user (the Skill Install). */
  user?: "root";
  /**
   * Written to the command's stdin once it has started. Never part of argv,
   * env or any log. Stdin is not closed afterwards (the Sandbox's envd cannot
   * close it), so the command must not wait for EOF.
   */
  stdin?: string;
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

/**
 * The create metadata key the gateway claims a Warm Pool Sandbox with,
 * naming the image it runs (ADR-0024).
 */
export const CLAIM_IMAGE_METADATA = "e2b.agents.kruise.io/image";

/**
 * Whether `image` names one image by digest: `<repository>@sha256:<64 hex>`,
 * with no tag. The Warm Pool compares the claim's image with its own as
 * strings, so a Sandbox claimed with the pool's exact reference keeps its
 * container (ADR-0024).
 */
export function isDigestPinnedImage(image: string | undefined): image is string {
  return image !== undefined
    && /^(?:[A-Za-z0-9.-]+(?::\d+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/.test(image);
}

/** Options for creating a sandbox. */
export interface SandboxCreateOptions {
  /**
   * The image the Sandbox runs, pinned by digest (see
   * {@link isDigestPinnedImage}). A backend with a Warm Pool claims a warm
   * Sandbox and, unless the pool runs this exact image, swaps its container
   * to it in place (ADR-0024).
   */
  image: string;
  /** Environment variables baked into the sandbox runtime. */
  env?: Record<string, string>;
  /** Free-form labels/metadata (e.g. sessionId, workspaceId) for tracing. */
  metadata?: Record<string, string>;
  /** Overall sandbox lifetime cap in seconds. */
  timeoutSeconds?: number;
}

/**
 * A create the gateway answered with an HTTP error status. Only the status is
 * kept: the answer's body can carry provider diagnostics and credentials
 * (#260). A create that failed without an answer (a timeout, a lost
 * connection) rejects with any other error.
 */
export class SandboxCreateRejected extends Error {
  constructor(readonly status: number) {
    super(`Sandbox create answered HTTP ${status}`);
    this.name = "SandboxCreateRejected";
  }
}

/**
 * A handle to one live sandbox. The `id` is backend-specific (the e2b
 * `sandboxId`); everything else is done through the client keyed by it.
 */
export interface SandboxHandle {
  id: string;
  /** How the create claimed the Sandbox from the Warm Pool; absent for a backend without one. */
  claim?: SandboxClaim;
}

/** A Warm Pool claim (ADR-0024), as `span.sandbox_prepare_end` records it. */
export interface SandboxClaim {
  /** The image digest the Sandbox was claimed with. */
  image: string;
  /**
   * Whether the claim replaced the warm Sandbox's container with `image` in
   * place; false for a plain claim of the pool's own image and for a cold
   * start. Absent when it could not be observed.
   */
  swapped?: boolean;
  /** How long the gateway's create (the claim, including any swap) took. */
  claimMs: number;
}

/** One Sandbox as the gateway's list (`GET /v2/sandboxes`) returns it. */
export interface ListedSandbox {
  sandboxId: string;
  state: "running" | "paused";
  /** Includes annotations that can hold credentials (#260): never log it. */
  metadata: Record<string, string>;
  /** When the Sandbox was claimed. */
  startedAt: Date;
  /**
   * The platform deadline: pause for a running Sandbox, deletion for a paused
   * one. null when the Sandbox has none; `setTimeout` is then a no-op.
   */
  endAt: Date | null;
}

/** Which Sandboxes {@link SandboxClient.listSandboxes} returns. */
export interface SandboxListFilter {
  /** Every one of these labels, with exactly these values; none lists every Sandbox of the API key. */
  metadata: Record<string, string>;
  states: ReadonlyArray<ListedSandbox["state"]>;
}

/** One entry of the gateway's `GET /v2/sandboxes` body. */
export interface GatewayListEntry {
  sandboxID: string;
  state: string;
  metadata?: Record<string, string> | null;
  startedAt: string;
  endAt: string;
}

/**
 * A listed Sandbox from its gateway entry; undefined in a state other than
 * running or paused. The gateway reports "no deadline" as Go's zero time,
 * 0001-01-01T00:00:00Z, which becomes null.
 */
export function listedSandbox(entry: GatewayListEntry): ListedSandbox | undefined {
  if (entry.state !== "running" && entry.state !== "paused") return undefined;
  const endAt = entry.endAt ? Date.parse(entry.endAt) : Number.NaN;
  return {
    sandboxId: entry.sandboxID, state: entry.state, metadata: entry.metadata ?? {},
    startedAt: new Date(entry.startedAt), endAt: Number.isNaN(endAt) || endAt <= 0 ? null : new Date(endAt),
  };
}

/**
 * Low-level sandbox lifecycle + file/exec port. Production uses the E2B SDK; a fake implements the same surface in-memory for tests.
 */
export interface SandboxClient {
  /** Transport loss is not an observed remote process exit. */
  hasUncertainExecution(id: string): boolean;
  resetExecutionUncertainty(id: string): void;
  /** Read-only control-plane state; unknown transport errors must throw. */
  state(id: string): Promise<"running" | "paused" | "missing">;
  setTimeout(id: string, seconds: number): Promise<void>;
  /**
   * Native I/O primitives at absolute sandbox paths, separate from persistence.
   * An operation rejects with its caller's AbortError only before it starts or
   * once its outcome is known; one that ends without an outcome is recorded as
   * uncertain execution.
   */
  fileSystem?(id: string): ToolFileSystem;

  /**
   * Create (schedule) a sandbox and resolve once it is ready to accept ops.
   * Rejects with {@link SandboxCreateRejected} when the gateway answered
   * with an error status.
   */
  create(opts?: SandboxCreateOptions): Promise<SandboxHandle>;
  /** Attach a Host to a persisted, trusted Sandbox identity without creating it. */
  reconnect(id: string, metadata: Record<string, string>): Promise<boolean>;
  /**
   * Every Sandbox the gateway lists for this API key that matches `filter`,
   * across all pages: how a binding is reconciled with what exists
   * (ADR-0023). The gateway filters exactly, from its cache.
   */
  listSandboxes(filter: SandboxListFilter): Promise<ListedSandbox[]>;

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

  /** List recursively; missingOk returns empty only when the root is confirmed ENOENT. */
  list(id: string, dir: string, options?: { missingOk?: boolean }): Promise<SandboxFileEntry[]>;

  /**
   * Tear the sandbox down; resolves only once the gateway confirms it missing.
   * Idempotent — destroying twice is a no-op.
   */
  destroy(id: string): Promise<void>;
}
