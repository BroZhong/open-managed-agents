import { useToolDelegation } from "@/lib/hooks/use-delegations";
import type { DelegationExecution } from "@/lib/delegations";
import { ToolCard } from "@/components/tool-card";
import type { DisplayMessage } from "@/lib/conversation-projection";

export function DelegationCard({ sessionId, message, running = false, onOpenExecution }: { sessionId: string; message: DisplayMessage; running?: boolean; onOpenExecution: (execution: DelegationExecution) => void }) {
  const query = useToolDelegation(sessionId, message.toolUseId || "", message.turnId, !!message.result);
  const execution = query.data?.data[0];
  return <div>
    <ToolCard
      name="Agent"
      toolUseId={message.toolUseId || ""}
      input={message.input}
      result={message.result}
      streaming={message.streaming}
      running={running}
      detail={execution?.prompt}
      status={execution?.status}
      title={execution ? "Open child Session" : undefined}
      onActivate={execution ? () => onOpenExecution(execution) : undefined}
    />
    {query.isError && <p role="alert" className="text-xs">Could not load delegation. <button onClick={() => void query.refetch()}>Retry</button></p>}
    {!execution && !query.isLoading && !query.isError && !!message.result && <p className="text-xs text-[var(--color-fg-subtle)]">No persisted execution is associated with this call. Expand the tool to view the original plugin summary.</p>}
  </div>;
}
