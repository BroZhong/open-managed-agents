import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  Adapter,
  AdapterInput,
  SessionEvent,
} from "@open-managed-agents/adapter-core";
import {
  buildPromptWithHistory,
  generateEventId,
  generateTimestamp,
} from "@open-managed-agents/adapter-core";
import type { CodexCliEvent } from "./cli-types.js";
import { CodexEventTranslator } from "./translator.js";

export interface CodexAdapterOptions {
  model?: string;
  command?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  skipGitRepoCheck?: boolean;
  /** For testing: inject a fake event source */
  _eventSource?: (
    prompt: string,
    options: any
  ) => AsyncIterable<CodexCliEvent>;
}

export class CodexAdapter implements Adapter {
  private readonly model: string | undefined;
  private readonly command: string;
  private readonly sandbox: string;
  private readonly skipGitRepoCheck: boolean;
  private readonly eventSource:
    | ((prompt: string, options: any) => AsyncIterable<CodexCliEvent>)
    | undefined;

  constructor(options?: CodexAdapterOptions) {
    this.model = options?.model;
    this.command = options?.command ?? "codex";
    this.sandbox = options?.sandbox ?? "danger-full-access";
    this.skipGitRepoCheck = options?.skipGitRepoCheck ?? true;
    this.eventSource = options?._eventSource;
  }

  async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
    // Lifecycle events (session.status_running / session.status_idle) are owned
    // solely by the Host router, which persists exactly one of each per turn
    // (issue #83). The adapter yields only real content/errors.
    try {
      const rawPrompt = input.message.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");
      const prompt = buildPromptWithHistory(rawPrompt, input.history);

      const translator = new CodexEventTranslator();
      const source = this.eventSource
        ? this.eventSource(prompt, { model: this.model ?? input.agent.model })
        : this.spawnCodex(prompt, input);

      for await (const event of source) {
        if (event.type === "turn.failed" || event.type === "error") {
          const translatedEvents = translator.processEvent(event);
          for (const e of translatedEvents) yield e;

          const errorMsg =
            event.type === "turn.failed"
              ? event.error.message
              : event.message;
          yield {
            id: generateEventId(),
            timestamp: generateTimestamp(),
            type: "session.error",
            error: { message: errorMsg, code: "codex_error" },
          } as SessionEvent;
          return;
        }

        const translatedEvents = translator.processEvent(event);
        for (const e of translatedEvents) yield e;
      }
      // No session.status_idle yield — the Host router owns the single idle
      // emission for the turn (issue #83).
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      yield {
        id: generateEventId(),
        timestamp: generateTimestamp(),
        type: "session.error",
        error: { message: msg, code: "codex_error" },
      } as SessionEvent;
    }
  }

  private async *spawnCodex(
    prompt: string,
    input: AdapterInput
  ): AsyncIterable<CodexCliEvent> {
    const args = ["exec", "--json"];

    const model = this.model ?? input.agent.model;
    if (model) {
      if (model !== "default") {
        args.push("-m", model);
      }
    }

    args.push("-s", this.sandbox);
    if (this.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }

    if (input.constraints?.timeoutSeconds) {
      args.push(
        "-c",
        `timeout_seconds=${input.constraints.timeoutSeconds}`
      );
    }

    args.push(prompt);

    const child = spawn(this.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    // Close stdin immediately so codex doesn't wait for input
    child.stdin.end();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (input.constraints?.timeoutSeconds) {
      timeoutId = setTimeout(() => {
        child.kill("SIGTERM");
      }, input.constraints.timeoutSeconds * 1000);
    }

    const rl = createInterface({ input: child.stdout });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as CodexCliEvent;
          yield event;
        } catch {
          // skip unparseable lines
        }
      }

      await new Promise<void>((resolve, reject) => {
        child.on("close", (code) => {
          if (code !== 0 && code !== null) {
            reject(new Error(`codex exited with code ${code}`));
          } else {
            resolve();
          }
        });
        child.on("error", reject);
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}
