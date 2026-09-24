import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
export interface ProviderModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
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
    onSuccess: () => cache.invalidateQueries({ queryKey: ["model-providers"] }),
  });
}
export function useDeleteProvider() {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/v1/model-providers/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["model-providers"] }),
  });
}
