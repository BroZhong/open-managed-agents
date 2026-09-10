import { useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router";
import { ArrowLeft, FolderOpen, PanelRight, PanelRightClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ConversationView } from "@/components/conversation-view";
import { TimelineView } from "@/components/timeline-view";
import { WorkspacePanel } from "@/components/workspace-panel";
import { MessageInput } from "@/components/message-input";
import { useSession } from "@/lib/hooks/use-sessions";
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

type Tab = "conversation" | "timeline" | "workspace";

export default function SessionDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  // Route parameter changes reuse the page. Give each Session its own composer,
  // queue observer, and event stream so none survive into another one.
  return <SessionDetail key={id} id={id} />;
}

function SessionDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const { data: session, isLoading: sessionLoading } = useSession(id);
  const { data: equippedSkills = [] } = useAgentSkills(session?.agentId ?? "");
  const { events, activeDeltas, status, isConnected, fileChange, turnLifecycleNonce } =
    useSessionEvents(id);
  const { send, isPending } = useSendMessage(id);
  const { interrupt, isPending: isInterrupting } = useInterrupt(id);
  const [activeTab, setActiveTab] = useState<Tab>("conversation");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

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
  const effectiveStatus = status === "running" ? "running" : (session?.status ?? "idle");

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
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] px-6 py-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() =>
            navigate(session ? `/agents/${session.agentId}` : "/agents")
          }
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-[var(--color-fg-muted)]">
            {truncatedId}
          </span>
          {session?.agent && (
            <>
              <span className="text-[var(--color-border)]">|</span>
              <span className="text-sm font-medium text-[var(--color-fg)]">
                {session.agent.name}
              </span>
            </>
          )}
          <StatusBadge status={effectiveStatus as "idle" | "running" | "terminated"} />
          {isConnected && (
            <span className="flex items-center gap-1 text-xs text-green-600">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              Live
            </span>
          )}
        </div>
        {activeTab === "conversation" && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto"
            onClick={() => setWorkspaceOpen((v) => !v)}
            title={workspaceOpen ? "Hide workspace" : "Show workspace"}
            aria-pressed={workspaceOpen}
          >
            {workspaceOpen ? (
              <PanelRightClose className="h-4 w-4" />
            ) : (
              <PanelRight className="h-4 w-4" />
            )}
          </Button>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] px-6">
        <TabButton
          active={activeTab === "conversation"}
          onClick={() => setActiveTab("conversation")}
        >
          Conversation
        </TabButton>
        <TabButton
          active={activeTab === "timeline"}
          onClick={() => setActiveTab("timeline")}
        >
          Timeline{events.length > 0 ? ` (${events.length})` : ""}
        </TabButton>
        <TabButton
          active={activeTab === "workspace"}
          onClick={() => setActiveTab("workspace")}
        >
          Workspace
        </TabButton>
      </div>

      {/* Content */}
      {activeTab === "conversation" ? (
        <div className="flex min-h-0 flex-1">
          {/* Conversation column */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex-1 overflow-hidden">
              <ConversationView
                events={events}
                activeDeltas={activeDeltas}
                sessionStatus={status}
              />
            </div>
            <MessageInput
              onSend={send}
              sending={isPending}
              // Not gated on `status === "running"`: the queue outlives the Turn
              // that was running when it was filled (issue #114).
              queuedInput={queuedInput}
              hasMoreQueuedInput={hasMoreQueuedInput}
              skills={equippedSkills}
              running={status === "running"}
              onInterrupt={handleInterrupt}
            />
          </div>
          {/* Slide-out Workspace panel */}
          <div
            className={cn(
              "flex-shrink-0 overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-bg)] transition-all duration-200 ease-in-out",
              workspaceOpen ? "w-[28rem]" : "w-0",
            )}
          >
            {workspaceOpen && (
              <div className="flex h-full w-[28rem] flex-col">
                <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 py-2.5">
                  <FolderOpen className="h-4 w-4 text-[var(--color-fg-muted)]" />
                  <span className="text-sm font-medium text-[var(--color-fg)]">
                    Workspace
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  <WorkspacePanel
                    sessionId={id}
                    refreshKey={fileChange.nonce}
                    turnStatus={status === "running" ? "running" : "idle"}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      ) : activeTab === "timeline" ? (
        <div className="flex-1 overflow-hidden">
          <TimelineView events={events} />
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          <WorkspacePanel
            sessionId={id}
            refreshKey={fileChange.nonce}
            turnStatus={status === "running" ? "running" : "idle"}
          />
        </div>
      )}
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
