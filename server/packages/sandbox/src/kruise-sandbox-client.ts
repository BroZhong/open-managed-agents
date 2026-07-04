import { spawn } from "node:child_process";
import type {
  SandboxClient,
  SandboxCreateOptions,
  SandboxExecChunk,
  SandboxExecOptions,
  SandboxFileEntry,
  SandboxHandle,
} from "./sandbox-client.js";

/**
 * Result of running a subprocess to completion.
 */
interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Injectable process runner — the seam the tests mock. Defaults to spawning
 * real subprocesses (`kubectl`). Returns collected stdout/stderr + exit code.
 */
export type CommandRunner = (
  argv: string[],
  opts?: { stdin?: string },
) => Promise<CommandResult>;

/**
 * Injectable streaming runner used by `exec` so command output is streamed
 * chunk-by-chunk rather than buffered. Defaults to spawning `kubectl exec`.
 */
export type StreamRunner = (argv: string[]) => AsyncIterable<SandboxExecChunk>;

const DEFAULT_KUBECTL = "kubectl";
const DEFAULT_NAMESPACE = "sandbox-system";
const DEFAULT_IMAGE = "ubuntu:22.04";
const DEFAULT_RUNTIME_NAME = "default";
const DEFAULT_READY_TIMEOUT_SECONDS = 180;
const DEFAULT_READY_POLL_MS = 2000;
const DEFAULT_WORKSPACE_DIR = "/workspace";
const API_GROUP = "agents.kruise.io";
const API_VERSION = "v1alpha1";

export interface KruiseSandboxClientOptions {
  /** Path/name of the kubectl binary. Defaults to `kubectl`. */
  kubectl?: string;
  /** Kube namespace the Sandbox CRs and pods live in. */
  namespace?: string;
  /** Default image / template when a create call omits one. */
  defaultImage?: string;
  /** The `spec.runtimes[].name` written into the Sandbox CR. */
  runtimeName?: string;
  /** How long to wait for a Sandbox to reach Running before failing. */
  readyTimeoutSeconds?: number;
  /** Poll interval while waiting for readiness. */
  readyPollMs?: number;
  /** Injectable buffered command runner (tests mock this). */
  runner?: CommandRunner;
  /** Injectable streaming runner for `exec` (tests mock this). */
  streamRunner?: StreamRunner;
  /** Injectable id generator (tests make this deterministic). */
  generateId?: () => string;
}

/**
 * kruise-CRD-backed {@link SandboxClient}.
 *
 * Per the #37 spike, this creates a `Sandbox` CR under `agents.kruise.io/
 * v1alpha1`, waits for `status.phase=Running`, and performs exec + file I/O by
 * shelling into the sandbox pod via `kubectl exec`. It never references the
 * abandoned opensandbox SDK.
 *
 * NOTE (live blocker, per the spike): a bare Sandbox CR currently stays
 * `Pending` in the brozhong cluster with no ECI pod scheduled, so live e2e is
 * gated on the infra owner resolving that. This client is unit-tested behind a
 * fake runner; the wiring is real so it lights up once the blocker clears.
 */
export class KruiseSandboxClient implements SandboxClient {
  private readonly kubectl: string;
  private readonly namespace: string;
  private readonly defaultImage: string;
  private readonly runtimeName: string;
  private readonly readyTimeoutSeconds: number;
  private readonly readyPollMs: number;
  private readonly runner: CommandRunner;
  private readonly streamRunner: StreamRunner;
  private readonly generateId: () => string;
  /** id -> pod name, resolved when the CR reaches Running. */
  private readonly pods = new Map<string, string>();

