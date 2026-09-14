import { Sandbox } from "e2b";
import {
  WORKSPACE_MOUNT_PROBE,
  WORKSPACE_MOUNT_PROBE_CLEANUP,
} from "./workspace-mount-probe.js";
import {
  WorkspaceMountUnavailable,
  type WorkspaceMountTarget,
} from "./workspace-mount.js";
import type {
  SandboxClient,
  SandboxCreateOptions,
  SandboxExecChunk,
  SandboxExecOptions,
  SandboxFileEntry,
  SandboxHandle,
} from "./sandbox-client.js";

/**
 * The slice of the e2b `Sandbox` instance this client actually uses. Kept
 * structural so tests can pass a hand-rolled fake without dragging in the whole
 * SDK surface.
 */
export interface E2BSandbox {
  readonly sandboxId: string;
  commands: {
    run(
      cmd: string,
      opts?: {
        user?: string;
        cwd?: string;
        envs?: Record<string, string>;
        timeoutMs?: number;
        /**
         * Abort the in-flight command (issue #84). The e2b SDK's
         * `CommandStartOpts` extends `Pick<ConnectionOpts, 'signal'>`, so `run`
         * accepts an `AbortSignal`; aborting it cancels the underlying request.
         */
        signal?: AbortSignal;
        onStdout?: (data: string) => void | Promise<void>;
        onStderr?: (data: string) => void | Promise<void>;
      },
    ): Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
      error?: string;
    }>;
  };
  files: {
    read(path: string, opts?: { format?: "text" }): Promise<string>;
    read(path: string, opts: { format: "bytes" }): Promise<Uint8Array>;
    write(path: string, data: string | ArrayBuffer): Promise<unknown>;
    remove(path: string): Promise<void>;
  };
  getInfo(opts?: {
    requestTimeoutMs?: number;
  }): Promise<{ metadata: Record<string, string> }>;
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
    requestTimeoutMs: number;
  },
) => Promise<E2BSandbox>;

const DEFAULT_TEMPLATE = "code-interpreter";

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
  /** Slightly exceeds ALB 180s so its timeout response can reach the SDK. */
  requestTimeoutMs?: number;
  /** Host OSS readback proves the mount writes into the exact trusted prefix. */
  verifyWorkspaceProbe: (
    target: WorkspaceMountTarget,
    probeName: string,
    expectedContent: string,
  ) => Promise<void>;
}

/**
 * e2b-SDK-backed {@link SandboxClient}.
 *
 * Replaces the abandoned kruise-CRD client (#53). Sandboxes are created via the
 * official `e2b` Node SDK against a self-hosted gateway (domain + apiKey are
 * injected, never hardcoded). The `image` create option maps to an e2b
 * template (the SandboxSet name); when omitted, {@link defaultTemplate} is used.
 *
 * `exec` mirrors the old kruise semantics: the argv is wrapped in `sh -lc`
 * (honouring cwd/env), stdout/stderr are streamed chunk-by-chunk, and a
 * non-zero exit is NOT surfaced as a chunk or thrown — a failing command's
 * stderr is simply part of the stream, exactly as before.
 */
export class E2BSandboxClient implements SandboxClient {
  private readonly domain: string;
  private readonly apiKey: string;
  private readonly defaultTemplate: string;
  private readonly createSandbox: CreateSandboxFn;
  private readonly requestTimeoutMs: number;
  private readonly verifyWorkspaceProbe: E2BSandboxClientOptions["verifyWorkspaceProbe"];
  private readonly creationMetadata = new Map<string, Record<string, string>>();
  /** id -> live sandbox handle, so subsequent ops resolve the instance. */
  private readonly sandboxes = new Map<string, E2BSandbox>();

  constructor(opts: E2BSandboxClientOptions) {
    if (!opts.domain) throw new Error("E2BSandboxClient requires a domain");
    if (!opts.apiKey) throw new Error("E2BSandboxClient requires an apiKey");
    this.domain = opts.domain;
    this.apiKey = opts.apiKey;
    this.defaultTemplate = opts.defaultTemplate ?? DEFAULT_TEMPLATE;
    this.createSandbox = opts.createSandbox ?? defaultCreateSandbox;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 185_000;
    this.verifyWorkspaceProbe = opts.verifyWorkspaceProbe;
  }

