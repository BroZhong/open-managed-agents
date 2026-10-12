import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { validateThinkingOptions, type ThinkingOptions } from "./use-thinking-options";
export interface ProviderModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning?: boolean;
  reasoningSource?: "upstream" | "default" | "legacy";
  capabilityVersion?: 1;
  capabilityReference?: { provider: string; modelId: string };
  thinkingProfile?: "anthropic-adaptive";
  thinkingMode?: "app";
  input: ("text" | "image")[];
  catalogProvider?: string;
}
export interface ProviderInput {
  id?: string;
  name: string;
  api: string;
  baseUrl: string;
  apiKey?: string;
  models: ProviderModel[];
}
export interface ModelProvider extends ProviderInput {
  id: string;
  hasApiKey: boolean;
  testedAt: string;
}
export interface ProviderTest {
  verificationToken: string;
  testedAt: string;
}
export interface CapabilityReference {
  provider: string;
  modelId: string;
  name: string;
  reasoning: boolean;
}

export function useCapabilityReferences(api: string, model: string, enabled: boolean) {
  return useQuery({
    queryKey: ["provider-capability-references", api, model],
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: ({ signal }) => apiFetch<{ data: CapabilityReference[]; recommendations: (Omit<CapabilityReference, "reasoning"> & { reason: string })[] }>(
      `/v1/model-providers/capability-references?api=${encodeURIComponent(api)}&model=${encodeURIComponent(model)}`, { signal },
    ),
  });
}

export function useProviderThinkingOptions(api: string, model: ProviderModel, enabled: boolean) {
  return useQuery({
    queryKey: ["provider-thinking-preview", api, model],
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => validateThinkingOptions(await apiFetch<ThinkingOptions>(
      "/v1/model-providers/thinking-options", { method: "POST", body: JSON.stringify({ api, model }), signal },
    )),
  });
}
export function useModelProviders(enabled = true) {
  return useQuery({
    queryKey: ["model-providers"],
    enabled,
    queryFn: () =>
      apiFetch<{ data: ModelProvider[] }>("/v1/model-providers").then(
        (result) => result.data,
      ),
  });
}
export function useProviderProtocols() {
  return useQuery({
    queryKey: ["provider-protocols"],
    queryFn: () =>
      apiFetch<{ protocols: { id: string; name: string }[] }>(
        "/v1/model-providers/protocols",
      ),
  });
}
export function useDiscoverProviderModels() {
  return useMutation({
    mutationFn: (
      input: Pick<ProviderInput, "id" | "api" | "baseUrl" | "apiKey">,
    ) =>
      apiFetch<{ data: ProviderModel[] }>("/v1/model-providers/discover", {
        method: "POST",
        body: JSON.stringify(input),
      }),
  });
}
export function useTestProvider() {
  return useMutation({
    mutationFn: (input: ProviderInput) =>
      apiFetch<ProviderTest>("/v1/model-providers/test", {
        method: "POST",
        body: JSON.stringify(input),
      }),
  });
}
export function useSaveProvider() {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (input: ProviderInput & { verificationToken: string }) =>
      apiFetch<ModelProvider>("/v1/model-providers", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => Promise.all([
      cache.invalidateQueries({ queryKey: ["model-providers"] }),
      cache.invalidateQueries({ queryKey: ["model-thinking-options"] }),
      cache.invalidateQueries({ queryKey: ["session-thinking-options"] }),
      cache.invalidateQueries({ queryKey: ["provider-thinking-preview"] }),
    ]),
  });
}
export function useDeleteProvider() {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/v1/model-providers/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => Promise.all([
      cache.invalidateQueries({ queryKey: ["model-providers"] }),
      cache.invalidateQueries({ queryKey: ["model-thinking-options"] }),
      cache.invalidateQueries({ queryKey: ["session-thinking-options"] }),
    ]),
  });
}
