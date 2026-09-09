import { Sandbox } from "e2b";
import { ExecAbortedBeforeStartError, SANDBOX_WORKSPACE_ROOT } from "@open-managed-agents/adapter-core";
import type { ToolFileSystem } from "@open-managed-agents/adapter-core";
import { createSandboxFileSystem } from "./sandbox-file-system.js";
import type {
  SandboxClient,
  SandboxCreateOptions,
  SandboxExecChunk,
  SandboxExecOptions,
  SandboxFileEntry,
  SandboxHandle,
} from "./sandbox-client.js";

export interface E2BCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface E2BCommandHandle {
  wait(): Promise<E2BCommandResult>;
  kill(): Promise<boolean>;
  disconnect(): Promise<void>;
}

export interface E2BCommandOptions {
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (data: string) => void | Promise<void>;
  onStderr?: (data: string) => void | Promise<void>;
  onStdoutBytes?: (data: Uint8Array) => void | Promise<void>;
  onStderrBytes?: (data: Uint8Array) => void | Promise<void>;
}

/**
 * The slice of the e2b `Sandbox` instance this client actually uses. Kept
 * structural so tests can pass a hand-rolled fake without dragging in the whole
 * SDK surface.
 */
export interface E2BSandbox {
  readonly sandboxId: string;
  commands: {
    run(cmd: string, opts?: E2BCommandOptions & { background?: false }): Promise<E2BCommandResult>;
    run(cmd: string, opts: E2BCommandOptions & { background: true }): Promise<E2BCommandHandle>;
  };
  files: {
    read(path: string, opts?: { format?: "text" }): Promise<string>;
    read(path: string, opts: { format: "bytes" }): Promise<Uint8Array>;
    write(path: string, data: string | ArrayBuffer): Promise<unknown>;
    remove(path: string): Promise<void>;
  };
  /** True while the gateway still has this sandbox running (not reclaimed). */
  isRunning(): Promise<boolean>;
  kill(): Promise<void>;
}

/**
 * Factory seam over `Sandbox.create`. Tests inject a fake here so no network is
 * touched; production defaults to the real e2b SDK.
 */
export type CreateSandboxFn = (
  template: string,
  opts: {
    apiKey: string;
    domain: string;
    metadata?: Record<string, string>;
    envs?: Record<string, string>;
    timeoutMs?: number;
  },
) => Promise<E2BSandbox>;

const DEFAULT_TEMPLATE = "auto-story";
// E2B's recommended user directory — the exec `user`'s own home, so it exists
// and is writable without a chown. Mkdir'ing the old root-owned `/workspace` as
// the non-privileged user failed silently (issue #85); `/home/user` sidesteps
// that entirely. This is the create-time existence guard only; the effective
// cwd is chosen by SandboxManager (EnvSpec.workspaceDir), which defaults here.
const DEFAULT_WORKSPACE_DIR = SANDBOX_WORKSPACE_ROOT;

export interface E2BSandboxClientOptions {
  /** E2B domain (e.g. "sandbox.agentry.welltop.tech"); SDK resolves api.<domain>. */
  domain: string;
  /** Gateway API key. */
  apiKey: string;
  /** Template (SandboxSet name) used when a create call omits an image. */
  defaultTemplate?: string;
  /**
   * Injectable sandbox factory. Defaults to the real `Sandbox.create`. Tests
   * pass a fake so the client can be exercised with no network.
   */
  createSandbox?: CreateSandboxFn;
}

/**
 * e2b-SDK-backed {@link SandboxClient}.
 *
 * Replaces the abandoned kruise-CRD client (#53). Sandboxes are created via the
 * official `e2b` Node SDK against a self-hosted gateway (domain + apiKey are
 * injected, never hardcoded). The `image` create option maps to an e2b
 * template (the SandboxSet name); when omitted, {@link defaultTemplate} is used.
 *
 * `exec` shell-quotes argv for the SDK's `bash -lc` wrapper (honouring cwd/env),
 * replaces that shell with the command, streams stdout/stderr, and reports a
 * non-zero exit is reported through `onExit`, while stdout/stderr retain their
 * original streaming surface for existing consumers.
 */
export class E2BSandboxClient implements SandboxClient {
  private readonly domain: string;
  private readonly apiKey: string;
  private readonly defaultTemplate: string;
  private readonly createSandbox: CreateSandboxFn;
  /** id -> live sandbox handle, so subsequent ops resolve the instance. */
  private readonly sandboxes = new Map<string, E2BSandbox>();
  private readonly fileSystems = new Map<string, ToolFileSystem>();

