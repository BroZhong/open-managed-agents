import type { DelegationExecution } from "@/lib/delegations";
import { useAgentSkills } from "@/lib/hooks/use-skills";
import { ConversationView } from "@/components/conversation-view";
import { SessionUsageFooter } from "@/components/session-usage-footer";
import { StatusBadge } from "@/components/status-badge";
import { useSession } from "@/lib/hooks/use-sessions";
import { useSessionEvents } from "@/lib/hooks/use-session-events";

/** One mounted observer per open child Session, spanning every resume and Turn. */
export function ChildSessionConversation({ sessionId, workspaceId, onOpenExecution, onOpenWorkspaceFile }: { sessionId: string; workspaceId?: string; onOpenExecution?: (execution: DelegationExecution) => void; onOpenWorkspaceFile?: (path: string) => void }) {
  const { data: session, isLoading, isError, refetch } = useSession(sessionId);
  const { data: skills = [] } = useAgentSkills(session?.agentId ?? "");
  const { events, activeDeltas, status } = useSessionEvents(sessionId);
  const effectiveStatus = session?.status === "terminated" ? "idle" : status;
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex items-center gap-2 px-6 pt-4 text-xs text-[var(--color-fg-subtle)]">
      Child Session · {sessionId.slice(0, 13)}
      <StatusBadge status={effectiveStatus} />
    </div>
    {isLoading && <p role="status" className="px-6 py-2 text-xs">Loading child Session…</p>}
    {isError && <p role="alert" className="px-6 py-2 text-xs">Could not load child Session. <button className="underline" onClick={() => void refetch()}>Retry</button></p>}
    <div className="min-h-0 flex-1">
      <ConversationView onOpenExecution={onOpenExecution} resources={session ? { agentId: session.agentId, skills, onOpenWorkspacePath: session.workspaceId === workspaceId ? onOpenWorkspaceFile : undefined } : undefined} sessionId={sessionId} events={events} activeDeltas={activeDeltas} sessionStatus={effectiveStatus} />
    </div>
    <SessionUsageFooter events={events} />
  </div>;
}
