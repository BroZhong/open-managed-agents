import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface Session {
  id: string;
  agentId: string;
  status: "idle" | "running" | "terminated";
  /** Snapshot of the user's first message; the console shows `title ?? id`. */
  title?: string;
  /** The Workspace this Session is bound to (used to group by workspace). */
  workspaceId: string;
  /** Present when this Session was created by a scheduled Loop. */
  loopId?: string;
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
    queryFn: ({ signal }) =>
      apiFetch<SessionsResponse>(`/v1/sessions${params}`, { signal }).then((r) => r.data),
  });
}

/** Sessions belonging to a single Agent (nested under the Agent, not global). */
export function useAgentSessions(agentId: string) {
  return useQuery({
    queryKey: ["sessions", "byAgent", agentId],
    queryFn: ({ signal }) =>
      apiFetch<SessionsResponse>(
        `/v1/sessions?agent_id=${agentId}&exclude_loop=true`,
        { signal },
      ).then((r) => r.data),
    enabled: !!agentId,
  });
}

export function useSession(id: string) {
  return useQuery({
    queryKey: ["sessions", id],
    queryFn: ({ signal }) => apiFetch<Session>(`/v1/sessions/${id}`, { signal }),
    enabled: !!id,
  });
}

export function useLoopSessions(loopId: string, enabled = true) {
  const query = useInfiniteQuery({
    queryKey: ["sessions", "byLoop", loopId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const cursor = pageParam
        ? `&cursor=${encodeURIComponent(pageParam)}`
        : "";
      return apiFetch<SessionsResponse>(
        `/v1/sessions?loop_id=${encodeURIComponent(loopId)}&limit=50${cursor}`,
        { signal },
      );
    },
    getNextPageParam: (lastPage) =>
      lastPage.has_more ? lastPage.next_cursor : undefined,
    enabled: Boolean(loopId) && enabled,
    refetchInterval: 15_000,
  });
  return {
    ...query,
    data: query.data?.pages.flatMap((page) => page.data),
  };
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
