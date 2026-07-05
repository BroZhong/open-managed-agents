import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface Agent {
  id: string;
  tenantId: string;
  name: string;
  model: string;
  system: string;
  runtime: string;
  /** Equipped Skill ids (by reference into the tenant Skill Library). */
  skills?: string[];
  sandbox?: {
    enabled: boolean;
    image?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AgentMutationBody {
  name: string;
  model: string;
  system: string;
  runtime: string;
  skills?: string[];
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
