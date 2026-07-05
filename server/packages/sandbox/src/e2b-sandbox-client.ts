import { Sandbox } from "e2b";
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
        cwd?: string;
        envs?: Record<string, string>;
        timeoutMs?: number;
        onStdout?: (data: string) => void | Promise<void>;
        onStderr?: (data: string) => void | Promise<void>;
      },
    ): Promise<{ exitCode: number; stdout: string; stderr: string; error?: string }>;
  };
  files: {
    read(path: string, opts?: { format?: "text" }): Promise<string>;
    write(path: string, data: string): Promise<unknown>;
  };
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

const DEFAULT_TEMPLATE = "code-interpreter";
const DEFAULT_WORKSPACE_DIR = "/workspace";

export interface E2BSandboxClientOptions {
  /** E2B domain (e.g. "sandbox.brozhong.com"); SDK resolves api.<domain>. */
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
  /** id -> live sandbox handle, so subsequent ops resolve the instance. */
  private readonly sandboxes = new Map<string, E2BSandbox>();

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
      ...(opts?.timeoutSeconds != null
        ? { timeoutMs: opts.timeoutSeconds * 1000 }
        : {}),
    });
  }

  async readFile(id: string, path: string): Promise<string> {
    const sandbox = this.require(id);
    return sandbox.files.read(path, { format: "text" });
  }

  async writeFile(id: string, path: string, content: string): Promise<void> {
    const sandbox = this.require(id);
    // The e2b SDK creates parent directories automatically on write.
    await sandbox.files.write(path, content);
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

  async destroy(id: string): Promise<void> {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) return; // already gone — idempotent.
    this.sandboxes.delete(id);
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
 * into the `AsyncIterable<SandboxExecChunk>` the port requires. A non-zero exit
 * is not surfaced (matches the kruise client): the command's stderr is streamed
 * like any other output and `run` resolving/throwing on exit is swallowed.
 */
async function* streamRun(
  sandbox: E2BSandbox,
  cmd: string,
  opts: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number },
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
