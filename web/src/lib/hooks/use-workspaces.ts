import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

/**
 * A Workspace is the S3-authoritative home of a Session's artifacts. Named
 * workspaces are surfaced in the sidebar's "workspaces" group; unnamed
 * (auto-created, "loose") ones back a plain chat and appear under "chats".
 */
export interface Workspace {
  id: string;
  tenantId: string;
  name?: string;
  createdAt: string;
  /** Agent-scoped latest visible Session modification time. */
  updatedAt?: string;
  hasRunningSessions?: boolean;
}

export interface WorkspacesResponse {
  data: Workspace[];
  has_more?: boolean;
  next_cursor?: string;
}

/** List the tenant's Workspaces (GET /v1/workspaces, added in #55). */
export function useWorkspaces() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: () =>
      apiFetch<WorkspacesResponse>("/v1/workspaces").then((r) => r.data),
  });
}

/** Workspace discovery has its own cursor, independent of Session pages. */
export function useAgentWorkspaces(agentId: string) {
  const query = useInfiniteQuery({
    queryKey: ["workspaces", "byAgent", agentId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ agent_id: agentId, limit: pageParam ? "20" : "15" });
      if (pageParam) params.set("cursor", pageParam);
      return apiFetch<WorkspacesResponse>(`/v1/workspaces?${params}`, { signal });
    },
    getNextPageParam: (lastPage) => lastPage.has_more ? lastPage.next_cursor : undefined,
    enabled: Boolean(agentId),
    refetchInterval: 15_000,
  });
  // Activity can move a row across a previously loaded cursor boundary.
  const unique = new Map<string, Workspace>();
  for (const page of query.data?.pages ?? []) {
    for (const workspace of page.data) {
      if (!unique.has(workspace.id)) unique.set(workspace.id, workspace);
    }
  }
  return { ...query, data: query.data ? [...unique.values()] : undefined };
}

/**
 * Create a named Workspace (POST /v1/workspaces, added in #55). Invalidates the
 * ["workspaces"] list on success so the sidebar's "workspaces" group refreshes.
 */
export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<Workspace>("/v1/workspaces", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

/**
 * Rename a Workspace (POST /v1/workspaces/:id). Invalidates the ["workspaces"]
 * list on success so the sidebar's "workspaces" group refreshes.
 */
export function useUpdateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      apiFetch<Workspace>(`/v1/workspaces/${id}`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

/** Soft-delete: the server retains files and Sessions, but hides them from lists. */
export function useDeleteWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/v1/workspaces/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
}
