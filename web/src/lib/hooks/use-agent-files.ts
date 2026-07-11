/** The canonical Agent File names, in the order the runtime assembles them. */
export const AGENT_FILE_NAMES = ["IDENTITY", "SOUL", "USER", "MEMORY"] as const;
export type AgentFileName = (typeof AGENT_FILE_NAMES)[number];
