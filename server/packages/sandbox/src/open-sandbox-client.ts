import {
  ConnectionConfig,
  Sandbox as OpenSandbox,
  type ConnectionConfigOptions,
  type ConnectionProtocol,
  type ServerStreamEvent,
} from "@alibaba-group/opensandbox";
import type { CreateOpts, SandboxClient, SandboxRef } from "./types.js";

const DEFAULT_IMAGE = "open-managed-agents/sandbox:latest";
const DEFAULT_TIMEOUT_SECONDS = 60 * 60;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 5 * 60;
const DEFAULT_READY_TIMEOUT_SECONDS = 120;
const DEFAULT_HEALTH_CHECK_POLLING_INTERVAL_MS = 500;

export interface OpenSandboxClientOptions {
  domain?: string;
  url?: string;
  protocol?: ConnectionProtocol;
  apiKey?: string;
  requestTimeoutSeconds?: number;
  useServerProxy?: boolean;
  defaultImage?: string;
  defaultTimeoutSeconds?: number;
  commandTimeoutSeconds?: number;
  readyTimeoutSeconds?: number;
  healthCheckPollingIntervalMs?: number;
  resource?: Record<string, string>;
}

function readBoolEnv(name: string): boolean | undefined {
  const value = process.env[name];
  if (value == null || value === "") return undefined;
  return value === "1" || value.toLowerCase() === "true";
}

