import type { AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";

export interface CreateOpts {
  image?: string;
  timeoutSeconds?: number;
}

export interface SandboxRef {
  sandboxId: string;
  sessionId: string;
  status: "running" | "paused" | "killed";
}

export interface SandboxOrchestrator {
  createForSession(sessionId: string, opts?: CreateOpts): Promise<SandboxRef>;
  resume(sessionId: string): Promise<SandboxRef>;
  pause(sessionId: string): Promise<void>;
  kill(sessionId: string): Promise<void>;
  runAdapterTurn(sessionId: string, input: AdapterInput): AsyncIterable<SessionEvent>;
}
