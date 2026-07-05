import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface Session {
  id: string;
  agentId: string;
  status: "idle" | "running" | "terminated";
  agent: { id: string; name: string; model: string; runtime: string };
  createdAt: string;
  updatedAt: string;
}

interface SessionsResponse {
  data: Session[];
  has_more: boolean;
  next_cursor?: string;
}

export function useSessions(status?: string) {
  const params = status ? `?status=${status}` : "";
  return useQuery({
    queryKey: ["sessions", status ?? "all"],
    queryFn: () =>
      apiFetch<SessionsResponse>(`/v1/sessions${params}`).then((r) => r.data),
  });
}

/** Sessions belonging to a single Agent (nested under the Agent, not global). */
export function useAgentSessions(agentId: string) {
  return useQuery({
    queryKey: ["sessions", "byAgent", agentId],
    queryFn: () =>
      apiFetch<SessionsResponse>(`/v1/sessions?agent_id=${agentId}`).then((r) => r.data),
    enabled: !!agentId,
  });
}

export function useSession(id: string) {
  return useQuery({
    queryKey: ["sessions", id],
    queryFn: () => apiFetch<Session>(`/v1/sessions/${id}`),
    enabled: !!id,
  });
}

export function useCreateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) =>
      apiFetch<Session>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ agent: agentId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
}
