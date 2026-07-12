import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface McpServerConfig {
  name: string;
  url: string;
  transport?: "sse" | "streamable-http";
  headers?: Record<string, string>;
}

export const MANAGED_RDS_MCP_SERVER: McpServerConfig = {
  name: "rds-mcp",
  url: "https://campaign.welltop.tech/agent/mcp/rds",
  transport: "streamable-http",
  headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
};

/** Only this exact Host-reviewed MCP connection is manageable in the console. */
export function isManagedRdsMcpServer(config: McpServerConfig): boolean {
  const headers = config.headers ?? {};
  return (
    config.name === MANAGED_RDS_MCP_SERVER.name &&
    config.url === MANAGED_RDS_MCP_SERVER.url &&
    config.transport === MANAGED_RDS_MCP_SERVER.transport &&
    Object.keys(headers).length === 1 &&
    headers.Authorization === MANAGED_RDS_MCP_SERVER.headers?.Authorization
  );
}

export interface Agent {
  id: string;
  tenantId: string;
  name: string;
  /**
   * Optional human-readable description shown in the console (cards, detail) to
   * tell Agents apart. Informational only — never injected into the model
   * context / prompt.
   */
  description?: string;
  model: string;
  system: string;
  runtime: string;
  /** Equipped Skill ids (by reference into the tenant Skill Library). */
  skills?: string[];
  /** MCP connections configured for this Agent (not a tenant-wide library). */
  mcpServers?: McpServerConfig[];
  sandbox?: {
    enabled: boolean;
    image?: string;
    env?: Record<string, string>;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AgentMutationBody {
  name: string;
  description?: string;
  model: string;
  system: string;
  runtime: string;
  skills?: string[];
  mcpServers?: McpServerConfig[];
  sandbox?: Agent["sandbox"];
}

interface AgentsResponse {
  data: Agent[];
  has_more: boolean;
  next_cursor?: string;
}

export function useAgents() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: () =>
      apiFetch<AgentsResponse>("/v1/agents").then((r) => r.data),
  });
}

export function useAgent(id: string) {
  return useQuery({
    queryKey: ["agents", id],
    queryFn: () => apiFetch<Agent>(`/v1/agents/${id}`),
    enabled: !!id,
  });
}

export function useCreateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AgentMutationBody) =>
      apiFetch<Agent>("/v1/agents", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

export function useUpdateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Partial<AgentMutationBody>) =>
      apiFetch<Agent>(`/v1/agents/${id}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["agents", variables.id] });
    },
  });
}

export function useDeleteAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ type: string; id: string }>(`/v1/agents/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}
