import { ChevronRight, Users } from "lucide-react";
import type { DelegationExecution } from "@/lib/delegations";
import { useDelegations } from "@/lib/hooks/use-delegations";
import { SessionLoading } from "@/components/session-loading";

export function SubagentSessions({ sessionId, onOpenExecution }: {
  sessionId: string;
  onOpenExecution: (execution: DelegationExecution) => void;
}) {
  const query = useDelegations(sessionId);
  // The API orders executions newest first. A resumed child keeps one entry,
  // summarized by its latest task, even when older executions span more pages.
  const children = new Map<string, DelegationExecution>();
  for (const page of query.data?.pages ?? []) {
    for (const execution of page.data) {
      if (!children.has(execution.childId)) children.set(execution.childId, execution);
    }
  }

  if (query.isLoading) return <SessionLoading />;
  return <section aria-label="SubAgent Sessions" className="h-full overflow-y-auto px-6 py-5">
    {!query.isError && children.size === 0 && <p className="py-8 text-center text-sm text-[var(--color-fg-subtle)]">No SubAgent Sessions yet.</p>}
    <ul className="space-y-5">
      {[...children.values()].map((execution) => <li key={execution.childId}>
        <button type="button" onClick={() => onOpenExecution(execution)}
          title={execution.prompt} aria-label={`Open SubAgent: ${execution.prompt || execution.childId}`}
          className="group flex w-full flex-col items-end gap-2 rounded-lg text-left outline-offset-4 focus-visible:outline-2 focus-visible:outline-[var(--color-fg)]">
          <span className="flex items-center gap-2 text-xs text-[var(--color-fg-subtle)]">
            <Users aria-hidden="true" className="h-3.5 w-3.5" />
            <span title={execution.childId}>{execution.childId.slice(0, 13)}</span>
            <span>{execution.status}</span>
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
          </span>
          <span className="session-user-bubble transition-colors group-hover:ring-1 group-hover:ring-[var(--color-border)]">
            <span className="line-clamp-4 whitespace-pre-wrap">{execution.prompt || "No task message"}</span>
          </span>
        </button>
      </li>)}
    </ul>
    {query.isError && <p role="alert" className="mt-4 text-sm">Could not load SubAgent Sessions. <button className="underline" onClick={() => void query.refetch()}>Retry</button></p>}
    {query.hasNextPage && <button className="mt-5 text-sm underline" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>
      {query.isFetchingNextPage ? "Loading…" : "Load more"}
    </button>}
  </section>;
}
