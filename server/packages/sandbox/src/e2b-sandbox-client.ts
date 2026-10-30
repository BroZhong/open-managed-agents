import { ApiClient, AuthenticationError, ConnectionConfig, RateLimitError, Sandbox, SandboxError, SandboxNotFoundError, FileNotFoundError, InvalidArgumentError } from "e2b";
import {
  WORKSPACE_MOUNT_PROBE,
  WORKSPACE_MOUNT_PROBE_CLEANUP,
} from "./workspace-mount-probe.js";
import {
  WorkspaceMountUnavailable,
  type WorkspaceMountTarget,
} from "./workspace-mount.js";
import { ExecAbortedBeforeStartError, SANDBOX_WORKSPACE_ROOT } from "@open-managed-agents/adapter-core";
import type { ToolFileSystem } from "@open-managed-agents/adapter-core";
import { createSandboxFileSystem } from "./sandbox-file-system.js";
import {
  CLAIM_SECONDS,
  CREATE_REQUEST_MS,
  SANDBOX_RUNNING_SECONDS,
  CLAIM_IMAGE_METADATA,
  SandboxCreateRejected,
  WAIT_READY_SECONDS,
  isDigestPinnedImage,
  listedSandbox,
} from "./sandbox-client.js";
import type {
  ListedSandbox,
  SandboxClaim,
  SandboxClient,
  SandboxCreateOptions,
  SandboxExecChunk,
  SandboxExecOptions,
  SandboxFileEntry,
  SandboxHandle,
  SandboxListFilter,
} from "./sandbox-client.js";
import { shellQuote } from "./shell-quote.js";

export interface E2BCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface E2BCommandHandle {
  readonly pid: number;
  wait(): Promise<E2BCommandResult>;
  kill(): Promise<boolean>;
  disconnect(): Promise<void>;
}

export interface E2BCommandOptions {
  user?: string;
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Keep stdin open for {@link E2BSandbox.commands.sendStdin}. */
  stdin?: boolean;
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
    /** The Sandbox's envd cannot close stdin, so input is sent once and never ended. */
    sendStdin(pid: number, data: string | Uint8Array): Promise<void>;
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
    lifecycle: { onTimeout: "kill" };
    requestTimeoutMs: number;
  },
) => Promise<E2BSandbox>;

/**
 * Read inside a just-claimed Sandbox: the container's uptime and PID 1's
 * start in clock ticks since its boot, the tick rate, the Sandbox's clock and
 * when the Pod's `/etc/hostname` was written (the Pod's start: the kubelet
 * writes it once per Pod, and a container restart keeps it). The gateway
 * reports nothing about an in-place swap, so the Host observes it (see
 * {@link claimSwapped}).
 */
export const CLAIM_PROBE = "cat /proc/uptime /proc/1/stat && getconf CLK_TCK && date +%s.%N && stat -c %Z /etc/hostname";

/** Client timeouts of the control-plane calls other than create; each is one short gateway step. */
const CONTROL_REQUEST_MS = {
  /** The 2026-10-10 lifecycle verification measured 30 ms to a running Sandbox. */
  connect: 60_000,
  /** Read from the manager's cache. */
  getInfo: 20_000,
  /** One Kubernetes delete; the deletion is confirmed afterwards by getInfo. */
  kill: 30_000,
  /** One Kubernetes patch of the deadline. */
  setTimeout: 30_000,
  /** One page, read from the manager's cache: 8 pages of 100 took 141 ms in-cluster on 2026-10-23. */
  list: 20_000,
} as const;
/** The gateway's largest page. */
const LIST_PAGE_LIMIT = 100;

