import type { Agent, PaginatedResult } from "../types.js";

export interface AgentStoreListOpts {
  limit?: number;
  cursor?: string;
}

export interface AgentStoreCreateInput {
  tenantId: string;
  name: string;
  model: string;
  system: string;
  runtime: Agent["runtime"];
  tools?: Agent["tools"];
  mcpServers?: Agent["mcpServers"];
  skills?: Agent["skills"];
}

export interface AgentStoreUpdateInput {
  name?: string;
  model?: string;
  system?: string;
  runtime?: Agent["runtime"];
  tools?: Agent["tools"];
  mcpServers?: Agent["mcpServers"];
  skills?: Agent["skills"];
}

export interface AgentStore {
  create(input: AgentStoreCreateInput): Promise<Agent>;
  getById(id: string): Promise<Agent | null>;
  list(tenantId: string, opts?: AgentStoreListOpts): Promise<PaginatedResult<Agent>>;
  update(id: string, input: AgentStoreUpdateInput): Promise<Agent | null>;
  delete(id: string): Promise<boolean>;
}
