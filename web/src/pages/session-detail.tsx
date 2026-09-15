import { useState, useCallback, useMemo } from "react";
import { useParams, useNavigate, useLocation } from "react-router";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ConversationView } from "@/components/conversation-view";
import { TimelineView } from "@/components/timeline-view";
import { SplitWorkbench } from "@/components/split-workbench";
import { WorkspacePanel } from "@/components/workspace-panel";
import { MessageInput } from "@/components/message-input";
import { TokenUsageMetrics } from "@/components/token-usage-metrics";
import { useSession } from "@/lib/hooks/use-sessions";
import { useSessionEvents } from "@/lib/hooks/use-session-events";
import { useSendMessage } from "@/lib/hooks/use-send-message";
import { useInterrupt } from "@/lib/hooks/use-interrupt";
import { useAgentSkills } from "@/lib/hooks/use-skills";
import { useQueuedInput } from "@/lib/hooks/use-queued-input";
import { DelegationUsage } from "@/components/delegation-usage";
import { DelegationSources } from "@/components/delegation-sources";
import { cn } from "@/lib/utils";

/** Read the display text out of a `user.message` event payload. */
function messageText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : "";
}
import { summarizeTokenUsage } from "@/lib/token-usage";

type Tab = "conversation" | "timeline";

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
  const { data: equippedSkills = [] } = useAgentSkills(session?.agentId ?? "");
  const { events, activeDeltas, status, isConnected, fileChange, turnLifecycleNonce } =
    useSessionEvents(id);
  const { send, isPending } = useSendMessage(id);
  const { interrupt, isPending: isInterrupting, requestAccepted: interruptRequested } = useInterrupt(id);
  const [activeTab, setActiveTab] = useState<Tab>("conversation");

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
  const tokenUsage = useMemo(() => summarizeTokenUsage(events), [events]);

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
          {isConnected && (
            <span className="flex items-center gap-1 text-xs text-green-600">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              Live
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <details className="session-token-details"><summary>Usage <ChevronDown size={13} /></summary><TokenUsageMetrics usage={tokenUsage} /></details>

        </div>
      </div>

      <DelegationUsage sessionId={id} />
      <DelegationSources sessionId={id} origin />
      <DelegationSources sessionId={id} />
      {interruptRequested && (status === "running" || status === "waiting") && <p role="status" className="px-6 py-2 text-xs">Interrupt requested. Waiting for the Turn to stop.</p>}
      <SplitWorkbench
        workspace={session && <WorkspacePanel workspaceId={session.workspaceId} refreshKey={fileChange.nonce} />}
        session={
          <>
            <div className="session-tabs">
              <TabButton active={activeTab === "conversation"} onClick={() => setActiveTab("conversation")}>Conversation</TabButton>
              <TabButton active={activeTab === "timeline"} onClick={() => setActiveTab("timeline")}>Timeline{events.length > 0 ? ` (${events.length})` : ""}</TabButton>
            </div>
            <div className="session-conversation-pane" hidden={activeTab !== "conversation"} inert={activeTab !== "conversation"}>
              <div className="min-h-0 flex-1 overflow-hidden">
                <ConversationView sessionId={id} focusToolUseId={focusToolUseId} events={events} activeDeltas={activeDeltas} sessionStatus={effectiveTurnStatus} />
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
            </div>
            <div className="min-h-0 flex-1 overflow-hidden" hidden={activeTab !== "timeline"} inert={activeTab !== "timeline"}>
              <TimelineView events={events} />
            </div>
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
      className={cn(
        "relative px-4 py-2.5 text-sm font-medium transition-colors",
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