  async create(opts: SandboxCreateOptions = {}): Promise<SandboxHandle> {
    const template = resolveTemplate(opts.image, this.defaultTemplate);
    const sandbox = await this.createSandbox(template, {
      requestTimeoutMs: this.requestTimeoutMs,
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
    this.creationMetadata.set(sandbox.sandboxId, { ...opts.metadata });
    return { id: sandbox.sandboxId };
  }

  async verifyWorkspaceMount(
    id: string,
    target: WorkspaceMountTarget,
  ): Promise<void> {
    try {
      const sandbox = this.require(id);
      const requested = this.creationMetadata.get(id) ?? {};
      const info = await sandbox.getInfo({ requestTimeoutMs: 20_000 });
      const volume = JSON.parse(
        requested["e2b.agents.kruise.io/csi-volume-config"] ?? "null",
      )?.[0];
      const authorization = JSON.parse(
        info.metadata["security.agents.kruise.io/storage-auth"] ?? "null",
      );
      if (
        !volume ||
        volume.mountPath !== target.mountPath ||
        volume.subPath !== target.prefix.slice(0, -1) ||
        info.metadata["security.agents.kruise.io/agent-name"] !==
          requested["security.agents.kruise.io/agent-name"] ||
        !Array.isArray(authorization) ||
        authorization.length !== 1 ||
        authorization[0]?.credentialProviderName !==
          volume.attributes?.credentialProviderName ||
        authorization[0]?.attributes?.["bucket-name"] !== target.bucket ||
        authorization[0]?.attributes?.["sub-path"] !==
          target.prefix.slice(0, -1)
      ) {
        throw new WorkspaceMountUnavailable();
      }
      const result = await sandbox.commands.run(
        ["python3", "-c", WORKSPACE_MOUNT_PROBE, target.mountPath]
          .map(shellQuote)
          .join(" "),
        { user: "user", cwd: "/home/user", timeoutMs: 20_000 },
      );
      if (result.exitCode !== 0) throw new WorkspaceMountUnavailable();
      const probe = JSON.parse(result.stdout);
      if (
        !/^[a-f0-9]{32}$/.test(probe.probeName) ||
        !/^[a-f0-9]{64}$/.test(probe.content) ||
        !/^\/run\/csi\/mount-root\/oss\/[a-f0-9]{32}$/.test(probe.realPath)
      )
        throw new WorkspaceMountUnavailable();
      try {
        await this.verifyWorkspaceProbe(target, probe.probeName, probe.content);
      } finally {
        const cleanup = await sandbox.commands.run(
          [
            "python3",
            "-c",
            WORKSPACE_MOUNT_PROBE_CLEANUP,
            probe.realPath,
            probe.probeName,
          ]
            .map(shellQuote)
            .join(" "),
          { user: "user", cwd: "/home/user", timeoutMs: 20_000 },
        );
        if (
          cleanup.exitCode !== 0 ||
          cleanup.stdout.trim() !== "OMA_WORKSPACE_PROBE_REMOVED"
        )
          throw new WorkspaceMountUnavailable();
      }
    } catch {
      // SDK/provider errors can contain sensitive diagnostics. Keep the error
      // stable and safe for the Agent, Turn stream and application logs.
      throw new WorkspaceMountUnavailable();
    }
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
      // Forward the turn's abort signal so a hung command is cancelled when the
      // router aborts the turn (issue #84).
      ...(opts?.signal ? { signal: opts.signal } : {}),
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
    // present and the listing is fully recursive, the ToolExecutor listing contract.
    // CSI exposes the Workspace root as a symlink. -H follows that command-line
    // root while preserving find's normal handling of links inside the tree.
    const res = await sandbox.commands.run(
      `find -H ${shellQuote(dir)} -type f -printf '%T@ %s %p\\n'`,
    );
    if (res.exitCode !== 0)
      throw new Error("Sandbox file list failed; retry after storage recovers");
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
    try {
      await sandbox.kill();
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    this.sandboxes.delete(id);
    this.creationMetadata.delete(id);
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private require(id: string): E2BSandbox {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) {
      throw new Error(`No live sandbox for ${id} (create it first)`);
    }
    return sandbox;
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
 * into the `AsyncIterable<SandboxExecChunk>` the port requires. A non-zero exit
 * is not surfaced (matches the kruise client): the command's stderr is streamed
 * like any other output and `run` resolving/throwing on exit is swallowed.
 */
async function* streamRun(
  sandbox: E2BSandbox,
  cmd: string,
  opts: {
    cwd?: string;
    envs?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): AsyncIterable<SandboxExecChunk> {
  const queue: SandboxExecChunk[] = [];
  let resolveNext: (() => void) | undefined;
  let done = false;
  let error: Error | undefined;
  const wake = () => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = undefined;
      r();
    }
  };
  const push = (stream: "stdout" | "stderr") => (data: string) => {
    queue.push({ stream, text: data });
    wake();
  };

  sandbox.commands
    .run(cmd, {
      ...opts,
      onStdout: push("stdout"),
      onStderr: push("stderr"),
    })
    .then(
      () => {
        done = true;
        wake();
      },
      (e: unknown) => {
        // A non-zero exit (CommandExitError) is expected command behavior, not
        // a transport failure — its stderr already streamed via onStderr, so we
        // finish cleanly. Only genuine SDK/transport errors are surfaced.
        if (isCommandExitError(e)) {
          done = true;
        } else {
          error = e instanceof Error ? e : new Error(String(e));
          done = true;
        }
        wake();
      },
    );

  while (true) {
    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }
    if (done) {
      if (error) throw error;
      return;
    }
    await new Promise<void>((r) => {
      resolveNext = r;
    });
  }
}

/** A non-zero exit surfaces as an object carrying a numeric `exitCode`. */
function isCommandExitError(e: unknown): boolean {
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
 * Wrap an argv into a `sh -lc` command string, honouring cwd + env. Mirrors the
 * kruise client so exec semantics (login shell, cd, env prefix) are unchanged.
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
  parts.push(envPrefix ? `${envPrefix} ${cmd}` : cmd);
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
