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

export interface ClaudeCodeAdapterOptions {
  apiKey: string;
  workDir: string;
  command?: string;
  /** For testing: inject a fake query function */
  _queryFn?: (options: any) => AsyncIterable<any>;
}

export class ClaudeCodeAdapter implements Adapter {
  private readonly apiKey: string;
  private readonly workDir: string;
  private readonly command: string | undefined;
  private readonly queryFn: ((options: any) => AsyncIterable<any>) | undefined;

  constructor(options: ClaudeCodeAdapterOptions) {
    this.apiKey = options.apiKey;
    this.workDir = options.workDir;
    this.command = options.command;
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
        model: input.agent.model,
        systemPrompt,
        permissionMode: "bypassPermissions",
        includePartialMessages: true,
      };

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
    // In production, this would import and use the real SDK.
    // For now, throw if no _queryFn is provided.
    throw new Error(
      "No query function provided. In production, provide the Claude Code SDK query function."
    );
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