  constructor(opts: KruiseSandboxClientOptions = {}) {
    this.kubectl = opts.kubectl ?? DEFAULT_KUBECTL;
    this.namespace = opts.namespace ?? DEFAULT_NAMESPACE;
    this.defaultImage = opts.defaultImage ?? DEFAULT_IMAGE;
    this.runtimeName = opts.runtimeName ?? DEFAULT_RUNTIME_NAME;
    this.readyTimeoutSeconds =
      opts.readyTimeoutSeconds ?? DEFAULT_READY_TIMEOUT_SECONDS;
    this.readyPollMs = opts.readyPollMs ?? DEFAULT_READY_POLL_MS;
    this.runner = opts.runner ?? defaultRunner(this.kubectl);
    this.streamRunner = opts.streamRunner ?? defaultStreamRunner(this.kubectl);
    this.generateId =
      opts.generateId ??
      (() => `sbx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  }

  async create(opts: SandboxCreateOptions = {}): Promise<SandboxHandle> {
    const id = this.generateId();
    const manifest = this.buildManifest(id, opts);
    // Apply the Sandbox CR.
    await this.kubectlJson(
      ["apply", "-f", "-", "-o", "json"],
      JSON.stringify(manifest),
    );

    // Wait for status.phase=Running and capture the pod name.
    const podName = await this.waitForReady(id);
    this.pods.set(id, podName);
    // Ensure the workspace dir exists before hydrate/exec.
    await this.drain(this.exec(id, ["mkdir", "-p", DEFAULT_WORKSPACE_DIR]));
    return { id };
  }

  async *exec(
    id: string,
    command: string[],
    opts?: SandboxExecOptions,
  ): AsyncIterable<SandboxExecChunk> {
    if (command.length === 0) {
      throw new Error("exec requires a non-empty command");
    }
    const pod = this.requirePod(id);
    const inner = this.wrapCommand(command, opts);
    const argv = [
      "-n",
      this.namespace,
      "exec",
      pod,
      "--",
      "sh",
      "-lc",
      inner,
    ];
    yield* this.streamRunner([this.kubectl, ...argv]);
  }

  async readFile(id: string, path: string): Promise<string> {
    const pod = this.requirePod(id);
    const res = await this.runner([
      this.kubectl,
      "-n",
      this.namespace,
      "exec",
      pod,
      "--",
      "cat",
      path,
    ]);
    if (res.exitCode !== 0) {
      throw new Error(
        `readFile(${path}) failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
      );
    }
    return res.stdout;
  }

  async writeFile(id: string, path: string, content: string): Promise<void> {
    const pod = this.requirePod(id);
    const dir = posixDirname(path);
    // Create parent dirs, then stream content over stdin into `cat > file` so
    // arbitrary bytes are not exposed on the process argv.
    const res = await this.runner(
      [
        this.kubectl,
        "-n",
        this.namespace,
        "exec",
        "-i",
        pod,
        "--",
        "sh",
        "-lc",
        `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(path)}`,
      ],
      { stdin: content },
    );
    if (res.exitCode !== 0) {
      throw new Error(
        `writeFile(${path}) failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
      );
    }
  }

  async list(id: string, dir: string): Promise<SandboxFileEntry[]> {
    const pod = this.requirePod(id);
    // `find` prints: <mtime-epoch-seconds> <size-bytes> <path>, one per file.
    const res = await this.runner([
      this.kubectl,
      "-n",
      this.namespace,
      "exec",
      pod,
      "--",
      "sh",
      "-lc",
      `find ${shellQuote(dir)} -type f -printf '%T@ %s %p\\n' 2>/dev/null || true`,
    ]);
    if (res.exitCode !== 0) {
      throw new Error(
        `list(${dir}) failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
      );
    }
    return parseFindOutput(res.stdout);
  }

  async destroy(id: string): Promise<void> {
    // Best-effort delete of the CR; ignore "not found".
    await this.runner([
      this.kubectl,
      "-n",
      this.namespace,
      "delete",
      `sandbox.${API_GROUP}`,
      id,
      "--ignore-not-found",
    ]);
    this.pods.delete(id);
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private buildManifest(
    id: string,
    opts: SandboxCreateOptions,
  ): Record<string, unknown> {
    const image = opts.image ?? this.defaultImage;
    const env = Object.entries(opts.env ?? {}).map(([name, value]) => ({
      name,
      value,
    }));
    return {
      apiVersion: `${API_GROUP}/${API_VERSION}`,
      kind: "Sandbox",
      metadata: {
        name: id,
        namespace: this.namespace,
        labels: { "oma.dev/managed": "true" },
        annotations: opts.metadata ?? {},
      },
      spec: {
        runtimes: [{ name: this.runtimeName }],
        ...(opts.timeoutSeconds
          ? { timeoutSeconds: opts.timeoutSeconds }
          : {}),
        template: {
          spec: {
            containers: [
              {
                name: "sandbox",
                image,
                command: ["tail", "-f", "/dev/null"],
                ...(env.length > 0 ? { env } : {}),
              },
            ],
          },
        },
      },
    };
  }

  private async waitForReady(id: string): Promise<string> {
    const deadline = Date.now() + this.readyTimeoutSeconds * 1000;
    for (;;) {
      const cr = await this.kubectlJson([
        "-n",
        this.namespace,
        "get",
        `sandbox.${API_GROUP}`,
        id,
        "-o",
        "json",
      ]);
      const status = (cr as { status?: Record<string, unknown> }).status ?? {};
      const phase = String((status as { phase?: unknown }).phase ?? "");
      const podInfo =
        (status as { podInfo?: { podName?: string } }).podInfo ?? {};
      if (phase === "Running" && podInfo.podName) {
        return podInfo.podName;
      }
      if (phase === "Failed" || phase === "Terminated") {
        throw new Error(`Sandbox ${id} entered phase ${phase}`);
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Sandbox ${id} not ready after ${this.readyTimeoutSeconds}s (phase=${phase || "Pending"})`,
        );
      }
      await delay(this.readyPollMs);
    }
  }

  private wrapCommand(command: string[], opts?: SandboxExecOptions): string {
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

  private async kubectlJson(
    argv: string[],
    stdin?: string,
  ): Promise<unknown> {
    const res = await this.runner(
      [this.kubectl, ...argv],
      stdin != null ? { stdin } : undefined,
    );
    if (res.exitCode !== 0) {
      throw new Error(
        `kubectl ${argv.join(" ")} failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
      );
    }
    return JSON.parse(res.stdout) as unknown;
  }

  private requirePod(id: string): string {
    const pod = this.pods.get(id);
    if (!pod) {
      throw new Error(`No ready sandbox pod for ${id} (create it first)`);
    }
    return pod;
  }

  private async drain(it: AsyncIterable<SandboxExecChunk>): Promise<void> {
    for await (const _chunk of it) {
      // discard
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function posixDirname(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return idx === 0 ? "/" : ".";
  return path.slice(0, idx);
}

/**
 * Parse `find -printf '%T@ %s %p\n'` output into file entries. `%T@` is a
 * float epoch-seconds; sizes are bytes; paths are absolute.
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

function defaultRunner(_kubectl: string): CommandRunner {
  return (argv, opts) =>
    new Promise<CommandResult>((resolve, reject) => {
      const [cmd, ...args] = argv;
      const child = spawn(cmd, args, {
        stdio: [opts?.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (c: string) => (stdout += c));
      child.stderr?.on("data", (c: string) => (stderr += c));
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      });
      if (opts?.stdin != null) {
        child.stdin?.end(opts.stdin);
      }
    });
}

function defaultStreamRunner(_kubectl: string): StreamRunner {
  return async function* (argv): AsyncIterable<SandboxExecChunk> {
    const [cmd, ...args] = argv;
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    const push = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      queue.push({ stream, text: chunk.toString("utf8") });
      wake();
    };
    child.stdout?.on("data", push("stdout"));
    child.stderr?.on("data", push("stderr"));
    child.on("error", (e) => {
      error = e instanceof Error ? e : new Error(String(e));
      done = true;
      wake();
    });
    child.on("close", () => {
      done = true;
      wake();
    });
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
  };
}
