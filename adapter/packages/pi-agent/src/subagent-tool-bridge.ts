import type {
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const MANAGED_SUBAGENT_TOOLS_REQUEST = "oma:sandbox-tools:v1:get";

const REQUIRED_TOOL_NAMES = [
  "bash",
  "read",
  "write",
  "edit",
  "ls",
  "grep",
  "find",
] as const;

function assertCompleteToolSet(tools: ToolDefinition[]): void {
  const names = new Set(tools.map((tool) => tool.name));
  const missing = REQUIRED_TOOL_NAMES.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Missing managed Sandbox tools for subagents: ${missing.join(", ")}`,
    );
  }
}

/**
 * Publish one Turn's exact Sandbox-backed custom ToolDefinitions on the
 * resource loader's own ExtensionAPI event bus. Every DefaultResourceLoader in
 * the Adapter gets a fresh event bus, so concurrent parents cannot address one
 * another's capability. The request/reply shape mirrors the named extension's
 * own cross-extension RPC convention while passing definitions by reference in
 * this single process.
 */
export function createManagedSubagentToolsExtension(
  tools: ToolDefinition[],
): ExtensionFactory {
  assertCompleteToolSet(tools);

  return (pi) => {
    const unsubscribe = pi.events.on(MANAGED_SUBAGENT_TOOLS_REQUEST, (raw) => {
      const requestId =
        raw && typeof raw === "object"
          ? (raw as { requestId?: unknown }).requestId
          : undefined;
      if (
        typeof requestId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)
      ) {
        return;
      }
      pi.events.emit(
        `${MANAGED_SUBAGENT_TOOLS_REQUEST}:reply:${requestId}`,
        { tools },
      );
    });

    pi.on("session_shutdown", () => {
      unsubscribe();
    });
  };
}
