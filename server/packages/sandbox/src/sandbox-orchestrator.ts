import type { AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";
import type {
  SandboxClient,
  SandboxOrchestrator,
  SandboxRef,
  CreateOpts,
} from "./types.js";

export class SandboxOrchestratorImpl implements SandboxOrchestrator {
  private readonly client: SandboxClient;
  private readonly sessionSandboxMap = new Map<string, string>(); // sessionId -> sandboxId

  constructor(client: SandboxClient) {
    this.client = client;
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
  ): AsyncIterable<SessionEvent> {
    const sandboxId = this.requireSandboxId(sessionId);

    // Write input to sandbox filesystem
    const inputJson = JSON.stringify(input);
    await this.client.writeFile(sandboxId, "/tmp/input.json", inputJson);

    // Execute adapter-runner inside sandbox
    const stdout = this.client.exec(sandboxId, [
      "node",
      "adapter-runner.js",
      "/tmp/input.json",
    ]);

    // Parse each stdout line as a SessionEvent
    let buffer = "";
    for await (const chunk of stdout) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          yield JSON.parse(line) as SessionEvent;
        }
      }
    }
    // Handle any remaining buffer
    if (buffer.trim()) {
      yield JSON.parse(buffer) as SessionEvent;
    }
  }

  private requireSandboxId(sessionId: string): string {
    const sandboxId = this.sessionSandboxMap.get(sessionId);
    if (!sandboxId) {
      throw new Error(`No sandbox found for session ${sessionId}`);
    }
    return sandboxId;
  }
}