  fileSystem(id: string): ToolFileSystem {
    this.require(id);
    let fileSystem = this.fileSystems.get(id);
    if (!fileSystem) {
      fileSystem = createSandboxFileSystem({
        exec: (command, options) => this.exec(id, command, options),
        writeFileBytes: (path, content) => this.writeFileBytes(id, path, content),
        remove: (path) => this.remove(id, path),
      });
      this.fileSystems.set(id, fileSystem);
    }
    return fileSystem;
  }

  constructor(opts: E2BSandboxClientOptions) {
    if (!opts.domain) throw new Error("E2BSandboxClient requires a domain");
    if (!opts.apiKey) throw new Error("E2BSandboxClient requires an apiKey");
    this.domain = opts.domain;
    this.apiKey = opts.apiKey;
    this.defaultTemplate = opts.defaultTemplate ?? DEFAULT_TEMPLATE;
    this.createSandbox = opts.createSandbox ?? defaultCreateSandbox;
  }

  async create(opts: SandboxCreateOptions = {}): Promise<SandboxHandle> {
    const template = resolveTemplate(opts.image, this.defaultTemplate);
    const sandbox = await this.createSandbox(template, {
      apiKey: this.apiKey,
      domain: this.domain,
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
      ...(opts.env ? { envs: opts.env } : {}),
      // `!= null` so an explicit `0` maps to `timeoutMs: 0` (e2b's disable
      // convention) rather than being dropped as falsy; `undefined` omits it and
      // e2b applies its own default lifetime (issue #81).
      ...(opts.timeoutSeconds != null
        ? { timeoutMs: opts.timeoutSeconds * 1000 }
        : {}),
    });
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    // Ensure the workspace dir exists before hydrate/exec.
    await this.drain(
      this.exec(sandbox.sandboxId, ["mkdir", "-p", DEFAULT_WORKSPACE_DIR]),
    );
    return { id: sandbox.sandboxId };
  }

  async *exec(
    id: string,
    command: string[],
    opts?: SandboxExecOptions,
  ): AsyncIterable<SandboxExecChunk> {
    if (command.length === 0) {
      throw new Error("exec requires a non-empty command");
    }
    const sandbox = this.require(id);
    const cmd = wrapCommand(command, opts);
    yield* streamRun(sandbox, cmd, {
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(opts?.env ? { envs: opts.env } : {}),
      // `!= null` (not truthiness) so `timeoutSeconds: 0` — the disable-timeout
      // convention (issue #81) — reaches the SDK as `timeoutMs: 0`, which e2b
      // treats as "no timeout". Dropping it as falsy would silently re-enable
      // the backend default. `undefined` omits the field → backend default.
      ...(opts?.timeoutSeconds != null
        ? { timeoutMs: opts.timeoutSeconds * 1000 }
        : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.onExit ? { onExit: opts.onExit } : {}),
    });
  }

  async readFile(id: string, path: string): Promise<string> {
    const sandbox = this.require(id);
    return sandbox.files.read(path, { format: "text" });
  }

  async readFileBytes(id: string, path: string): Promise<Uint8Array> {
    const sandbox = this.require(id);
    return sandbox.files.read(path, { format: "bytes" });
  }

  async writeFile(id: string, path: string, content: string): Promise<void> {
    const sandbox = this.require(id);
    // The e2b SDK creates parent directories automatically on write.
    await sandbox.files.write(path, content);
  }

  async writeFileBytes(
    id: string,
    path: string,
    content: Uint8Array,
  ): Promise<void> {
    const sandbox = this.require(id);
    // Copy into an owned ArrayBuffer: a Uint8Array may be a view with a
    // non-zero offset, while the SDK accepts the whole ArrayBuffer.
    const copy = new Uint8Array(content);
    await sandbox.files.write(path, copy.buffer);
  }

  async remove(id: string, path: string): Promise<void> {
    const sandbox = this.require(id);
    try {
      await sandbox.files.remove(path);
    } catch (error) {
      // Downward reconciliation is idempotent. A concurrent/missing delete is
      // already the desired state; preserve all other backend failures.
      if (!isMissingFileError(error)) throw error;
    }
  }

  async list(id: string, dir: string): Promise<SandboxFileEntry[]> {
    const sandbox = this.require(id);
    // `find` prints: <mtime-epoch-seconds> <size-bytes> <path>, one per file.
    // We use it (rather than the SDK's `files.list`) so size + mtime are always
    // present and the listing is fully recursive, matching the old client and
    // keeping the executor's sync logic working.
    const res = await sandbox.commands.run(
      `find ${shellQuote(dir)} -type f -printf '%T@ %s %p\\n' 2>/dev/null || true`,
    );
    return parseFindOutput(res.stdout);
  }