function buildConnectionConfig(
  options: OpenSandboxClientOptions,
): ConnectionConfig {
  const connectionOptions: ConnectionConfigOptions = {
    domain:
      options.url ??
      options.domain ??
      process.env.OPENSANDBOX_URL ??
      process.env.OPEN_SANDBOX_DOMAIN,
    protocol: options.protocol,
    apiKey:
      options.apiKey ??
      process.env.OPEN_SANDBOX_API_KEY ??
      process.env.OPENSANDBOX_API_KEY,
    requestTimeoutSeconds: options.requestTimeoutSeconds ?? 180,
    useServerProxy:
      options.useServerProxy ??
      readBoolEnv("OPENSANDBOX_USE_SERVER_PROXY") ??
      readBoolEnv("OPEN_SANDBOX_USE_SERVER_PROXY"),
  };
  return new ConnectionConfig(connectionOptions);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandToShell(command: string[]): string {
  return command.map(shellQuote).join(" ");
}

function parseExecutionError(event: ServerStreamEvent): {
  message: string;
  exitCode: number | null;
} | null {
  const error = event.error;
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const name = String(record.ename ?? record.name ?? "CommandExecError");
  const value = String(record.evalue ?? record.value ?? "");
  const parsed = /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : null;
  return {
    message: value ? `${name}: ${value}` : name,
    exitCode: parsed,
  };
}

export class OpenSandboxClient implements SandboxClient {
  private readonly connectionConfig: ConnectionConfig;
  private readonly defaultImage: string;
  private readonly defaultTimeoutSeconds: number;
  private readonly commandTimeoutSeconds: number;
  private readonly readyTimeoutSeconds: number;
  private readonly healthCheckPollingIntervalMs: number;
  private readonly resource: Record<string, string> | undefined;
  private readonly sandboxes = new Map<string, OpenSandbox>();

  constructor(options: OpenSandboxClientOptions = {}) {
    this.connectionConfig = buildConnectionConfig(options);
    this.defaultImage =
      options.defaultImage ??
      process.env.OMA_SANDBOX_IMAGE ??
      process.env.OPENSANDBOX_SANDBOX_IMAGE ??
      DEFAULT_IMAGE;
    this.defaultTimeoutSeconds =
      options.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.commandTimeoutSeconds =
      options.commandTimeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;
    this.readyTimeoutSeconds =
      options.readyTimeoutSeconds ?? DEFAULT_READY_TIMEOUT_SECONDS;
    this.healthCheckPollingIntervalMs =
      options.healthCheckPollingIntervalMs ??
      DEFAULT_HEALTH_CHECK_POLLING_INTERVAL_MS;
    this.resource = options.resource;
  }

  async create(opts: CreateOpts): Promise<SandboxRef> {
    const sandbox = await OpenSandbox.create({
      connectionConfig: this.connectionConfig,
      image: opts.image ?? this.defaultImage,
      timeoutSeconds: opts.timeoutSeconds ?? this.defaultTimeoutSeconds,
      entrypoint: opts.entrypoint ?? ["tail", "-f", "/dev/null"],
      env: opts.env ?? {},
      metadata: opts.metadata ?? {},
      resource: opts.resource ?? this.resource,
      readyTimeoutSeconds:
        opts.readyTimeoutSeconds ?? this.readyTimeoutSeconds,
      healthCheckPollingInterval: this.healthCheckPollingIntervalMs,
    });
    this.sandboxes.set(sandbox.id, sandbox);
    return { sandboxId: sandbox.id, status: "running" };
  }

  async pause(sandboxId: string): Promise<void> {
    const sandbox = this.requireSandbox(sandboxId);
    await sandbox.pause();
  }

  async resume(sandboxId: string): Promise<SandboxRef> {
    const current = this.sandboxes.get(sandboxId);
    const sandbox = current
      ? await current.resume({
          readyTimeoutSeconds: this.readyTimeoutSeconds,
          healthCheckPollingInterval: this.healthCheckPollingIntervalMs,
        })
      : await OpenSandbox.resume({
          sandboxId,
          connectionConfig: this.connectionConfig,
          readyTimeoutSeconds: this.readyTimeoutSeconds,
          healthCheckPollingInterval: this.healthCheckPollingIntervalMs,
        });

    this.sandboxes.set(sandboxId, sandbox);
    return { sandboxId, status: "running" };
  }

  async kill(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    this.sandboxes.delete(sandboxId);
    if (!sandbox) return;

    try {
      await sandbox.kill();
    } finally {
      await sandbox.close().catch(() => undefined);
    }
  }

  async writeFile(
    sandboxId: string,
    path: string,
    content: string,
  ): Promise<void> {
    const sandbox = this.requireSandbox(sandboxId);
    await sandbox.files.writeFiles([{ path, data: content, mode: 0o644 }]);
  }

  async *exec(
    sandboxId: string,
    command: string[],
  ): AsyncIterable<string> {
    const sandbox = this.requireSandbox(sandboxId);
    const shellCommand = commandToShell(command);
    let executionError: string | undefined;
    let exitCode: number | null = 0;

    try {
      for await (const event of sandbox.commands.runStream(shellCommand, {
        timeoutSeconds: this.commandTimeoutSeconds,
        workingDirectory: "/workspace",
      })) {
        if (event.type === "stdout" && typeof event.text === "string") {
          yield event.text.endsWith("\n") ? event.text : `${event.text}\n`;
        } else if (event.type === "stderr" && typeof event.text === "string") {
          executionError = executionError
            ? `${executionError}\n${event.text}`
            : event.text;
        } else if (event.type === "error") {
          const parsed = parseExecutionError(event);
          if (parsed) {
            executionError = executionError
              ? `${executionError}\n${parsed.message}`
              : parsed.message;
            exitCode = parsed.exitCode;
          } else {
            executionError = executionError ?? "Command execution failed";
            exitCode = null;
          }
        } else if (event.type === "execution_complete") {
          exitCode = exitCode ?? 0;
        }
      }
    } catch (err) {
      throw new Error(formatExecStreamError(err), { cause: err });
    }

    if (exitCode !== 0) {
      const suffix = executionError ? `: ${executionError}` : "";
      throw new Error(`Command exited with code ${exitCode ?? "unknown"}${suffix}`);
    }
  }

  private requireSandbox(sandboxId: string): OpenSandbox {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`No OpenSandbox instance found for ${sandboxId}`);
    }
    return sandbox;
  }
}

function formatExecStreamError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const details: string[] = [];
  if (typeof err === "object" && err !== null) {
    const record = err as Record<string, unknown>;
    if (typeof record.statusCode === "number") {
      details.push(`status=${record.statusCode}`);
    }
    if (typeof record.requestId === "string" && record.requestId) {
      details.push(`requestId=${record.requestId}`);
    }
    if (typeof record.rawBody === "string" && record.rawBody) {
      details.push(`body=${record.rawBody}`);
    }
  }
  return details.length > 0 ? `${message} (${details.join(", ")})` : message;
}
