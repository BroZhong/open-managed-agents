import type { AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import type {
  SandboxClient,
  SandboxOrchestrator,
  SandboxRef,
  CreateOpts,
} from "./types.js";

export interface SandboxOrchestratorOptions {
  /**
   * Copy local CLI auth files into the sandbox before running the adapter.
   * Disable with OMA_SANDBOX_SYNC_CLI_AUTH=false when credentials are supplied
   * by another mechanism.
   */
  syncCliAuth?: boolean;
  homeDir?: string;
}

interface CredentialFileMapping {
  sourceRelativePath: string;
  sandboxPath: string;
  transform?: (content: string) => string;
}

export class SandboxOrchestratorImpl implements SandboxOrchestrator {
  private readonly client: SandboxClient;
  private readonly sessionSandboxMap = new Map<string, string>(); // sessionId -> sandboxId
  private readonly syncCliAuth: boolean;
  private readonly homeDir: string;

  constructor(client: SandboxClient, options: SandboxOrchestratorOptions = {}) {
    this.client = client;
    this.syncCliAuth =
      options.syncCliAuth ?? process.env.OMA_SANDBOX_SYNC_CLI_AUTH !== "false";
    this.homeDir = options.homeDir ?? homedir();
  }

  async createForSession(
    sessionId: string,
    opts?: CreateOpts,
  ): Promise<SandboxRef> {
    if (this.sessionSandboxMap.has(sessionId)) {
      throw new Error(`Sandbox already exists for session ${sessionId}`);
    }
    const ref = await this.client.create(opts ?? {});
    this.sessionSandboxMap.set(sessionId, ref.sandboxId);
    return ref;
  }

  async resume(sessionId: string): Promise<SandboxRef> {
    const sandboxId = this.requireSandboxId(sessionId);
    return this.client.resume(sandboxId);
  }

  async pause(sessionId: string): Promise<void> {
    const sandboxId = this.requireSandboxId(sessionId);
    await this.client.pause(sandboxId);
  }

  async kill(sessionId: string): Promise<void> {
    const sandboxId = this.requireSandboxId(sessionId);
    await this.client.kill(sandboxId);
    this.sessionSandboxMap.delete(sessionId);
  }

  async *runAdapterTurn(
    sessionId: string,
    input: AdapterInput,
    runtime?: string,
  ): AsyncIterable<SessionEvent> {
    const sandboxId = this.requireSandboxId(sessionId);
    const resolvedRuntime = runtime || "claude-code";

    await this.stageRuntimeCredentials(sandboxId, resolvedRuntime);

    // Write input to sandbox filesystem (include runtime + adapterOptions for adapter-runner)
    const runnerInput = {
      ...input,
      runtime: resolvedRuntime,
      adapterOptions: this.buildAdapterOptions(resolvedRuntime),
    };
    const inputJson = JSON.stringify(runnerInput);
    await this.client.writeFile(sandboxId, "/tmp/input.json", inputJson);

    // Execute adapter-runner inside sandbox
    const stdout = this.client.exec(sandboxId, [
      "tsx",
      "/app/adapter/packages/runner/src/adapter-runner.ts",
      "/tmp/input.json",
    ]);

    // Parse each stdout line as a SessionEvent
    let buffer = "";
    let sawRunnerError = false;
    try {
      for await (const chunk of stdout) {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) {
            const event = JSON.parse(line) as SessionEvent;
            if (event.type === "session.error") {
              sawRunnerError = true;
            }
            yield event;
          }
        }
      }
    } catch (err) {
      if (!sawRunnerError) {
        throw err;
      }
    }
    // Handle any remaining buffer
    if (buffer.trim()) {
      const event = JSON.parse(buffer) as SessionEvent;
      if (event.type === "session.error") {
        sawRunnerError = true;
      }
      yield event;
    }
  }

  private buildAdapterOptions(runtime: string): Record<string, unknown> {
    switch (runtime) {
      case "claude-code":
        return {
          apiKey: process.env.ANTHROPIC_API_KEY || "",
          workDir: "/workspace",
        };
      case "codex":
        return {
          sandbox: "danger-full-access",
        };
      default:
        return {};
    }
  }

  private async stageRuntimeCredentials(
    sandboxId: string,
    runtime: string,
  ): Promise<void> {
    if (!this.syncCliAuth) return;

    const mappings = this.getCredentialFileMappings(runtime);
    if (mappings.length === 0) return;

    const files: Array<{ path: string; content: string }> = [];
    for (const mapping of mappings) {
      const sourcePath = join(this.homeDir, mapping.sourceRelativePath);
      try {
        const content = await readFile(sourcePath, "utf-8");
        files.push({
          path: mapping.sandboxPath,
          content: mapping.transform ? mapping.transform(content) : content,
        });
      } catch (err: unknown) {
        if (this.isMissingFile(err)) continue;
        throw err;
      }
    }

    if (files.length === 0) return;

    const dirs = Array.from(
      new Set(files.map((file) => posix.dirname(file.path))),
    );
    await this.drainExec(
      sandboxId,
      ["sh", "-lc", `mkdir -p ${dirs.map(shellQuote).join(" ")}`],
    );

    for (const file of files) {
      await this.client.writeFile(sandboxId, file.path, file.content);
    }

    await this.drainExec(
      sandboxId,
      ["sh", "-lc", `chmod 600 ${files.map((file) => shellQuote(file.path)).join(" ")}`],
    );
  }

  private getCredentialFileMappings(runtime: string): CredentialFileMapping[] {
    switch (runtime) {
      case "codex":
        return [
          { sourceRelativePath: ".codex/auth.json", sandboxPath: "/root/.codex/auth.json" },
          { sourceRelativePath: ".codex/config.toml", sandboxPath: "/root/.codex/config.toml" },
        ];
      case "claude-code":
        return [
          { sourceRelativePath: ".claude.json", sandboxPath: "/root/.claude.json" },
          { sourceRelativePath: ".claude/settings.json", sandboxPath: "/root/.claude/settings.json" },
          { sourceRelativePath: ".claude/settings.local.json", sandboxPath: "/root/.claude/settings.local.json" },
        ];
      case "pi-agent":
        return [
          { sourceRelativePath: ".pi/agent/auth.json", sandboxPath: "/root/.pi/agent/auth.json" },
          {
            sourceRelativePath: ".pi/agent/settings.json",
            sandboxPath: "/root/.pi/agent/settings.json",
            transform: sanitizePiSettings,
          },
          { sourceRelativePath: ".pi/agent/models.json", sandboxPath: "/root/.pi/agent/models.json" },
        ];
      default:
        return [];
    }
  }

  private async drainExec(
    sandboxId: string,
    command: string[],
  ): Promise<void> {
    for await (const _chunk of this.client.exec(sandboxId, command)) {
      // Intentionally discard command output so auth material is never logged.
    }
  }

  private isMissingFile(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    );
  }

  private requireSandboxId(sessionId: string): string {
    const sandboxId = this.sessionSandboxMap.get(sessionId);
    if (!sandboxId) {
      throw new Error(`No sandbox found for session ${sessionId}`);
    }
    return sandboxId;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sanitizePiSettings(content: string): string {
  const settings = JSON.parse(content) as Record<string, unknown>;
  const {
    packages: _packages,
    extensions: _extensions,
    skills: _skills,
    ...portableSettings
  } = settings;
  return `${JSON.stringify(portableSettings, null, 2)}\n`;
}
