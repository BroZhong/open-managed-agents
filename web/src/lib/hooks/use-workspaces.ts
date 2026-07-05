import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
}

interface WorkspacesResponse {
  data: Workspace[];
}

/** List the tenant's Workspaces (GET /v1/workspaces, added in #55). */
export function useWorkspaces() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: () =>
      apiFetch<WorkspacesResponse>("/v1/workspaces").then((r) => r.data),
  });
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
