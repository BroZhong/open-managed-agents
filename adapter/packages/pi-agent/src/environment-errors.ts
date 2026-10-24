import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ToolEnvironmentError } from "@open-managed-agents/adapter-core";

/**
 * Environment failures of the Turn's executor reach the model as tool errors
 * that say so (ADR-0023). Pi turns a tool's rejection into an error result
 * whose details are empty: the call that failed this way is noted here, and
 * the `tool_result` hook gives its result the error's `code` and details,
 * which the native toolResult entry, and so the Session's events, keep. Any
 * other rejection stays the tool's own error, unchanged.
 */
export class ToolEnvironmentErrors {
  private readonly failed = new Map<string, Record<string, string>>();

  /** `tool`, with the environment failures of its calls noted for their results. */
  readonly wrap = (tool: ToolDefinition): ToolDefinition => ({
    ...tool,
    execute: async (toolCallId, ...rest) => {
      try { return await tool.execute(toolCallId, ...rest); }
      catch (error) {
        if (error instanceof ToolEnvironmentError) this.failed.set(toolCallId, { ...error.details, code: error.code });
        throw error;
      }
    },
  });

  readonly extension: ExtensionFactory = pi => {
    pi.on("tool_result", event => {
      const details = this.failed.get(event.toolCallId);
      if (!details) return undefined;
      this.failed.delete(event.toolCallId);
      return { details: { ...(event.details as object | undefined), ...details }, isError: true };
    });
  };
}
