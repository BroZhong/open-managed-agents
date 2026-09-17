import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { ConversationView } from "@/components/conversation-view";
import { TimelineView } from "@/components/timeline-view";
import { SplitWorkbench } from "@/components/split-workbench";
import { FileManager } from "@/components/file-manager";
import { createSharedWorkspaceFileSource } from "@/lib/file-source";
import { createShareAccess, loadSharedHistory, type SharedSession } from "@/lib/share-api";
import { ApiError } from "@/lib/api";
import type { SessionEvent } from "@/lib/types";

export default function SharedSessionPage() {
  const { shareId = "" } = useParams();
  // Local state and file caches are destroyed when the share scope changes.
  return <SharedSessionContent key={shareId} shareId={shareId} />;
}

function SharedSessionContent({ shareId }: { shareId: string }) {
  const [data, setData] = useState<{ session: SharedSession; events: SessionEvent[]; revision: number }>();
  const [error, setError] = useState<Error>();
  const [unavailable, setUnavailable] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("conversation");
  const [fileSelection, setFileSelection] = useState<{ path: string; nonce: number }>();
  const access = useMemo(() => createShareAccess(shareId, () => setUnavailable(true)), [shareId]);
  const workspaceId = data?.session.workspaceId;
  const source = useMemo(() => workspaceId ? createSharedWorkspaceFileSource(workspaceId, access) : undefined, [workspaceId, access]);
  const openFile = useCallback((path: string) => setFileSelection((previous) => ({ path, nonce: (previous?.nonce ?? 0) + 1 })), []);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError(undefined);
      try {
        const scope = await access.json<{ sessionId: string }>(`/v1/shares/${encodeURIComponent(shareId)}`);
        const [session, events] = await Promise.all([
          access.json<SharedSession>(`/v1/sessions/${encodeURIComponent(scope.sessionId)}`),
          loadSharedHistory(access, scope.sessionId),
        ]);
        if (active) setData({ session, events, revision });
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause : new Error("Could not load share"));
      } finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [access, shareId, revision]);

  if (unavailable || error instanceof ApiError && [401, 403, 404].includes(error.status)) {
    return <main className="p-10 text-center"><h1>分享已失效</h1><p role="alert">此 Session 或 Workspace 已不可用。</p></main>;
  }
  return <main className="flex h-dvh flex-col">
    <header className="session-header session-detail-header">
      <div className="session-heading"><h1 className="session-title">{data?.session.title || "Shared Session"}</h1><span className="session-agent-name">只读分享</span></div>
      <Button variant="outline" aria-label="Refresh share" disabled={loading} onClick={() => setRevision((value) => value + 1)}>刷新</Button>
    </header>
    {error && <p role="alert" className="p-4">加载失败：{error.message}。请重试刷新。</p>}
    {!data && loading && <p role="status" className="p-6">正在加载分享…</p>}
    {data && source && <SplitWorkbench revealWorkspaceKey={fileSelection?.nonce}
      workspace={<FileManager source={source} turnStatus="idle" presentation="workbench" rootLabel="Workspace" refreshKey={data.revision} fileSelection={fileSelection} selectionHint="Browse the shared Workspace. Files are read-only." />}
      session={<>
        <div className="session-tabs">
          <Button variant="ghost" aria-pressed={tab === "conversation"} onClick={() => setTab("conversation")}>Conversation</Button>
          <Button variant="ghost" aria-pressed={tab === "trajectory"} onClick={() => setTab("trajectory")}>Trajectory ({data.events.length})</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "conversation" ? <ConversationView events={data.events} sessionStatus="idle" resources={{ shared: true, agentId: "", skills: [], onOpenWorkspacePath: openFile }} /> : <TimelineView events={data.events} />}
        </div>
      </>}
    />}
  </main>;
}
