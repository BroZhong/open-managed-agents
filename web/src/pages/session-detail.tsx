import { useState, useCallback } from "react";
import { useParams, useNavigate, useLocation } from "react-router";
import { ArrowLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ConversationView } from "@/components/conversation-view";
import { TimelineView } from "@/components/timeline-view";
import { SplitWorkbench } from "@/components/split-workbench";
import { WorkspacePanel } from "@/components/workspace-panel";
import { SessionShareDialog } from "@/components/session-share-dialog";
import { MessageInput } from "@/components/message-input";
import { SessionUsageFooter } from "@/components/session-usage-footer";
import { ChildSessionConversation } from "@/components/child-session-conversation";
import type { DelegationExecution } from "@/lib/delegations";
import { useSession } from "@/lib/hooks/use-sessions";
import { useWorkspaces } from "@/lib/hooks/use-workspaces";
import { useSessionEvents } from "@/lib/hooks/use-session-events";
import { useSendMessage } from "@/lib/hooks/use-send-message";
import { useInterrupt } from "@/lib/hooks/use-interrupt";
import { useAgentSkills } from "@/lib/hooks/use-skills";
import { useQueuedInput } from "@/lib/hooks/use-queued-input";
import { cn } from "@/lib/utils";

/** Read the display text out of a `user.message` event payload. */
function messageText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : "";
}
type ChildTab = { execution: DelegationExecution; label: string };

export default function SessionDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  // Route parameter changes reuse the page. Give each Session its own composer,
  // queue observer, and event stream so none survive into another one.
  return <SessionDetail key={id} id={id} />;
}

function SessionDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const focusToolUseId = location.hash.startsWith("#tool-") ? decodeURIComponent(location.hash.slice(6)) : undefined;
  const { data: session, isLoading: sessionLoading } = useSession(id);
  const { data: workspaces = [] } = useWorkspaces();
  const { data: equippedSkills = [] } = useAgentSkills(session?.agentId ?? "");
  const { events, activeDeltas, status, fileChange, turnLifecycleNonce } =
    useSessionEvents(id);
  const { send, isPending } = useSendMessage(id);
  const { interrupt, isPending: isInterrupting, requestAccepted: interruptRequested } = useInterrupt(id);
  const [fileSelection, setFileSelection] = useState<{ path: string; nonce: number }>();
  const openWorkspaceFile = useCallback((path: string) => {
    setFileSelection((previous) => ({ path, nonce: (previous?.nonce ?? 0) + 1 }));
  }, []);
  const [activeTab, setActiveTab] = useState("conversation");
  const [childTabState, setChildTabState] = useState<{ tabs: ChildTab[]; next: number }>({ tabs: [], next: 1 });
  const childTabs = childTabState.tabs;
  const openExecution = useCallback((execution: DelegationExecution) => {
    setChildTabState((state) => state.tabs.some((tab) => tab.execution.childId === execution.childId) ? state : {
      tabs: [...state.tabs, { execution, label: `Agent ${state.next}` }], next: state.next + 1,
    });
    setActiveTab(execution.childId);
  }, []);
  const closeChildSession = (childId: string) => {
    setChildTabState((state) => ({ ...state, tabs: state.tabs.filter((tab) => tab.execution.childId !== childId) }));
    if (activeTab === childId) setActiveTab("conversation");
  };

  // Whether input is waiting to run is the Host's fact, re-read whenever a Turn
  // starts or ends. This is what keeps the `queued` strip visible through the gap
  // an Interrupt opens and restores it after a reload (issue #114).
  const { entries: serverQueued, hasMore: hasMoreQueuedInput } = useQueuedInput(
    id,
    turnLifecycleNonce,
  );

  const queuedInput = serverQueued.map((entry) => ({
    id: entry.id,
    text: messageText(entry.data),
  }));

  const handleInterrupt = useCallback(async () => {
    if (isInterrupting) return;
    // Nothing to undo if the Host reports it stopped nothing: the Turn had
    // already finished, and the status the SSE stream reports will say so.
    await interrupt().catch(() => false);
  }, [interrupt, isInterrupting]);

  const truncatedId = id.length > 8 ? `${id.slice(0, 8)}...` : id;
  const effectiveTurnStatus = session?.status === "terminated" ? "idle" : status;
  const effectiveStatus = session?.status === "terminated" ? "terminated" : status === "running" || status === "waiting" ? status : (session?.status ?? "idle");

  if (sessionLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-4 border-b border-neutral-200 px-6 py-4">
          <Skeleton className="h-6 w-6" />
          <Skeleton className="h-5 w-48" />
        </div>
        <div className="flex-1 px-6 py-8">
          <Skeleton className="mx-auto h-64 max-w-3xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="session-header session-detail-header">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to Agent"
          onClick={() =>
            navigate(session ? `/agents/${session.agentId}` : "/agents")
          }
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="session-heading">
          <span className="session-title" title={session?.title || id}>
            {session?.title || truncatedId}
          </span>
          {session?.agent && (
            <>
              <span className="text-[var(--color-border)]">|</span>
              <span className="session-agent-name">
                {session.agent.name}
              </span>
            </>
          )}
          <StatusBadge status={effectiveStatus as "idle" | "running" | "waiting" | "terminated"} />
        </div>
        {session && <SessionShareDialog key={id} sessionId={id} title={session.title || id} events={events} />}
      </div>

      {interruptRequested && (status === "running" || status === "waiting") && <p role="status" className="px-6 py-2 text-xs">Interrupt requested. Waiting for the Turn to stop.</p>}
      <SplitWorkbench
        revealWorkspaceKey={fileSelection?.nonce}
        workspace={session && <WorkspacePanel workspaceId={session.workspaceId} workspaceName={workspaces.find((workspace) => workspace.id === session.workspaceId)?.name} refreshKey={fileChange.nonce} fileSelection={fileSelection} />}
        session={
          <>
            <div className="session-tabs overflow-x-auto" aria-label="Session tabs">
              <TabButton active={activeTab === "conversation"} onClick={() => setActiveTab("conversation")}>Conversation</TabButton>
              <TabButton active={activeTab === "timeline"} onClick={() => setActiveTab("timeline")}>Trajectry{events.length > 0 ? ` (${events.length})` : ""}</TabButton>
              {childTabs.map(({ execution, label }) => <div key={execution.childId} className="flex shrink-0 items-center" title={execution.prompt}>
                <TabButton active={activeTab === execution.childId} onClick={() => setActiveTab(execution.childId)}>{label}</TabButton>
                <button aria-label={`Close ${label}`} className="mr-2 rounded p-1 text-[var(--color-fg-subtle)] hover:bg-[var(--color-bg-muted)]" onClick={() => closeChildSession(execution.childId)}><X className="h-3 w-3" /></button>
              </div>)}
            </div>
            <div className="session-conversation-pane" hidden={activeTab !== "conversation"} inert={activeTab !== "conversation"}>
              <div className="min-h-0 flex-1 overflow-hidden">
                <ConversationView resources={session ? { agentId: session.agentId, skills: equippedSkills, onOpenWorkspacePath: openWorkspaceFile } : undefined} sessionId={id} onOpenExecution={openExecution} focusToolUseId={focusToolUseId} events={events} activeDeltas={activeDeltas} sessionStatus={effectiveTurnStatus} />
              </div>
              <MessageInput
                onSend={send}
                sending={isPending}
                queuedInput={queuedInput}
                hasMoreQueuedInput={hasMoreQueuedInput}
                skills={equippedSkills}
                disabled={session?.status === "terminated"}
                model={session?.agent?.model}
                running={effectiveTurnStatus === "running" || effectiveTurnStatus === "waiting"}
                onInterrupt={handleInterrupt}
              />
              <SessionUsageFooter events={events} />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden" hidden={activeTab !== "timeline"} inert={activeTab !== "timeline"}>
              <TimelineView events={events} />
            </div>
            {childTabs.map(({ execution, label }) => <div key={execution.childId} aria-label={`${label} conversation`} className="min-h-0 flex-1 overflow-hidden" hidden={activeTab !== execution.childId} inert={activeTab !== execution.childId}>
              <ChildSessionConversation onOpenExecution={openExecution} onOpenWorkspaceFile={openWorkspaceFile} sessionId={execution.childId} workspaceId={session?.workspaceId} />
            </div>)}
          </>
        }
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "relative shrink-0 whitespace-nowrap px-4 py-2.5 text-sm font-medium transition-colors",
        active ? "text-[var(--color-fg)]" : "text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)]",
      )}
    >
      {children}
      {active && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-[var(--color-fg)]" />
      )}
    </button>
  );
}
