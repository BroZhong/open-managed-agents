import { Link } from "react-router";
import { useDelegations } from "@/lib/hooks/use-delegations";
import { executionLink } from "@/lib/delegations";

export function DelegationSources({ sessionId, origin = false }: { sessionId: string; origin?: boolean }) {
  const query = useDelegations(sessionId, origin);
  const pages = query.data?.pages || [];
  const source = pages[0]?.origin;
  const executions = pages.flatMap((page) => page.data ?? []);
  if (!source && executions.length === 0 && !query.isError) return null;
  return <section className="max-h-56 shrink-0 space-y-2 overflow-auto border-b border-[var(--color-border)] px-6 py-3 text-xs" aria-label={origin ? "Child Session origin" : "Delegated executions"}>
    <strong>{origin ? "Child Session · execution history" : "Delegated executions"}</strong>
    {source && <p>Created from <Link className="underline" to={`/sessions/${encodeURIComponent(source.parentSessionId)}#tool-${encodeURIComponent(source.parentToolUseId)}`}>{source.parentSessionId}</Link> · Turn {source.parentTurnId} · Tool {source.parentToolUseId}</p>}
    {executions.map((execution) => <div key={execution.id} className="flex flex-wrap gap-2">
      <Link className="underline" to={executionLink(execution)}>{execution.prompt}</Link><span>{execution.mode} · {execution.status}</span>
      {origin && <Link className="underline" to={`/sessions/${encodeURIComponent(execution.callerSessionId)}#tool-${encodeURIComponent(execution.callerToolUseId)}`}>Source: Turn {execution.callerTurnId} · Tool {execution.callerToolUseId}</Link>}
    </div>)}
    {query.isError && <p role="alert">Could not load executions. <button className="underline" onClick={() => void query.refetch()}>Retry executions</button></p>}
    {query.hasNextPage && <button className="underline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>Load more executions</button>}
  </section>;
}
