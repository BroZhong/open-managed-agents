import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router";
import { useExecutionTrace } from "@/lib/hooks/use-delegations";
import { processEventsToMessages } from "@/lib/conversation-projection";
import { tokenUsageFromResponse } from "@/lib/token-usage";
import { TokenUsageMetrics } from "@/components/token-usage-metrics";
import { ToolCard } from "@/components/tool-card";
import type { DelegationExecution } from "@/lib/delegations";

export function ExecutionSummary({ execution }: { execution: DelegationExecution }) {
  return <div className="space-y-2 text-sm">
    <div className="flex flex-wrap gap-2 text-xs"><strong>{execution.status}</strong><span>{execution.mode}</span><span>Step budget: {execution.maxSteps}</span>
      {execution.notificationStatus && <span>Notification: {execution.notificationStatus}</span>}</div>
    <p className="whitespace-pre-wrap">{execution.prompt}</p>
    {execution.result && <div className={execution.status === "completed" ? "" : "text-red-700"}>
      <p className="whitespace-pre-wrap">{execution.result.reason}</p>
      <details><summary>Final result</summary><pre className="whitespace-pre-wrap break-words">{execution.result.output || "No final output"}</pre></details>
    </div>}
    {!!execution.commands?.length && <section aria-label="Execution instructions" className="space-y-2">
      <strong className="text-xs">Instructions</strong>
      {execution.commands.map((command) => <div key={command.id} className="rounded-lg border border-[var(--color-border)] p-2 text-xs">
        <p>{command.kind} · {command.status}{command.appliedEventSeq !== undefined ? ` · Event ${command.appliedEventSeq}` : ""}</p>
        <p className="whitespace-pre-wrap">{command.message}</p>
        {command.status === "not_applied" && <p>The execution ended before this instruction could be applied.</p>}
      </div>)}
    </section>}
    {execution.effectiveConfig && <details><summary>Effective model configuration</summary><pre className="whitespace-pre-wrap">{JSON.stringify(execution.effectiveConfig, null, 2)}</pre></details>}
  </div>;
}

export function ExecutionTraceView({ sessionId, executionId }: { sessionId: string; executionId: string }) {
  const { trace, events, activeDeltas, loading, error, retry, loadMore } = useExecutionTrace(sessionId, executionId);
  const { messages } = processEventsToMessages(events, activeDeltas);
  const visible = messages.filter((message) => message.role !== "thinking");
  return <section aria-label="Delegation execution trace" className="space-y-3 rounded-xl border border-[var(--color-border)] p-3">
    {trace && <>
      <ExecutionSummary execution={trace.execution} />
      <div className="flex flex-wrap items-center gap-2 text-xs"><span>This execution’s model usage</span><TokenUsageMetrics usage={tokenUsageFromResponse(trace.usage)} /></div>
      <p className="text-xs text-[var(--color-fg-muted)]">Saved files persist independently of execution success. <Link className="underline" to={`/sessions/${encodeURIComponent(trace.execution.childId)}?tab=workspace`}>Open Workspace files</Link></p>
    </>}
    {loading && <p role="status">Loading execution…</p>}
    {error && <div role="alert">Could not load trace: {error} <button onClick={retry} className="underline">Retry trace</button></div>}
    {!loading && !error && visible.length === 0 && <p>No output yet.</p>}
    {visible.map((message) => message.role === "tool_use" ? <ToolCard key={message.id} name={message.name || "unknown"} toolUseId={message.toolUseId || ""} input={message.input} result={message.result} streaming={message.streaming} /> : <div key={message.id} className={message.role === "error" ? "text-red-700" : "prose prose-sm max-w-none break-words"}><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>{message.aborted && <p>Interrupted</p>}</div>)}
    {trace?.has_more && <button onClick={loadMore} disabled={loading} className="text-sm underline">Load more execution events</button>}
  </section>;
}
