import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api"
import {
  tokenUsageFromResponse,
  type TokenUsageResponse,
  type TokenUsageSummary,
} from "@/lib/token-usage"

export interface ApiKeyListItem {
  id: string
  name: string
  prefix: string
  createdAt: string
  revokedAt: string | null
  usage: TokenUsageSummary
}

export interface ApiKeyCreateResponse {
  id: string
  name: string
  key: string
  prefix: string
  createdAt: string
}

interface ApiKeyListResponseItem extends Omit<ApiKeyListItem, "usage"> {
  usage?: TokenUsageResponse
}

interface ApiKeysResponse {
  data: ApiKeyListResponseItem[]
  has_more: boolean
}

export function useApiKeys() {
  return useQuery({
    queryKey: ["api-keys"],
    queryFn: () =>
      apiFetch<ApiKeysResponse>("/v1/api-keys").then((r) =>
        r.data.map((key) => ({
          ...key,
          usage: tokenUsageFromResponse(key.usage),
        })),
      ),
  })
}

export function useCreateApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string }) =>
      apiFetch<ApiKeyCreateResponse>("/v1/api-keys", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] })
    },
  })
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ type: string; id: string }>(`/v1/api-keys/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] })
    },
  })
}
