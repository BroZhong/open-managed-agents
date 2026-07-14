import type {
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const MANAGED_SUBAGENT_TOOLS_REQUEST = "oma:sandbox-tools:v1:get";
export const MANAGED_SUBAGENT_USAGE_EVENT = "oma:subagent-usage:v1";

export interface ManagedSubagentUsage {
  subagentId?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

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

function parseManagedSubagentUsage(raw: unknown): ManagedSubagentUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const candidate = raw as Record<string, unknown>;
  if (
    candidate.subagentId !== undefined &&
    typeof candidate.subagentId !== "string"
  ) {
    return undefined;
  }
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const value = candidate[field];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      return undefined;
    }
  }

  return {
    ...(candidate.subagentId === undefined
      ? {}
      : { subagentId: candidate.subagentId }),
    input: candidate.input as number,
    output: candidate.output as number,
    cacheRead: candidate.cacheRead as number,
    cacheWrite: candidate.cacheWrite as number,
  };
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
    const unsubscribeTools = pi.events.on(MANAGED_SUBAGENT_TOOLS_REQUEST, (raw) => {
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
      unsubscribeTools();
    });
  };
}

/**
 * Forward child model usage from this resource loader's private EventBus.
 * This stays a separate extension from the tool responder so accounting has a
 * single responsibility, but the adapter installs both only when the current
 * run has the managed tools required for child creation.
 */
export function createManagedSubagentUsageExtension(
  onUsage: (usage: ManagedSubagentUsage) => void,
): ExtensionFactory {
  return (pi) => {
    const unsubscribe = pi.events.on(MANAGED_SUBAGENT_USAGE_EVENT, (raw) => {
      const usage = parseManagedSubagentUsage(raw);
      if (usage) onUsage(usage);
    });

    pi.on("session_shutdown", () => {
      unsubscribe();
    });
  };
}
