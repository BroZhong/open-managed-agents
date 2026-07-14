export const MCP_GATEWAY_TOOL_NAME = "mcp";

export interface McpInvocation {
  serverName: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * pi-mcp-adapter exposes remote tools through one generic `mcp` tool. It
 * replaces hyphens in server names with underscores when it builds the remote
 * tool identifier; underscores already present in a server name stay intact.
 */
export function mcpGatewayToolName(
  serverName: string,
  remoteToolName: string,
): string {
  return `${normalizedServerPrefix(serverName)}_${remoteToolName}`;
}

/** Build the arguments Pi expects when replaying a canonical MCP tool call. */
export function mcpGatewayArguments(
  serverName: string,
  remoteToolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tool: mcpGatewayToolName(serverName, remoteToolName),
    args: JSON.stringify(input),
    server: serverName,
  };
}

/**
 * Recognize a real remote invocation made through pi-mcp-adapter's generic
 * `mcp` gateway. Discovery/status operations are local gateway calls and stay
 * ordinary tool events; only calls carrying a concrete `tool` are canonical
 * MCP events.
 */
export function identifyMcpInvocation(
  toolName: string,
  gatewayInput: Record<string, unknown>,
  configuredServers: readonly string[],
): McpInvocation | undefined {
  if (toolName !== MCP_GATEWAY_TOOL_NAME) return undefined;

  // pi-mcp-adapter handles these local actions before its `tool` branch. A
  // model may still populate both optional fields, so mirror that precedence
  // or the canonical audit log would claim a remote call that never happened.
  if (
    gatewayInput.action === "ui-messages"
    || gatewayInput.action === "auth-start"
    || gatewayInput.action === "auth-complete"
  ) {
    return undefined;
  }

  const requestedTool = gatewayInput.tool;
  if (typeof requestedTool !== "string" || requestedTool.trim() === "") {
    return undefined;
  }

  const explicitServer =
    typeof gatewayInput.server === "string" && gatewayInput.server.trim() !== ""
      ? gatewayInput.server.trim()
      : undefined;
  const inferredServer = [...configuredServers]
    .sort(
      (a, b) =>
        normalizedServerPrefix(b).length - normalizedServerPrefix(a).length,
    )
    .find((serverName) =>
      requestedTool.startsWith(`${normalizedServerPrefix(serverName)}_`),
    );
  const serverName =
    explicitServer ??
    inferredServer ??
    (configuredServers.length === 1 ? configuredServers[0] : "unknown");
  const prefix = `${normalizedServerPrefix(serverName)}_`;
  const name = requestedTool.startsWith(prefix)
    ? requestedTool.slice(prefix.length)
    : requestedTool;

  return {
    serverName,
    name,
    input: parseGatewayArguments(gatewayInput.args),
  };
}

function normalizedServerPrefix(serverName: string): string {
  return serverName.replace(/-/g, "_");
}

function parseGatewayArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asRecord(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
