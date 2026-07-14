import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { Session } from "@/lib/hooks/use-sessions";

export interface Loop {
  id: string;
  tenantId: string;
  agentId: string;
  name: string;
  description?: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLoopInput {
  agentId: string;
  name: string;
  description?: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
}

export function useAgentLoops(agentId: string) {
  return useQuery({
    queryKey: ["loops", "byAgent", agentId],
    queryFn: () =>
      apiFetch<{ data: Loop[] }>(`/v1/agents/${agentId}/loops`).then(
        (response) => response.data,
      ),
    enabled: Boolean(agentId),
    refetchInterval: 15_000,
  });
}

export function useCreateLoop() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, ...body }: CreateLoopInput) =>
      apiFetch<Loop>(`/v1/agents/${agentId}/loops`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (loop) => {
      queryClient.invalidateQueries({ queryKey: ["loops", "byAgent", loop.agentId] });
    },
  });
}

export interface UpdateLoopInput {
  id: string;
  name?: string;
  description?: string;
  prompt?: string;
  intervalMinutes?: number;
  enabled?: boolean;
}

export function useUpdateLoop() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateLoopInput) =>
      apiFetch<Loop>(`/v1/loops/${id}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData<Loop[]>(
        ["loops", "byAgent", updated.agentId],
        (current) => current?.map((loop) =>
          loop.id === updated.id ? updated : loop
        ),
      );
    },
  });
}

export function useRunLoop() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<Session>(`/v1/loops/${id}/run`, { method: "POST" }),
    onSuccess: (session) => {
      if (session.loopId) {
        queryClient.invalidateQueries({
          queryKey: ["sessions", "byLoop", session.loopId],
        });
      }
    },
  });
}
