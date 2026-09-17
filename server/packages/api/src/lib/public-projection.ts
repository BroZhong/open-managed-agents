import type { Agent, Session } from "@oma-server/store";
import { publicManagedMcpRefs } from "@oma-server/mcp-catalog";

/** Remove Host-private MCP connection details from an Agent API response. */
export function publicAgent(agent: Agent): Agent {
  return {
    ...agent,
    mcpServers: publicManagedMcpRefs(agent.mcpServers),
  };
}

/** Apply the same projection to the immutable Agent snapshot in a Session. */
export function publicSession(session: Session): Session {
  return {
    ...session,
    agent: publicAgent(session.agent),
  };
}

/** Closed display allowlist: never spread a Session or its Agent snapshot. */
export function sharedSession(session: Session) {
  return {
    id: session.id,
    title: session.title,
    workspaceId: session.workspaceId,
    status: session.status,
    agent: { name: session.agent.name },
    createdAt: session.createdAt,
  };
}
