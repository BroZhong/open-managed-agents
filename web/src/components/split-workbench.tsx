import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { FolderOpen, MessagesSquare, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useCompactPanel } from "@/lib/hooks/use-compact-panel";

const WIDTH_KEY = "oma_workspace_split";
const MIN = 35;
const MAX = 70;
const DEFAULT = 58;
const clamp = (value: number) => Math.min(MAX, Math.max(MIN, value));

/** One mounted instance of each pane preserves editors and drafts on resize. */
export function SplitWorkbench({ workspace, session, revealWorkspaceKey }: { workspace: ReactNode; session: ReactNode; revealWorkspaceKey?: number }) {
  const container = useRef<HTMLDivElement>(null);
  const compact = useCompactPanel(container, 820);
  const [pane, setPane] = useState<"workspace" | "session">("session");
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [lastRevealKey, setLastRevealKey] = useState(revealWorkspaceKey);
  if (lastRevealKey !== revealWorkspaceKey) {
    setLastRevealKey(revealWorkspaceKey);
    setWorkspaceOpen(true);
    setPane("workspace");
  }
  const [width, setWidth] = useState(() => {
    const stored = localStorage.getItem(WIDTH_KEY);
    const value = stored === null ? DEFAULT : Number(stored);
    return Number.isFinite(value) ? clamp(value) : DEFAULT;
  });
  const [dragging, setDragging] = useState(false);
  const showWorkspace = compact ? pane === "workspace" : workspaceOpen;
  const showSession = !compact || pane === "session";

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);

  return (
    <div ref={container} className="split-workbench" data-compact={compact}>
      <div className="workbench-view-bar">
        {compact ? (
          <div className="workbench-pane-picker" aria-label="Visible pane">
            <button type="button" aria-pressed={pane === "workspace"} onClick={() => setPane("workspace")}><FolderOpen />Workspace</button>
            <button type="button" aria-pressed={pane === "session"} onClick={() => setPane("session")}><MessagesSquare />Session</button>
          </div>
        ) : (
          <button
            type="button"
            className="workbench-layout-toggle"
            title={workspaceOpen ? "Hide workspace" : "Show workspace"}
            aria-label={workspaceOpen ? "Hide workspace" : "Show workspace"}
            aria-pressed={workspaceOpen}
            onClick={() => setWorkspaceOpen((open) => !open)}
          >
            {workspaceOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
            {workspaceOpen ? "Workspace & Session" : "Show workspace"}
          </button>
        )}
      </div>
      <div
        className="workbench-panes"
        data-split={!compact && workspaceOpen}
        data-dragging={dragging}
        style={{ "--workspace-share": `${width}fr`, "--session-share": `${100 - width}fr` } as CSSProperties}
      >
        <section className="workbench-workspace" aria-label="Workspace panel" hidden={!showWorkspace} inert={!showWorkspace}>
          {workspace}
        </section>
        {!compact && workspaceOpen && (
          <div
            role="separator"
            tabIndex={0}
            aria-label="Resize Workspace and Session"
            aria-orientation="vertical"
            aria-valuemin={MIN}
            aria-valuemax={MAX}
            aria-valuenow={Math.round(width)}
            aria-valuetext={`Workspace ${Math.round(width)}%, Session ${Math.round(100 - width)}%`}
            className="workbench-resizer"
            onDoubleClick={() => setWidth(DEFAULT)}
            onKeyDown={(event) => {
              const next = event.key === "ArrowLeft" ? width - 2 : event.key === "ArrowRight" ? width + 2 : event.key === "Home" ? MIN : event.key === "End" ? MAX : null;
              if (next !== null) { event.preventDefault(); setWidth(clamp(next)); }
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const rect = container.current?.getBoundingClientRect();
              if (rect?.width) setWidth(clamp((event.clientX - rect.left) / rect.width * 100));
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              setDragging(false);
            }}
            onPointerCancel={() => setDragging(false)}
            onLostPointerCapture={() => setDragging(false)}
          />
        )}
        <section className="workbench-session" aria-label="Session panel" hidden={!showSession} inert={!showSession}>
          {session}
        </section>
      </div>
    </div>
  );
}
