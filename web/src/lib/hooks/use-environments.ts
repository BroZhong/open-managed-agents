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

/** How often the console reads a build's progress while it runs; the image builder writes about as often. */
export const BUILD_POLL_MS = 2_000;

/** The build's status will not change any more. */
export const buildFinished = (status: EnvironmentBuildSummary["status"]) => status === "succeeded" || status === "failed" || status === "superseded";

export function useEnvironment(id: string) {
  return useQuery({
    queryKey: ["environments", id],
    enabled: !!id,
    queryFn: ({ signal }) => apiFetch<Environment>(`/v1/environments/${encodeURIComponent(id)}`, { signal }),
    // Until its build ends: then the status, image and manifest settle.
    refetchInterval: (query) => (query.state.data?.lastBuild && !buildFinished(query.state.data.lastBuild.status) ? BUILD_POLL_MS : false),
  });
}

/** One read of a build's log (`GET /v1/environments/{id}/log`). */
export interface EnvironmentBuildLogPage {
  build: EnvironmentBuildSummary;
  finished: boolean;
  text: string;
  offset: number;
  nextOffset: number;
  truncated: boolean;
}

/** The console keeps at most this much of a log, as the Host does. */
const LOG_MAX_CHARS = 1024 * 1024;

/**
 * A build's log as it grows: every 2 s the next bytes from `nextOffset` are
 * appended until the build has ended. The Host reads the status before the
 * log, so the read that says finished holds the whole log.
 */
export function useEnvironmentBuildLog(environmentId: string, buildId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ["environments", environmentId, "log", buildId];
  return useQuery({
    queryKey,
    enabled: !!environmentId && !!buildId,
    queryFn: async ({ signal }) => {
      const previous = queryClient.getQueryData<EnvironmentBuildLogPage>(queryKey);
      const page = await apiFetch<EnvironmentBuildLogPage>(
        `/v1/environments/${encodeURIComponent(environmentId)}/log?build_id=${encodeURIComponent(buildId!)}&offset=${previous?.nextOffset ?? 0}`,
        { signal },
      );
      // Behind the Host's kept tail, the earlier text no longer connects.
      const text = !previous || page.truncated ? page.text : previous.text + page.text;
      return { ...page, text: text.length > LOG_MAX_CHARS ? text.slice(-LOG_MAX_CHARS) : text, truncated: page.truncated || !!previous?.truncated };
    },
    refetchInterval: (query) => (query.state.data?.finished ? false : BUILD_POLL_MS),
  });
}

/** Build the Environment's current definition again (`POST /v1/environments/{id}/build`). */
export function useRebuildEnvironment(id: string) {
  return useEnvironmentMutation(() =>
    apiFetch<Environment>(`/v1/environments/${encodeURIComponent(id)}/build`, { method: "POST" }));
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
