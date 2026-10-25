import type { Agent, Session, Skill } from "@oma-server/store";
import { publicManagedMcpRefs } from "@oma-server/mcp-catalog";

/** Remove Host-private MCP connection details from an Agent API response. */
export function publicAgent(agent: Agent): Agent {
  return {
    ...agent,
    mcpServers: publicManagedMcpRefs(agent.mcpServers),
  };
}

/**
 * Apply the same projection to the immutable Agent snapshot in a Session,
 * and show the Environment it is frozen to by id and name (ADR-0024).
 */
export function publicSession(session: Session, environment: { id: string; name: string } | null) {
  const { environmentId: _frozen, ...rest } = session;
  return {
    ...rest,
    agent: publicAgent(session.agent),
    environment,
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

/** The documented Skill shape; storage coordinates (the current Skill Bundle) stay Host-private. */
export function publicSkill(skill: Skill) {
  return {
    id: skill.id,
    tenantId: skill.tenantId,
    name: skill.name,
    description: skill.description,
    ownerType: skill.ownerType,
    ownerId: skill.ownerId,
    sourceSkillId: skill.sourceSkillId,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}