  async isAlive(id: string): Promise<boolean> {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) return false; // never created here, or already destroyed.
    try {
      return await sandbox.isRunning();
    } catch {
      // A transport/not-found error means the gateway no longer has it live.
      return false;
    }
  }

  async destroy(id: string): Promise<void> {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) return; // already gone — idempotent.
    this.sandboxes.delete(id);
    this.fileSystems.delete(id);
    try {
      await sandbox.kill();
    } catch {
      // Swallow not-found / already-killed; destroy is idempotent.
    }
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private require(id: string): E2BSandbox {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) {
      throw new Error(`No live sandbox for ${id} (create it first)`);
    }
    return sandbox;
  }

  private async drain(it: AsyncIterable<SandboxExecChunk>): Promise<void> {
    for await (const _chunk of it) {
      // discard
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Resolve the E2B template (SandboxSet name) for a create call.
 *
 * For the E2B backend `image` is a bare template *name* — NOT a container
 * image reference. Older Agents (and the pre-#54 UI) persisted a container
 * image string like `open-managed-agents/sandbox:latest` in `sandbox.image`;
 * passing that as a template would 400 with "Template or Checkpoint not found".
 * So we only honour a value that looks like a bare template name and otherwise
 * fall back to the default template.
 */
export function resolveTemplate(
  image: string | undefined,
  defaultTemplate: string,
): string {
  if (!image) return defaultTemplate;
  // A registry path (`/`) or a tag (`:`) marks a container-image reference,
  // which is not a valid E2B template name — ignore it and use the default.
  if (image.includes("/") || image.includes(":")) return defaultTemplate;
  return image;
}

/**
 * Run a command via the e2b SDK, bridging its `onStdout`/`onStderr` callbacks
 * into the output iterable. Hold the background process handle so cancellation
 * sends SIGKILL; aborting the SDK request alone only disconnects the stream.
 */
async function* streamRun(
  sandbox: E2BSandbox,
  cmd: string,
  opts: {
    cwd?: string;
    envs?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    onExit?: SandboxExecOptions["onExit"];
  },
): AsyncIterable<SandboxExecChunk> {
  const queue: SandboxExecChunk[] = [];
  let resolveNext: (() => void) | undefined;
  let done = false;
  let error: Error | undefined;
  let handle: E2BCommandHandle | undefined;
  let killPromise: Promise<void> | undefined;
  let killError: Error | undefined;
  let reportKillFailure!: (outcome: { reason: unknown }) => void;
  const killFailure = new Promise<{ reason: unknown }>((resolve) => {
    reportKillFailure = resolve;
  });
  let killed = false;
  let cancelRequested = false;
  let exitResult: Parameters<NonNullable<SandboxExecOptions["onExit"]>>[0] | undefined;
  let exitReported = false;
  const reportExit = () => {
    if (!exitReported && exitResult) {
      exitReported = true;
      opts.onExit?.(exitResult);
    }
  };
  const cancel = () => {
    if (done) return;
    cancelRequested = true;
    if (!handle || killPromise) return;
    // Do not pass the aborted turn signal to the kill request. Its transport
    // must remain usable until the remote process has actually stopped.
    killPromise = handle.kill().then(
      (didKill) => { killed = didKill; },
      (reason: unknown) => {
        killError = reason instanceof Error ? reason : new Error(String(reason));
        reportKillFailure({ reason: killError });
      },
    );
  };
  const wake = () => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = undefined;
      r();
    }
  };
  const push = (stream: "stdout" | "stderr") => (data: string) => {
    // The patched SDK invokes its raw callback before the legacy text callback.
    // Test/legacy transports that only provide text still retain their surface.
    if (rawStreams.has(stream)) return;
    queue.push({ stream, text: data });
    wake();
  };
  const rawStreams = new Set<"stdout" | "stderr">();
  const decoders = {
    stdout: new TextDecoder("utf-8", { ignoreBOM: true }),
    stderr: new TextDecoder("utf-8", { ignoreBOM: true }),
  };
  const pushBytes = (stream: "stdout" | "stderr") => (data: Uint8Array) => {
    rawStreams.add(stream);
    const bytes = new Uint8Array(data);
    queue.push({ stream, bytes, text: decoders[stream].decode(bytes, { stream: true }) });
    wake();
  };

  if (opts.signal?.aborted) throw new ExecAbortedBeforeStartError();
  opts.signal?.addEventListener("abort", cancel, { once: true });
  const completion = (async () => {
    try {
      // Keep startup observable even if cancellation races with process
      // creation. Once its PID/handle arrives, cancel() can reliably kill it.
      const { signal: _signal, onExit: _onExit, ...runOptions } = opts;
      handle = await sandbox.commands.run(cmd, {
        ...runOptions,
        background: true,
        onStdout: push("stdout"),
        onStderr: push("stderr"),
        onStdoutBytes: pushBytes("stdout"),
        onStderrBytes: pushBytes("stderr"),
      });
      // Attach both handlers before killing; a fast SIGKILL must not produce
      // an unhandled rejection while the kill RPC is still pending.
      const waiting = handle.wait().then(
        (result) => ({ result }),
        (reason: unknown) => ({ reason }),
      );
      if (cancelRequested) cancel();
      const outcome = await Promise.race([waiting, killFailure]);
      await killPromise;
      if (killError) throw killError;
      if (cancelRequested && killed) {
        exitResult = { exitCode: null, signal: "SIGKILL" };
        error = new DOMException("Command aborted", "AbortError");
      } else if ("result" in outcome) {
        exitResult = { exitCode: outcome.result.exitCode };
      } else if (isCommandExitError(outcome.reason)) {
        exitResult = { exitCode: outcome.reason.exitCode };
      } else {
        throw outcome.reason;
      }
    } catch (reason) {
      error = reason instanceof Error ? reason : new Error(String(reason));
      if (handle) {
        // A lost stream is not evidence that its process stopped. Attempt
        // cleanup, then close the subscription without inventing an exit code.
        if (!killPromise) {
          try { await handle.kill(); } catch { /* Preserve the original error. */ }
        }
        try { await handle.disconnect(); } catch { /* Preserve the original error. */ }
      }
    } finally {
      if (exitResult) {
        for (const stream of rawStreams) {
          const text = decoders[stream].decode();
          if (text) queue.push({ stream, text, bytes: new Uint8Array() });
        }
      }
      done = true;
      wake();
    }
  })();

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) {
        reportExit();
        if (error) throw error;
        return;
      }
      await new Promise<void>((r) => { resolveNext = r; });
    }
  } finally {
    opts.signal?.removeEventListener("abort", cancel);
    if (!done) cancel();
    await completion;
    reportExit();
  }
}