export interface E2BSandboxClientOptions {
  /** E2B domain (e.g. "sandbox.agentry.welltop.tech"); SDK resolves api.<domain>. */
  domain: string;
  /** Gateway API key. */
  apiKey: string;
  /**
   * The Warm Pool (SandboxSet name) every Sandbox is claimed from: the E2B
   * template of every create (ADR-0024). The image comes with each create.
   */
  pool: string;
  /** Monotonic milliseconds for claim timing; tests inject one. */
  clock?: () => number;
  /**
   * Injectable sandbox factory. Defaults to the real `Sandbox.create`. Tests
   * pass a fake so the client can be exercised with no network.
   */
  createSandbox?: CreateSandboxFn;
  connectSandbox?: (id: string, opts: { apiKey: string; domain: string; requestTimeoutMs: number; timeoutMs: number; signal: AbortSignal }) => Promise<E2BSandbox>;
  getSandboxInfo?: (id: string) => Promise<{ state: string }>;
  killSandbox?: (id: string) => Promise<unknown>;
  setSandboxTimeout?: (id: string, timeoutMs: number) => Promise<void>;
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
 * injected, never hardcoded). Every create claims from the one Warm Pool
 * ({@link E2BSandboxClientOptions.pool}) and passes its digest-pinned
 * `image` as `e2b.agents.kruise.io/image`: the pool's own image is a plain
 * claim, any other is swapped in place (ADR-0024).
 *
 * `exec` shell-quotes argv for the SDK's `bash -lc` wrapper (honouring cwd; env goes as envd `envs`),
 * replaces that shell with the command, streams stdout/stderr, and reports a
 * non-zero exit is reported through `onExit`, while stdout/stderr retain their
 * original streaming surface for existing consumers.
 */
