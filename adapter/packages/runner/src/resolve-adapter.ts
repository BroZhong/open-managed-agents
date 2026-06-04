import type { Adapter } from "@open-managed-agents/adapter-core";

export async function resolveAdapter(
  runtime: string,
  adapterOptions?: Record<string, unknown>,
): Promise<Adapter> {
  switch (runtime) {
    case "mock": {
      const { MockAdapter } = await import(
        "@open-managed-agents/adapter-mock"
      );
      return new MockAdapter(adapterOptions as any);
    }
    case "claude-code": {
      const { ClaudeCodeAdapter } = await import(
        "@open-managed-agents/adapter-claude-code"
      );
      return new ClaudeCodeAdapter(adapterOptions as any);
    }
    case "codex": {
      const { CodexAdapter } = await import(
        "@open-managed-agents/adapter-codex"
      );
      return new CodexAdapter(adapterOptions as any);
    }
    case "pi-agent": {
      const { PiAgentAdapter } = await import(
        "@open-managed-agents/adapter-pi-agent"
      );
      return new PiAgentAdapter(adapterOptions as any);
    }
    default:
      throw new Error(`Unknown runtime: ${runtime}`);
  }
}
