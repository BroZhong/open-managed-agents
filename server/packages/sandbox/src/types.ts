import type { AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";

export interface CreateOpts {
  image?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface SandboxRef {
  sandboxId: string;
  status: "running" | "paused" | "stopped";
}

export interface SandboxClient {
  create(opts: CreateOpts): Promise<SandboxRef>;
  pause(sandboxId: string): Promise<void>;
  resume(sandboxId: string): Promise<SandboxRef>;
  kill(sandboxId: string): Promise<void>;
  writeFile(sandboxId: string, path: string, content: string): Promise<void>;
  exec(sandboxId: string, command: string[]): AsyncIterable<string>;
}

export interface SandboxOrchestrator {
  createForSession(sessionId: string, opts?: CreateOpts): Promise<SandboxRef>;
  resume(sessionId: string): Promise<SandboxRef>;
  pause(sessionId: string): Promise<void>;
  kill(sessionId: string): Promise<void>;
  runAdapterTurn(
    sessionId: string,
    input: AdapterInput,
  ): AsyncIterable<SessionEvent>;
}
