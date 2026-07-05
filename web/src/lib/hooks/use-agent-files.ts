import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

/** The canonical Agent File names, in the order the runtime assembles them. */
export const AGENT_FILE_NAMES = ["IDENTITY", "SOUL", "USER", "MEMORY"] as const;
export type AgentFileName = (typeof AGENT_FILE_NAMES)[number];

export interface AgentFile {
  filename: string;
  content: string;
  updatedAt: string;
}

interface AgentFileListResponse {
  data: { filename: string; updatedAt: string }[];
  has_more: boolean;
  next_cursor?: string | null;
}

export function useAgentFile(agentId: string, filename: string) {
  return useQuery({
    queryKey: ["agents", agentId, "files", filename],
    queryFn: async () => {
      try {
        return await apiFetch<AgentFile>(`/v1/agents/${agentId}/files/${filename}`);
      } catch {
        // A file that has never been saved yet reads as an empty document.
        return { filename, content: "", updatedAt: "" } satisfies AgentFile;
      }
    },
    enabled: !!agentId,
  });
}

export function useAgentFilesList(agentId: string) {
  return useQuery({
    queryKey: ["agents", agentId, "files"],
    queryFn: () =>
      apiFetch<AgentFileListResponse>(`/v1/agents/${agentId}/files`).then((r) => r.data),
    enabled: !!agentId,
  });
}

export function useSaveAgentFile(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ filename, content }: { filename: string; content: string }) =>
      apiFetch<AgentFile>(`/v1/agents/${agentId}/files/${filename}`, {
        method: "POST",
        body: JSON.stringify({ content }),
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["agents", agentId, "files"] });
      queryClient.invalidateQueries({
        queryKey: ["agents", agentId, "files", variables.filename],
      });
    },
  });
}
