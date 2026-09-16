import { useToolDelegation } from "@/lib/hooks/use-delegations";
import type { DelegationExecution } from "@/lib/delegations";
import { ToolCard } from "@/components/tool-card";
import type { DisplayMessage } from "@/lib/conversation-projection";

export function DelegationCard({ sessionId, message, onOpenExecution }: { sessionId: string; message: DisplayMessage; onOpenExecution: (execution: DelegationExecution) => void }) {
  const query = useToolDelegation(sessionId, message.toolUseId || "", message.turnId, !!message.result);
  const execution = query.data?.data[0];
  const input = message.input && typeof message.input === "object" ? message.input as Record<string, unknown> : {};
  return <article id={`tool-${message.toolUseId}`} className="space-y-2 rounded-xl border border-[var(--color-border)] p-3">
    <button disabled={!execution} onClick={() => execution && onOpenExecution(execution)} className="flex w-full items-start justify-between gap-3 text-left text-sm disabled:cursor-default">
      <span><strong>Agent</strong> · {execution?.prompt || String(input.description || input.prompt || input.task || "Delegated task")}</span>
      <span className="shrink-0 text-xs">{execution ? `${execution.mode} · ${execution.status} · Open session` : query.isLoading ? "Loading…" : "Trace unavailable"}</span>
    </button>
    {query.isError && <p role="alert">Could not load delegation. <button onClick={() => void query.refetch()}>Retry</button></p>}
    {!execution && !query.isLoading && !query.isError && !!message.result && <>
      <p className="text-xs">No persisted execution is associated with this call. The original plugin summary is available below.</p>
      <ToolCard name={message.name || "Agent"} toolUseId={message.toolUseId || ""} input={message.input} result={message.result} />
    </>}
  </article>;
}
