import { useState } from "react";
import { Link } from "react-router";
import { useToolDelegation } from "@/lib/hooks/use-delegations";
import { executionLink } from "@/lib/delegations";
import { ExecutionTraceView } from "@/components/execution-trace";
import { ToolCard } from "@/components/tool-card";
import type { DisplayMessage } from "@/lib/conversation-projection";

export function DelegationCard({ sessionId, message }: { sessionId: string; message: DisplayMessage }) {
  const [expanded, setExpanded] = useState(false);
  const query = useToolDelegation(sessionId, message.toolUseId || "", message.turnId, !!message.result);
  const execution = query.data?.data[0];
  const input = message.input && typeof message.input === "object" ? message.input as Record<string, unknown> : {};
  return <article id={`tool-${message.toolUseId}`} className="space-y-2 rounded-xl border border-[var(--color-border)] p-3">
    <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="flex w-full items-start justify-between gap-2 text-left text-sm">
      <span><strong>Agent</strong> · {execution?.prompt || String(input.description || input.prompt || input.task || "Delegated task")}</span>
      <span className="shrink-0 text-xs">{execution ? `${execution.mode} · ${execution.status}` : "Trace unavailable"} · {expanded ? "Collapse" : "Expand"}</span>
    </button>
    {execution && <Link className="text-xs underline" to={executionLink(execution)}>Open child Session execution</Link>}
    {expanded && (execution ? <ExecutionTraceView key={execution.id} sessionId={sessionId} executionId={execution.id} /> : <>
      {query.isLoading ? <p>Loading delegation…</p> : query.isError ? <p role="alert">Could not load delegation. <button onClick={() => void query.refetch()}>Retry</button></p> : <p className="text-xs">No persisted execution is associated with this call. The original plugin summary is available below.</p>}
      <ToolCard name={message.name || "Agent"} toolUseId={message.toolUseId || ""} input={message.input} result={message.result} />
    </>)}
  </article>;
}