/** A non-zero exit surfaces as an object carrying a numeric `exitCode`. */
function isCommandExitError(e: unknown): e is { exitCode: number } {
  return (
    typeof e === "object" &&
    e !== null &&
    "exitCode" in e &&
    typeof (e as { exitCode: unknown }).exitCode === "number"
  );
}

function isMissingFileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not[ -]?found|no such file|404/i.test(message);
}

/**
 * Quote argv for the SDK's shell, honouring cwd + env and replacing the shell
 * with the executable so the SDK process handle can terminate it reliably.
 */
export function wrapCommand(
  command: string[],
  opts?: SandboxExecOptions,
): string {
  const parts: string[] = [];
  if (opts?.cwd) {
    parts.push(`cd ${shellQuote(opts.cwd)}`);
  }
  const envPrefix = opts?.env
    ? Object.entries(opts.env)
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(" ")
    : "";
  const cmd = command.map(shellQuote).join(" ");
  // Replace the SDK's wrapper shell so its process handle owns the executable
  // itself; otherwise killing the shell can leave the search process running.
  parts.push(envPrefix ? `${envPrefix} exec ${cmd}` : `exec ${cmd}`);
  return parts.join(" && ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Parse `find -printf '%T@ %s %p\n'` output into file entries. `%T@` is a float
 * epoch-seconds; sizes are bytes; paths are absolute.
 */
export function parseFindOutput(stdout: string): SandboxFileEntry[] {
  const entries: SandboxFileEntry[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed) continue;
    const firstSpace = trimmed.indexOf(" ");
    if (firstSpace < 0) continue;
    const secondSpace = trimmed.indexOf(" ", firstSpace + 1);
    if (secondSpace < 0) continue;
    const mtimeStr = trimmed.slice(0, firstSpace);
    const sizeStr = trimmed.slice(firstSpace + 1, secondSpace);
    const path = trimmed.slice(secondSpace + 1);
    const mtimeSec = Number.parseFloat(mtimeStr);
    const size = Number.parseInt(sizeStr, 10);
    if (Number.isNaN(mtimeSec) || Number.isNaN(size) || !path) continue;
    entries.push({ path, size, mtimeMs: Math.round(mtimeSec * 1000) });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/** Default factory over the real e2b SDK. */
const defaultCreateSandbox: CreateSandboxFn = (template, opts) =>
  Sandbox.create(template, opts) as unknown as Promise<E2BSandbox>;