export class E2BSandboxClient implements SandboxClient {
  private readonly domain: string;
  private readonly apiKey: string;
  private readonly pool: string;
  private readonly clock: () => number;
  private readonly createSandbox: CreateSandboxFn;
  private readonly connectSandbox: NonNullable<E2BSandboxClientOptions["connectSandbox"]>;
  private readonly getSandboxInfo: NonNullable<E2BSandboxClientOptions["getSandboxInfo"]>;
  private readonly killSandbox: NonNullable<E2BSandboxClientOptions["killSandbox"]>;
  private readonly setSandboxTimeout: NonNullable<E2BSandboxClientOptions["setSandboxTimeout"]>;
  private readonly verifyWorkspaceProbe: E2BSandboxClientOptions["verifyWorkspaceProbe"];
  private readonly creationMetadata = new Map<string, Record<string, string>>();
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
    if (!opts.pool) throw new Error("E2BSandboxClient requires the Warm Pool (SandboxSet) name");
    this.domain = opts.domain;
    this.apiKey = opts.apiKey;
    this.pool = opts.pool;
    this.clock = opts.clock ?? (() => performance.now());
    this.createSandbox = opts.createSandbox ?? defaultCreateSandbox;
    this.connectSandbox = opts.connectSandbox ?? ((id, options) => Sandbox.connect(id, options));
    this.verifyWorkspaceProbe = opts.verifyWorkspaceProbe;
    const control = { apiKey: this.apiKey, domain: this.domain };
    this.getSandboxInfo = opts.getSandboxInfo ??
      (id => Sandbox.getInfo(id, { ...control, requestTimeoutMs: CONTROL_REQUEST_MS.getInfo }));
    this.killSandbox = opts.killSandbox ??
      (id => Sandbox.kill(id, { ...control, requestTimeoutMs: CONTROL_REQUEST_MS.kill }));
    this.setSandboxTimeout = opts.setSandboxTimeout ??
      ((id, timeoutMs) => Sandbox.setTimeout(id, timeoutMs, { ...control, requestTimeoutMs: CONTROL_REQUEST_MS.setTimeout }));
  }

  async create(opts: SandboxCreateOptions): Promise<SandboxHandle> {
    const { image } = opts;
    // The gateway answers an invalid image with 400 too: a definite
    // rejection that claimed nothing (builds push images by digest).
    if (!isDigestPinnedImage(image)) throw new SandboxCreateRejected(400);
    const started = this.clock();
    const sandbox = await this.createSandbox(this.pool, {
      requestTimeoutMs: CREATE_REQUEST_MS,
      apiKey: this.apiKey,
      domain: this.domain,
      metadata: { ...opts.metadata,
        [CLAIM_IMAGE_METADATA]: image,
        'e2b.agents.kruise.io/claim-timeout-seconds': String(CLAIM_SECONDS),
        'e2b.agents.kruise.io/wait-ready-timeout-seconds': String(WAIT_READY_SECONDS),
      },
      // Deleted at its deadline, never paused (ADR-0025): the next Turn
      // claims from the Warm Pool faster than a paused Sandbox resumes.
      lifecycle: { onTimeout: 'kill' },
      ...(opts.env ? { envs: opts.env } : {}),
      timeoutMs: (opts.timeoutSeconds ?? SANDBOX_RUNNING_SECONDS) * 1000,
    }).catch(createFailed);
    const claimMs = Math.round(this.clock() - started);
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    this.creationMetadata.set(sandbox.sandboxId, { ...opts.metadata });
    const swapped = await this.observeSwap(sandbox, started);
    const claim: SandboxClaim = { image, claimMs, ...(swapped === undefined ? {} : { swapped }) };
    return { id: sandbox.sandboxId, claim };
  }

  /**
   * Whether the claim that began at `started` swapped the Sandbox's image in
   * place (see {@link claimSwapped}). Never fails the create, and its
   * failure is no evidence about any command: undefined when unobserved.
   */
  private async observeSwap(sandbox: E2BSandbox, started: number): Promise<boolean | undefined> {
    try {
      const result = await sandbox.commands.run(CLAIM_PROBE, { timeoutMs: 10_000 });
      return claimSwapped(result.stdout, this.clock() - started);
    } catch {
      return undefined;
    }
  }

  async verifyWorkspaceMount(
    id: string,
    target: WorkspaceMountTarget,
  ): Promise<void> {
    try {
      const sandbox = this.require(id);
      const requested = this.creationMetadata.get(id) ?? {};
      const info = await sandbox.getInfo({ requestTimeoutMs: CONTROL_REQUEST_MS.getInfo });
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
      const result = await this.observeRemote(id, () => sandbox.commands.run(
        ["python3", "-c", WORKSPACE_MOUNT_PROBE, target.mountPath]
          .map(shellQuote)
          .join(" "),
        { user: "user", cwd: "/home/user", timeoutMs: 20_000 },
      ));
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
        const cleanup = await this.observeRemote(id, () => sandbox.commands.run(
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
        ));
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
    let exited = false;
    try { yield* streamRun(sandbox, cmd, {
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
      ...(opts?.user ? { user: opts.user } : {}),
      ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}),
      onExit: (result) => {
        exited = true;
        opts?.onExit?.(result);
      },
    }); } catch (error) {
      if (error instanceof ExecAbortedBeforeStartError) exited = true;
      throw error;
    } finally {
      if (!exited) this.uncertain.add(id);
    }
  }

  // Running operations belong to their own durable Turn activities. Do not
  // mistake a sibling's still-running command for this Turn's unknown outcome.
  private readonly uncertain = new Set<string>();
  hasUncertainExecution(id: string): boolean { return this.uncertain.has(id); }
  private async observeRemote<T>(id: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!isCommandExitError(error) && !(error instanceof FileNotFoundError) && !(error instanceof InvalidArgumentError)) this.uncertain.add(id);
      throw error;
    }
  }

  async readFile(id: string, path: string): Promise<string> {
    const sandbox = this.require(id);
    return this.observeRemote(id, () => sandbox.files.read(path, { format: "text" }));
  }

  async readFileBytes(id: string, path: string): Promise<Uint8Array> {
    const sandbox = this.require(id);
    return this.observeRemote(id, () => sandbox.files.read(path, { format: "bytes" }));
  }

  async writeFile(id: string, path: string, content: string): Promise<void> {
    const sandbox = this.require(id);
    // The e2b SDK creates parent directories automatically on write.
    await this.observeRemote(id, () => sandbox.files.write(path, content));
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
    await this.observeRemote(id, () => sandbox.files.write(path, copy.buffer));
  }

  async remove(id: string, path: string): Promise<void> {
    const sandbox = this.require(id);
    try {
      await this.observeRemote(id, () => sandbox.files.remove(path));
    } catch (error) {
      // Downward reconciliation is idempotent. A concurrent/missing delete is
      // already the desired state; preserve all other backend failures.
      if (!isMissingFileError(error)) throw error;
    }
  }

  async list(id: string, dir: string, options?: { missingOk?: boolean }): Promise<SandboxFileEntry[]> {
    const sandbox = this.require(id);
    if (options?.missingOk) {
      // Node stat preserves ENOENT/EACCES distinctions. A shell test -e would
      // silently classify an inaccessible parent directory as a missing path.
      try { await this.fileSystem(id).stat(dir); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
    }
    // `find` prints: <mtime-epoch-seconds> <size-bytes> <path>, one per file.
    // We use it (rather than the SDK's `files.list`) so size + mtime are always
    // present and the listing is fully recursive, the ToolExecutor listing contract.
    // CSI exposes the Workspace root as a symlink. -H follows that command-line
    // root while preserving find's normal handling of links inside the tree.
    const res = await this.observeRemote(id, () => sandbox.commands.run(
      `find -H ${shellQuote(dir)} -type f -printf '%T@ %s %p\\n'`,
    ));
    if (res.exitCode !== 0)
      throw new Error("Sandbox file list failed; retry after storage recovers");
    return parseFindOutput(res.stdout);
  }

  resetExecutionUncertainty(id: string): void { this.uncertain.delete(id); }
  async state(id: string): Promise<"running" | "missing"> {
    try {
      const info = await this.getSandboxInfo(id);
      if (info.state === 'running') return info.state;
      throw new Error('Sandbox control-plane state is unknown');
    } catch (error) {
      if (error instanceof SandboxNotFoundError) { this.forget(id); return 'missing'; }
      throw error;
    }
  }
  async setTimeout(id: string, seconds: number): Promise<void> {
    await this.setSandboxTimeout(id, seconds * 1000);
  }

  async reconnect(id: string, metadata: Record<string, string>): Promise<boolean> {
    let sandbox: E2BSandbox;
    try {
      // A handle keeps the requestTimeoutMs it was opened with as the default
      // of its data-plane requests (file transfers, command start). Give it the
      // same default as a created handle and bound the connect itself by signal.
      sandbox = await this.connectSandbox(id, {
        apiKey: this.apiKey, domain: this.domain, timeoutMs: SANDBOX_RUNNING_SECONDS * 1000,
        requestTimeoutMs: CREATE_REQUEST_MS, signal: AbortSignal.timeout(CONTROL_REQUEST_MS.connect),
      });
    } catch (error) {
      if (error instanceof SandboxNotFoundError) { this.forget(id); return false; }
      throw error;
    }
    this.sandboxes.set(id, sandbox);
    // The coordinates come from the Host's immutable Workspace binding. The
    // regular mount verifier independently checks the gateway's authorization.
    this.creationMetadata.set(id, { ...metadata });
    return true;
  }

  async listSandboxes(filter: SandboxListFilter): Promise<ListedSandbox[]> {
    // The SDK's client keeps the request on its own dispatcher (no HTTP proxy)
    // and on the gateway E2B_API_URL names, as every other call here.
    const { api } = new ApiClient(new ConnectionConfig({ apiKey: this.apiKey, domain: this.domain }));
    // The gateway unescapes `metadata` once more before splitting it into
    // pairs (upstream pkg/servers/e2b/list.go), so each key and value is
    // escaped here and the whole once more as a query parameter. The SDK's
    // paginator escapes them twice, which the gateway reads as other keys.
    // No labels sends no `metadata`: every Sandbox of the API key (the sweeper's list).
    const metadata = Object.entries(filter.metadata)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&") || undefined;
    const listed: ListedSandbox[] = [];
    let nextToken: string | undefined;
    do {
      const { data, response } = await api.GET("/v2/sandboxes", {
        params: { query: { metadata, state: ["running"], limit: LIST_PAGE_LIMIT, nextToken } },
        signal: AbortSignal.timeout(CONTROL_REQUEST_MS.list),
      });
      // The body may echo metadata, which can hold credentials (#260): report the status only.
      if (!response.ok || !data) throw new Error(`Sandbox list answered HTTP ${response.status}`);
      for (const entry of data) {
        const sandbox = listedSandbox(entry);
        if (sandbox) listed.push(sandbox);
      }
      nextToken = response.headers.get("x-next-token") || undefined;
    } while (nextToken);
    return listed;
  }

  async destroy(id: string): Promise<void> {
    try {
      await this.killSandbox(id);
      if (await this.state(id) !== 'missing') throw new Error('Sandbox deletion is not yet confirmed');
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) throw error;
    }
    this.forget(id);
  }

  private forget(id: string): void {
    this.sandboxes.delete(id);
    this.creationMetadata.delete(id);
    this.fileSystems.delete(id);
    this.uncertain.delete(id);
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
 * Whether a claim swapped the image in place, from the {@link CLAIM_PROBE}
 * output read `elapsedMs` after the create began; undefined when unreadable.
 * The gateway swaps by restarting the main container in the claimed Pod:
 * - PID 1 older than the claim: the warm container was kept (a plain claim);
 * - PID 1 younger, in a Pod older than the claim: the container was replaced
 *   in place (a swap);
 * - both younger: the Pod was created for the claim with the image (a cold
 *   start when the pool had no stock).
 * ACS gives each container its own uptime (PID 1 starts at 0), so the Pod's
 * age comes from `/etc/hostname` on the Sandbox's own clock, to the second.
 */
export function claimSwapped(probe: string, elapsedMs: number): boolean | undefined {
  const [uptimeLine, statLine, ticksLine, nowLine, podStartLine] = probe.trim().split("\n");
  const uptime = Number.parseFloat(uptimeLine ?? "");
  // Fields after the parenthesised command name start at field 3 (state); starttime is field 22.
  const startTicks = Number.parseInt(statLine?.slice(statLine.lastIndexOf(")") + 2).split(" ")[19] ?? "", 10);
  const ticks = Number.parseInt(ticksLine ?? "", 10);
  const podAge = Number.parseFloat(nowLine ?? "") - Number.parseInt(podStartLine ?? "", 10);
  if (!statLine?.includes(")") || !(ticks > 0) || ![uptime, startTicks, podAge].every(Number.isFinite)) return undefined;
  const elapsed = elapsedMs / 1000;
  if (uptime - startTicks / ticks >= elapsed) return false;
  // The Pod's start is known to the second.
  return podAge > elapsed + 1;
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
    user?: string;
    /** Sent once the process has started; its stdin then stays open. */
    stdin?: string;
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
      const { signal: _signal, onExit: _onExit, stdin, ...runOptions } = opts;
      handle = await sandbox.commands.run(cmd, {
        ...runOptions,
        ...(stdin !== undefined ? { stdin: true } : {}),
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
      let stdinFailure: Error | undefined;
      if (stdin !== undefined && !cancelRequested) {
        // A process left waiting for input it never receives is stopped,
        // and the transport error reported instead of a cancellation.
        try { await sandbox.commands.sendStdin(handle.pid, stdin); }
        catch (reason) { stdinFailure = reason instanceof Error ? reason : new Error(String(reason)); cancel(); }
      }
      if (cancelRequested) cancel();
      const outcome = await Promise.race([waiting, killFailure]);
      await killPromise;
      if (killError) throw killError;
      if (stdinFailure) throw stdinFailure;
      if (cancelRequested && killed && ('result' in outcome || isCommandExitError(outcome.reason))) {
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
        // A lost stream is not exit evidence. Do not issue a new destructive
        // RPC into an unreachable Sandbox or block recovery on that RPC.
        // Explicit user cancellation owns killPromise above; transport
        // failures disconnect and preserve uncertainty for the caller.
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
 * Quote argv for the SDK's shell, honouring cwd and replacing the shell with
 * the executable so the SDK process handle can terminate it reliably. The
 * command's env is not part of it: exec passes it as envd `envs`.
 */
export function wrapCommand(
  command: string[],
  opts?: SandboxExecOptions,
): string {
  const parts: string[] = [];
  if (opts?.cwd) {
    parts.push(`cd ${shellQuote(opts.cwd)}`);
  }
  // Variables travel as the request's envd `envs` only, never in the command
  // string, which the Sandbox's process list shows: they may be secrets
  // (ADR-0024). A profile script keeps them by writing `${NAME:-value}`.
  const cmd = command.map(shellQuote).join(" ");
  // Replace the SDK's wrapper shell so its process handle owns the executable
  // itself; otherwise killing the shell can leave the search process running.
  parts.push(`exec ${cmd}`);
  return parts.join(" && ");
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

/**
 * Rethrow a failed create as {@link SandboxCreateRejected} when the gateway
 * answered it with an HTTP status, otherwise (a timeout, a lost connection)
 * as it is. The SDK keeps the status only in its error: AuthenticationError
 * for 401, RateLimitError for 429, and for every other status a SandboxError
 * whose message is "<status>: <the answer's message>" (its handleApiError).
 */
function createFailed(error: unknown): never {
  if (error instanceof AuthenticationError) throw new SandboxCreateRejected(401);
  if (error instanceof RateLimitError) throw new SandboxCreateRejected(429);
  const status = error instanceof SandboxError ? /^([1-5]\d\d): /.exec(error.message)?.[1] : undefined;
  throw status === undefined ? error : new SandboxCreateRejected(Number(status));
}

/** Default factory over the real e2b SDK. */
const defaultCreateSandbox: CreateSandboxFn = (template, opts) =>
  Sandbox.create(template, opts) as unknown as Promise<E2BSandbox>;
