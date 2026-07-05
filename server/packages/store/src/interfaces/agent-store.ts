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
  system: string;
  runtime: Agent["runtime"];
  tools?: Agent["tools"];
  mcpServers?: Agent["mcpServers"];
  skills?: Agent["skills"];
  sandbox?: Agent["sandbox"];
}

export interface AgentStoreUpdateInput {
  name?: string;
  description?: string;
  model?: string;
  system?: string;
  runtime?: Agent["runtime"];
  tools?: Agent["tools"];
  mcpServers?: Agent["mcpServers"];
  skills?: Agent["skills"];
  sandbox?: Agent["sandbox"];
}

export interface AgentStore {
  create(input: AgentStoreCreateInput): Promise<Agent>;
  getById(id: string): Promise<Agent | null>;
  list(tenantId: string, opts?: AgentStoreListOpts): Promise<PaginatedResult<Agent>>;
  update(id: string, input: AgentStoreUpdateInput): Promise<Agent | null>;
  delete(id: string): Promise<boolean>;
}
