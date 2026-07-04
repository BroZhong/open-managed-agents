import { useState, useCallback, useEffect, useMemo } from "react";
import { useParams, useNavigate } from "react-router";
import { ArrowLeft } from "lucide-react";
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
import { cn } from "@/lib/utils";
import type { SessionEvent } from "@/lib/types";

type Tab = "conversation" | "timeline" | "workspace";

export default function SessionDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: session, isLoading: sessionLoading } = useSession(id);
  const { events, status, isConnected, fileChange } = useSessionEvents(id);
  const { send, isPending } = useSendMessage(id);
  const [activeTab, setActiveTab] = useState<Tab>("conversation");
  const [optimisticEvents, setOptimisticEvents] = useState<SessionEvent[]>([]);

  // Remove optimistic events once real ones arrive via SSE
  useEffect(() => {
    if (optimisticEvents.length === 0) return;
    const hasConfirmed = events.some(
      (e) =>
        e.type === "user.message" &&
        optimisticEvents.some((oe) => {
          const oeData = oe.data as { content: Array<{ type: string; text: string }> };
          const eData = e.data as { content: Array<{ type: string; text: string }> };
          return oeData.content[0]?.text === eData.content[0]?.text;
        }),
    );
    if (hasConfirmed) {
      setOptimisticEvents([]);
    }
  }, [events, optimisticEvents]);

  const unconfirmedEvents = useMemo(() => {
    return optimisticEvents.filter(
      (oe) =>
        !events.some((e) => {
          if (e.type !== "user.message") return false;
          const oeData = oe.data as { content: Array<{ type: string; text: string }> };
          const eData = e.data as { content: Array<{ type: string; text: string }> };
          return oeData.content[0]?.text === eData.content[0]?.text;
        }),
    );
  }, [events, optimisticEvents]);

  const displayEvents = useMemo(() => {
    if (unconfirmedEvents.length === 0) return events;
    // Only show optimistic messages in conversation if agent is NOT running
    if (status === "running") return events;
    return [...events, ...unconfirmedEvents];
  }, [events, unconfirmedEvents, status]);

  const handleSend = useCallback(
    async (text: string) => {
      // Optimistically add user message
      const optimistic: SessionEvent = {
        seq: -Date.now(),
        type: "user.message",
        data: { content: [{ type: "text", text }] },
        ts: new Date().toISOString(),
      };
      setOptimisticEvents((prev) => [...prev, optimistic]);
      await send(text);
    },
    [send],
  );

  const truncatedId = id.length > 8 ? `${id.slice(0, 8)}...` : id;
  const effectiveStatus = status === "running" ? "running" : (session?.status ?? "idle");
  const inputDisabled = isPending;

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
          onClick={() => navigate("/sessions")}
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
        <>
          <div className="flex-1 overflow-hidden">
            <ConversationView events={displayEvents} sessionStatus={status} />
          </div>
          <MessageInput onSend={handleSend} disabled={inputDisabled} pendingMessages={status === "running" ? unconfirmedEvents : []} />
        </>
      ) : activeTab === "timeline" ? (
        <div className="flex-1 overflow-hidden">
          <TimelineView events={events} />
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          <WorkspacePanel sessionId={id} refreshKey={fileChange.nonce} />
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
