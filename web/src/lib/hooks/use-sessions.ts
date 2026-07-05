import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface Session {
  id: string;
  agentId: string;
  status: "idle" | "running" | "terminated";
  /** Snapshot of the user's first message; the console shows `title ?? id`. */
  title?: string;
  /** The Workspace this Session is bound to (used to group by workspace). */
  workspaceId: string;
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

/**
 * Variables for {@link useCreateSession}. Either pass a bare agent id (starts a
 * loose chat in a fresh anonymous Workspace) or an object binding the Session to
 * a specific Workspace. `workspaceId`/`workspaceName` map to the server's
 * `workspace_id`/`workspace_name` fields on `POST /v1/sessions`.
 */
export type CreateSessionVariables =
  | string
  | { agentId: string; workspaceId?: string; workspaceName?: string };

export function useCreateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: CreateSessionVariables) => {
      const { agentId, workspaceId, workspaceName } =
        typeof vars === "string" ? { agentId: vars, workspaceId: undefined, workspaceName: undefined } : vars;
      const body: Record<string, string> = { agent: agentId };
      if (workspaceId) body.workspace_id = workspaceId;
      if (workspaceName) body.workspace_name = workspaceName;
      return apiFetch<Session>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
}
