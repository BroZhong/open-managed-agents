import type {
  Adapter,
  AdapterInput,
  SessionEvent,
  McpServerConfig,
} from "@open-managed-agents/adapter-core";
import {
  generateEventId,
  generateTimestamp,
} from "@open-managed-agents/adapter-core";
import { eventsToSessionFile } from "./session-file.js";
import { SdkEventTranslator } from "./translator.js";
import type { SdkMessage } from "./sdk-types.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface ClaudeCodeAdapterOptions {
  apiKey: string;
  workDir: string;
  command?: string;
  permissionMode?: string;
  /** For testing: inject a fake query function */
  _queryFn?: (options: any) => AsyncIterable<any>;
}

export class ClaudeCodeAdapter implements Adapter {
  private readonly apiKey: string;
  private readonly workDir: string;
  private readonly command: string | undefined;
  private readonly permissionMode: string;
  private readonly queryFn: ((options: any) => AsyncIterable<any>) | undefined;

  constructor(options: ClaudeCodeAdapterOptions) {
    this.apiKey = options.apiKey;
    this.workDir = options.workDir;
    this.command = options.command;
    this.permissionMode = options.permissionMode ?? "acceptEdits";
    this.queryFn = options._queryFn;
  }

  async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
    // 1. Yield session.status_running
    yield {
      id: generateEventId(),
      timestamp: generateTimestamp(),
      type: "session.status_running",
    };

    try {
      // 2. Convert input.history -> session file
      await eventsToSessionFile(input.history, input.sessionId, this.workDir);

      // 3. Build query options
      const systemPrompt = this.buildSystemPrompt(input);
      const prompt = this.extractPromptText(input);

      const queryOptions: Record<string, unknown> = {
        prompt,
        resume: input.sessionId,
        systemPrompt,
        permissionMode: this.permissionMode,
        includePartialMessages: true,
      };
      if (input.agent.model && input.agent.model !== "default") {
        queryOptions.model = input.agent.model;
      }

      if (input.agent.mcpServers && input.agent.mcpServers.length > 0) {
        queryOptions.mcpServers = input.agent.mcpServers;
      }

      // Set up abort controller for timeout
      let abortController: AbortController | undefined;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      if (input.constraints?.timeoutSeconds != null) {
        abortController = new AbortController();
        queryOptions.abortSignal = abortController.signal;
        timeoutId = setTimeout(() => {
          abortController!.abort();
        }, input.constraints.timeoutSeconds * 1000);
      }

      try {
        // 4. Call query function and pipe through translator
        const queryFn = this.getQueryFn();
        const stream = queryFn(queryOptions);
        const translator = new SdkEventTranslator(input.turnId);

        for await (const message of stream) {
          const events = translator.processMessage(message as SdkMessage);
          for (const event of events) {
            yield event;
          }
        }

        // Finalize translator
        const finalEvents = translator.finalize();
        for (const event of finalEvents) {
          yield event;
        }

        // 5. On success: yield session.status_idle
        yield {
          id: generateEventId(),
          timestamp: generateTimestamp(),
          type: "session.status_idle",
        };
      } finally {
        // Clear timeout
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
    } catch (error: unknown) {
      // 6. On error: yield session.error
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorCode = this.classifyError(error);

      yield {
        id: generateEventId(),
        timestamp: generateTimestamp(),
        type: "session.error",
        error: {
          message: errorMessage,
          code: errorCode,
        },
      };
    }
  }

  private buildSystemPrompt(input: AdapterInput): string {
    const parts: string[] = [input.agent.system];

    if (input.agent.skills && input.agent.skills.length > 0) {
      parts.push(...input.agent.skills);
    }

    return parts.join("\n");
  }

  private extractPromptText(input: AdapterInput): string {
    return input.message.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { type: "text"; text: string }).text)
      .join("");
  }

  private getQueryFn(): (options: any) => AsyncIterable<any> {
    if (this.queryFn) {
      return this.queryFn;
    }
    // Fallback: spawn `claude` CLI and translate stream-json output to SdkMessage-like objects
    return (options: any) => this.cliQuery(options);
  }

  private async *cliQuery(options: any): AsyncIterable<any> {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", options.permissionMode || "bypassPermissions",
      "-p", options.prompt,
    ];
    if (options.model) args.push("--model", options.model);
    if (options.systemPrompt) args.push("--system-prompt", options.systemPrompt);
    if (options.resume) {
      const sessionUuid = sessionIdToUuid(String(options.resume));
      const projectKey = this.workDir.replace(/\//g, "-");
      const sessionFile = join(
        process.env.HOME || homedir(),
        ".claude",
        "projects",
        projectKey,
        `${sessionUuid}.jsonl`,
      );
      args.push(...(existsSync(sessionFile)
        ? ["--resume", sessionUuid]
        : ["--session-id", sessionUuid]));
    }

    const cmd = this.command || "claude";
    const env = { ...process.env };
    if (this.apiKey) {
      env.ANTHROPIC_API_KEY = this.apiKey;
    } else {
      delete env.ANTHROPIC_API_KEY;
    }
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.workDir,
      env,
    });
    child.stdin.end();

    const rl = createInterface({ input: child.stdout });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "assistant" && event.message) {
          yield* this.claudeCliMessageToSdkMessages(event.message);
        } else if (event.type === "user" && event.message?.content) {
          yield* this.claudeCliUserMessageToSdkMessages(event.message);
        }
      } catch {}
    }

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code !== 0) {
          const details = stderr.trim();
          reject(
            new Error(
              details
                ? `claude CLI exited with code ${code}: ${details}`
                : `claude CLI exited with code ${code}`,
            ),
          );
        } else {
          resolve();
        }
      });
      child.on("error", reject);
    });
  }

  private async *claudeCliMessageToSdkMessages(message: any): AsyncIterable<any> {
    yield {
      type: "message_start",
      message: {
        id: message.id ?? generateEventId(),
        model: message.model ?? "claude",
      },
    };

    for (let index = 0; index < (message.content?.length ?? 0); index++) {
      const block = message.content[index];
      if (block.type === "text") {
        yield {
          type: "content_block_start",
          index,
          content_block: { type: "text" },
        };
        yield {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text ?? "" },
        };
        yield { type: "content_block_stop", index };
      } else if (block.type === "thinking") {
        yield {
          type: "content_block_start",
          index,
          content_block: { type: "thinking" },
        };
        yield {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: block.thinking ?? "" },
        };
        yield { type: "content_block_stop", index };
      } else if (block.type === "tool_use") {
        yield {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
          },
        };
        yield {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input ?? {}),
          },
        };
        yield { type: "content_block_stop", index };
      }
    }

    if (message.usage) {
      yield {
        type: "message_delta",
        delta: { stop_reason: message.stop_reason ?? "end_turn" },
        usage: { output_tokens: message.usage.output_tokens ?? 0 },
      };
    }
    yield { type: "message_stop" };
  }

  private async *claudeCliUserMessageToSdkMessages(message: any): AsyncIterable<any> {
    for (const block of message.content ?? []) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const content = typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content ?? "");
      yield {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content,
        is_error: block.is_error,
      };
    }
  }

  private classifyError(error: unknown): string {
    if (error instanceof Error) {
      if (error.name === "AbortError" || error.message.includes("abort")) {
        return "timeout";
      }
    }
    return "sdk_error";
  }
}

function sessionIdToUuid(sessionId: string): string {
  const hash = createHash("md5").update(sessionId).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
