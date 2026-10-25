import type { Agent, PaginatedResult } from "../types.js";

export interface AgentStoreListOpts {
  limit?: number;
  cursor?: string;
}

export interface AgentStoreCreateInput {
  tenantId: string;
  name: string;
  description?: string;
  model: string;
  thinking?: import("../types.js").ThinkingLevel | null;
  system: string;
  runtime: Agent["runtime"];
  tools?: Agent["tools"];
  mcpServers?: Agent["mcpServers"];
  skills?: Agent["skills"];
  sandbox?: Agent["sandbox"];
  environmentId?: string;
}

export interface AgentStoreUpdateInput {
  name?: string;
  description?: string;
  model?: string;
  thinking?: import("../types.js").ThinkingLevel | null;
  system?: string;
  runtime?: Agent["runtime"];
  tools?: Agent["tools"];
  mcpServers?: Agent["mcpServers"];
  skills?: Agent["skills"];
  sandbox?: Agent["sandbox"];
  /** Null unbinds the Agent's Environment. */
  environmentId?: string | null;
}

export interface AgentStore {
  create(input: AgentStoreCreateInput): Promise<Agent>;
  getById(id: string): Promise<Agent | null>;
  list(tenantId: string, opts?: AgentStoreListOpts): Promise<PaginatedResult<Agent>>;
  update(id: string, input: AgentStoreUpdateInput): Promise<Agent | null>;
  delete(id: string): Promise<boolean>;
  /** Whether any of the Tenant's Agents is bound to the Environment (ADR-0024: it cannot be deleted then). */
  usesEnvironment(tenantId: string, environmentId: string): Promise<boolean>;
}
