import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  Adapter,
  AdapterInput,
  SessionEvent,
} from "@open-managed-agents/adapter-core";
import {
  generateEventId,
  generateTimestamp,
} from "@open-managed-agents/adapter-core";
import type { PiCliEvent } from "./cli-types.js";
import { PiEventTranslator } from "./translator.js";

export interface PiAgentAdapterOptions {
  model?: string;
  command?: string;
  /** For testing: inject a fake event source */
  _eventSource?: (prompt: string, options: any) => AsyncIterable<PiCliEvent>;
}

export class PiAgentAdapter implements Adapter {
  private readonly model: string | undefined;
  private readonly command: string;
  private readonly eventSource:
    | ((prompt: string, options: any) => AsyncIterable<PiCliEvent>)
    | undefined;

  constructor(options?: PiAgentAdapterOptions) {
    this.model = options?.model;
    this.command = options?.command ?? "pi";
    this.eventSource = options?._eventSource;
  }

  async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
    yield {
      id: generateEventId(),
      timestamp: generateTimestamp(),
      type: "session.status_running",
    } as SessionEvent;

    try {
      const prompt = input.message.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");

      const translator = new PiEventTranslator();
      const source = this.eventSource
        ? this.eventSource(prompt, { model: this.model ?? input.agent.model })
        : this.spawnPi(prompt, input);

      for await (const event of source) {
        const translatedEvents = translator.processEvent(event);
        for (const e of translatedEvents) yield e;
      }

      yield {
        id: generateEventId(),
        timestamp: generateTimestamp(),
        type: "session.status_idle",
      } as SessionEvent;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      yield {
        id: generateEventId(),
        timestamp: generateTimestamp(),
        type: "session.error",
        error: { message: msg, code: "pi_agent_error" },
      } as SessionEvent;
    }
  }

  private async *spawnPi(
    prompt: string,
    input: AdapterInput
  ): AsyncIterable<PiCliEvent> {
    const args = ["--print", "--mode", "json", "-p", prompt, "--no-session"];

    const model = this.model ?? input.agent.model;
    if (model) {
      args.push("--model", model);
    }

    const child = spawn(this.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

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
          const event = JSON.parse(line) as PiCliEvent;
          yield event;
        } catch {
          // skip unparseable lines
        }
      }

      await new Promise<void>((resolve, reject) => {
        child.on("close", (code) => {
          if (code !== 0 && code !== null) {
            reject(new Error(`pi exited with code ${code}`));
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
