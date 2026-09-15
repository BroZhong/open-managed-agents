import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { TokenUsageMetrics } from "@/components/token-usage-metrics";
import { tokenUsageFromResponse, type TokenUsageResponse } from "@/lib/token-usage";

export function DelegationUsage({ sessionId }: { sessionId: string }) {
  const { data } = useQuery({ queryKey: ["delegation-usage", sessionId], queryFn: ({ signal }) => apiFetch<{ self: TokenUsageResponse; delegated: TokenUsageResponse; total: TokenUsageResponse }>(`/v1/sessions/${encodeURIComponent(sessionId)}/delegation-usage`, { signal }), refetchInterval: 3000 });
  if (!data?.self || !data?.delegated || !data?.total || data.delegated.total_tokens === 0) return null;
  return <details className="border-b border-[var(--color-border)] px-6 py-2 text-xs"><summary>Usage including child executions: {data.total.total_tokens.toLocaleString()} tokens</summary><div className="flex flex-wrap gap-4 py-2">
    <div><p>Session’s own model requests</p><TokenUsageMetrics usage={tokenUsageFromResponse(data.self)} /></div>
    <div><p>Directly delegated model requests</p><TokenUsageMetrics usage={tokenUsageFromResponse(data.delegated)} /></div>
    <div><p>Combined total · counted once per request</p><TokenUsageMetrics usage={tokenUsageFromResponse(data.total)} /></div>
  </div></details>;
}
