import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export type EnvironmentBaseImage = "oma-base" | "oma-media";
export type EnvironmentStatus = "pending" | "building" | "failed" | "ready";

/** A variable as the API returns it: secret values never come back. */
export type EnvironmentVariable =
  | { name: string; value: string }
  | { name: string; secretRef: { source: "platform" | "environment"; key: string } };

/** A variable as written: a Tenant secret may carry its new value; without one the stored value is kept. */
export type EnvironmentVariableInput =
  | { name: string; value: string }
  | { name: string; secretRef: { source: "platform" | "environment"; key: string }; value?: string };

export interface EnvironmentBuildSummary {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed" | "superseded";
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface EnvironmentSummary {
  id: string;
  ownerType: "platform" | "tenant";
  name: string;
  description: string;
  baseImage: EnvironmentBaseImage;
  status: EnvironmentStatus;
  image: string | null;
  lastBuild: EnvironmentBuildSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface Environment extends EnvironmentSummary {
  initScript: string;
  env: EnvironmentVariable[];
  manifest: Record<string, unknown> | null;
}

export interface EnvironmentInput {
  name?: string;
  description?: string;
  baseImage?: EnvironmentBaseImage;
  initScript?: string;
  env?: EnvironmentVariableInput[];
}

export function useEnvironments(enabled = true) {
  return useQuery({
    queryKey: ["environments"],
    enabled,
    queryFn: ({ signal }) => apiFetch<{ data: EnvironmentSummary[] }>("/v1/environments", { signal }).then((result) => result.data),
  });
}

export function useEnvironment(id: string) {
  return useQuery({
    queryKey: ["environments", id],
    enabled: !!id,
    queryFn: ({ signal }) => apiFetch<Environment>(`/v1/environments/${encodeURIComponent(id)}`, { signal }),
  });
}

function useEnvironmentMutation<T>(request: (input: T) => Promise<Environment>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (environment) => {
      queryClient.setQueryData(["environments", environment.id], environment);
      void queryClient.invalidateQueries({ queryKey: ["environments"], exact: true });
    },
  });
}

/** Create an Environment, or copy the visible one `from`. */
export function useCreateEnvironment() {
  return useEnvironmentMutation((input: EnvironmentInput & { from?: string }) =>
    apiFetch<Environment>("/v1/environments", { method: "POST", body: JSON.stringify(input) }));
}

export function useUpdateEnvironment(id: string) {
  return useEnvironmentMutation((input: EnvironmentInput) =>
    apiFetch<Environment>(`/v1/environments/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(input) }));
}

export function useDeleteEnvironment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/v1/environments/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: ["environments", id] });
      void queryClient.invalidateQueries({ queryKey: ["environments"], exact: true });
    },
  });
}
