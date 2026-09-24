import { SidebarItemActions } from "@/components/sidebar-item-actions"
import { useState, useEffect, useRef, createContext, useContext } from "react"
import { useLocation, useParams, useNavigate, Link } from "react-router"
import {
  LayoutDashboard,
  Bot,
  BookOpen,
  Plug,
  Key,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Plus,
  FolderClosed,
  MessagesSquare,
  Repeat2,
  MoreHorizontal,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { runningSessionsFirst } from "@/lib/session-order"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"
import { useAgent } from "@/lib/hooks/use-agents"
import {
  useSession,
  useAgentSessions,
  useCreateSession,
  useLoopSessions,
  useUpdateSession,
  type Session,
} from "@/lib/hooks/use-sessions"
import {
  useWorkspaces,
  useCreateWorkspace,
  useUpdateWorkspace,
  useDeleteWorkspace,
  type Workspace,
} from "@/lib/hooks/use-workspaces"
import { StatusBadge } from "@/components/status-badge"
import {
  useAgentLoops,
  useRunLoop,
  useUpdateLoop,
  type Loop,
} from "@/lib/hooks/use-loops"
import { BrandMark } from "@/components/brand-mark"
import { CreateLoopDialog } from "@/components/create-loop-dialog"

const STORAGE_KEY = "oma_sidebar_collapsed"

interface SidebarContextValue {
  collapsed: boolean
}

const SidebarContext = createContext<SidebarContextValue>({ collapsed: false })

export function useSidebarState() {
  return useContext(SidebarContext)
}

// Agents are the primary subject of the console (Agent-centric entry). Sessions
// are no longer a global nav item — they are only reached through an Agent.
const navGroups = [
  {
    label: "Agent Platform",
    items: [
      { label: "Dashboard", icon: LayoutDashboard, path: "/" },
      { label: "Agent", icon: Bot, path: "/agents" },
    ],
  },
  {
    label: "Resources",
    items: [
      { label: "Skill", icon: BookOpen, path: "/skills" },
      { label: "MCP", icon: Plug, path: "/mcp" },
      { label: "Models", icon: Plug, path: "/model-providers" },
    ],
  },
  {
    label: "Configuration",
    items: [{ label: "API-Key", icon: Key, path: "/api-keys" }],
  },
]

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === "true" || (localStorage.getItem(STORAGE_KEY) === null && window.innerWidth < 768)
  })

  return (
    <SidebarContext.Provider value={{ collapsed }}>
      {children}
    </SidebarContext.Provider>
  )
}

/**
 * Resolve the Agent whose context the sidebar should show, from the route:
 * `/agents/:id` directly, or `/sessions/:id` via the session's `agentId`.
 * Returns null in the global context (Agents list, API keys, …).
 */
function useActiveAgentId(): string | null {
  const location = useLocation()
  const params = useParams()
  const onAgent = location.pathname.startsWith("/agents/") && !!params.id
  const onSession = location.pathname.startsWith("/sessions/") && !!params.id
  const { data: session } = useSession(onSession ? (params.id as string) : "")
  const navigationAgentId =
    location.state &&
    typeof location.state === "object" &&
    typeof (location.state as { agentId?: unknown }).agentId === "string"
      ? (location.state as { agentId: string }).agentId
      : null
  if (onAgent) return params.id as string
  if (onSession) return session?.agentId ?? navigationAgentId
  return null
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === "true" || (localStorage.getItem(STORAGE_KEY) === null && window.innerWidth < 768)
  })
  const location = useLocation()
  const { logout } = useAuth()
  const activeAgentId = useActiveAgentId()

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(collapsed))
    window.dispatchEvent(new CustomEvent("sidebar-toggle", { detail: { collapsed } }))
  }, [collapsed])

  return (
    <aside
      id="console-sidebar"
      className="app-sidebar"
      data-collapsed={collapsed}
      aria-label="Console sidebar"
    >
      {/* Header / Brand */}
      <Link to="/" className="sidebar-brand" aria-label="OMA home">
        <BrandMark />
        {!collapsed && <span className="sidebar-brand-name">OMA<span>Managed agents</span></span>}
      </Link>

      {/* Navigation — swaps between the global context (Agents list, …) and
          the in-Agent context (the current Agent + its workspaces & chats). */}
      <nav
        aria-label="Main navigation"
        className="sidebar-navigation flex-1 overflow-y-auto space-y-0.5 px-2 py-2"
        onClick={(event) => {
          if (window.innerWidth < 768 && (event.target as HTMLElement).closest("a")) {
            setCollapsed(true)
          }
        }}
      >
        {activeAgentId ? (
          <AgentContextNav agentId={activeAgentId} collapsed={collapsed} />
        ) : (
          <div className={cn("space-y-4", collapsed && "space-y-1")}>
            {navGroups.map((group) => (
              <div key={group.label} className="space-y-0.5">
                {!collapsed && (
                  <p className="px-2.5 pb-1 text-[11px] font-medium text-[var(--color-fg-subtle)]">
                    {group.label}
                  </p>
                )}
                {group.items.map((item) => {
                  const isActive =
                    location.pathname === item.path ||
                    location.pathname.startsWith(item.path + "/")
                  const Icon = item.icon

                  const linkContent = (
                    <Link
                      to={item.path}
                      aria-label={item.label}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
                        isActive
                          ? "bg-[var(--color-bg-muted)] text-[var(--color-fg)]"
                          : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
                      )}
                    >
                      <Icon className="h-[18px] w-[18px] shrink-0" />
                      {!collapsed && <span>{item.label}</span>}
                    </Link>
                  )

                  if (collapsed) {
                    return (
                      <Tooltip key={item.path} content={item.label}>
                        {linkContent}
                      </Tooltip>
                    )
                  }

                  return <div key={item.path}>{linkContent}</div>
                })}
              </div>
            ))}
          </div>
        )}
      </nav>

      {/* Bottom area */}
      <div className="sidebar-footer space-y-0.5 px-2 py-3">
        {collapsed ? (
          <Tooltip content="Logout">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Logout"
              onClick={logout}
              className="w-full"
            >
              <LogOut className="h-[18px] w-[18px]" />
            </Button>
          </Tooltip>
        ) : (
          <Button
            variant="ghost"
            onClick={logout}
            className="w-full justify-start gap-3 px-2.5 text-[var(--color-fg-muted)]"
          >
            <LogOut className="h-[18px] w-[18px] shrink-0" />
            <span className="text-sm">Logout</span>
          </Button>
        )}

        {collapsed ? (
          <Tooltip content="Expand sidebar">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Expand sidebar"
              onClick={() => setCollapsed(false)}
              className="w-full"
            >
              <PanelLeftOpen className="h-[18px] w-[18px]" />
            </Button>
          </Tooltip>
        ) : (
          <Button
            variant="ghost"
            onClick={() => setCollapsed(true)}
            className="w-full justify-start gap-3 px-2.5 text-[var(--color-fg-muted)]"
          >
            <PanelLeftClose className="h-[18px] w-[18px] shrink-0" />
            <span className="text-sm">Collapse</span>
          </Button>
        )}
      </div>
    </aside>
  )
}

/** A session row: `title ?? id` + status badge, linking to the chat. */
function SessionLink({ session }: { session: Session }) {
  const location = useLocation()
  const navigate = useNavigate()
  const update = useUpdateSession()
  const active = location.pathname === `/sessions/${session.id}`
  const label = session.title ?? session.id
  return (
    <div className={cn("flex items-center rounded-lg text-xs transition-colors", active
      ? "bg-[var(--color-bg-muted)] text-[var(--color-fg)]"
      : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]")}>
      <Link to={`/sessions/${session.id}`} state={{ agentId: session.agentId }} className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2.5 py-1.5">
        <span className={cn("truncate", session.title ? "" : "font-mono")}>{label}</span>
        <StatusBadge status={session.status} />
      </Link>
      <SidebarItemActions kind="Session" label={label}
        onRename={(title) => update.mutateAsync({ id: session.id, title })}
        onDelete={async () => {
          await update.mutateAsync({ id: session.id, deleted: true })
          if (active) navigate(`/agents/${session.agentId}`)
        }} />
    </div>
  )
}

/**
 * In-Agent sidebar context, mirroring the FastClaw chat sidebar
 * (docs/design/fc_chat.png):
 *   - a "back to all Agents" switcher + the current Agent name,
 *   - an `agent` entry that opens the Agent's config detail,
 *   - `+ New chat` (creates a loose session in a fresh anonymous workspace),
 *   - a collapsible `workspaces` group (the named Workspaces this Agent uses),
 *   - a flat `chats` group (loose sessions, i.e. in an unnamed workspace).
 */
function AgentContextNav({ agentId, collapsed }: { agentId: string; collapsed: boolean }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { data: agent } = useAgent(agentId)
  const { data: sessions } = useAgentSessions(agentId, { excludeDelegated: true })
  const { data: workspaces } = useWorkspaces()
  const { data: loops } = useAgentLoops(agentId)
  const createSession = useCreateSession()
  const createWorkspace = useCreateWorkspace()

  const [workspacesOpen, setWorkspacesOpen] = useState(true)
  const [loopsOpen, setLoopsOpen] = useState(true)
  const [createLoopOpen, setCreateLoopOpen] = useState(false)
  const [openWorkspaces, setOpenWorkspaces] = useState<Record<string, boolean>>({})
  // Inline "new named Workspace" input, toggled by the WORKSPACES header `+`.
  const [newWorkspaceName, setNewWorkspaceName] = useState<string | null>(null)
  const creatingWorkspace = createWorkspace.isPending || createSession.isPending

  if (collapsed) {
    return (
      <Tooltip content="All Agents">
        <Link
          to="/agents"
          aria-label="All Agents"
          className="flex items-center justify-center rounded-lg px-2.5 py-2 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]"
        >
          <ChevronLeft className="h-[18px] w-[18px]" />
        </Link>
      </Tooltip>
    )
  }

  // Named workspaces this Agent actually uses = the intersection of the tenant's
  // named Workspaces with the workspaceIds bound by this Agent's sessions.
  const namedById = new Map<string, Workspace>()
  for (const w of workspaces ?? []) {
    if (w.name) namedById.set(w.id, w)
  }
  const sessionsByWorkspace = new Map<string, Session[]>()
  const orderedSessions = runningSessionsFirst(sessions ?? [])
  for (const s of orderedSessions) {
    if (s.loopId) continue
    const list = sessionsByWorkspace.get(s.workspaceId) ?? []
    list.push(s)
    sessionsByWorkspace.set(s.workspaceId, list)
  }
  const usedWorkspaces = [...namedById.values()].filter((w) =>
    sessionsByWorkspace.has(w.id),
  )
  // Loose chats = sessions whose workspace is not a named one (anonymous).
  const looseChats = orderedSessions.filter(
    (s) => !s.loopId && !namedById.has(s.workspaceId),
  )

  function newChat() {
    createSession.mutate(agentId, {
      onSuccess: (session) =>
        navigate(`/sessions/${session.id}`, {
          state: { agentId: session.agentId },
        }),
      onError: (err) => toast.error(err.message || "Failed to start chat"),
    })
  }

  // Create a named Workspace, then a Session bound to it, then navigate in.
  function submitNewWorkspace() {
    const name = newWorkspaceName?.trim()
    if (!name || creatingWorkspace) return
    createWorkspace.mutate(name, {
      onSuccess: (workspace) => {
        setWorkspacesOpen(true)
        createSession.mutate(
          { agentId, workspaceId: workspace.id },
          {
            onSuccess: (session) => {
              setNewWorkspaceName(null)
              navigate(`/sessions/${session.id}`, {
                state: { agentId: session.agentId },
              })
            },
            onError: (err) => toast.error(err.message || "Failed to start chat"),
          },
        )
      },
      onError: (err) => toast.error(err.message || "Failed to create workspace"),
    })
  }

  return (
    <div className="space-y-2">
      <Link
        to="/agents"
        className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
      >
        <ChevronLeft className="h-4 w-4" />
        All Agents
      </Link>

      <Link
        to={`/agents/${agentId}`}
        className={cn(
          "flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-semibold transition-colors",
          location.pathname === `/agents/${agentId}`
            ? "bg-[var(--color-bg-muted)] text-[var(--color-fg)]"
            : "text-[var(--color-fg)] hover:bg-[var(--color-bg-muted)]",
        )}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
          <Bot className="h-4 w-4" />
        </span>
        <span className="truncate">{agent?.name ?? "Agent"}</span>
      </Link>

      {/* Loops are recurring instructions owned by this Agent. Each Loop
          expands to the Sessions it created, separate from loose Sessions. */}
      <div className="pt-2">
        <div className="flex items-center pr-1">
          <button
            type="button"
            onClick={() => setLoopsOpen((open) => !open)}
            className="flex flex-1 items-center gap-1.5 px-2.5 pb-1 text-xs font-medium text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)]"
          >
            {loopsOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            <Repeat2 className="h-3.5 w-3.5" />
            <span>loops</span>
          </button>
          <Tooltip content="New Loop">
            <button
              type="button"
              aria-label="New Loop"
              onClick={() => setCreateLoopOpen(true)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-[var(--color-accent-muted)] hover:text-[var(--color-accent)]"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
        {loopsOpen && (
          <div className="space-y-0.5 pl-2">
            {(loops ?? []).length === 0 && (
              <p className="px-2.5 py-1 text-xs text-neutral-400">None yet</p>
            )}
            {(loops ?? []).map((loop) => (
              <LoopRow key={loop.id} loop={loop} />
            ))}
          </div>
        )}
      </div>

      {/* workspaces — named Workspaces this Agent uses (collapsible).
          Note: the Agent config link is the header above; there is no separate
          `agent` settings row (it duplicated the header). `New chat` lives in
          the CHATS section header `+`, not as a top-level button. */}
      <div className="pt-2">
        <div className="flex items-center pr-1">
          <button
            type="button"
            onClick={() => setWorkspacesOpen((o) => !o)}
            className="flex flex-1 items-center gap-1.5 px-2.5 pb-1 text-xs font-medium text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)]"
          >
            {workspacesOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            <span>workspaces</span>
          </button>
          <Tooltip content="New workspace">
            <button
              type="button"
              onClick={() => {
                setWorkspacesOpen(true)
                setNewWorkspaceName((v) => (v === null ? "" : v))
              }}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-[var(--color-accent-muted)] hover:text-[var(--color-accent)]"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
        {workspacesOpen && newWorkspaceName !== null && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              submitNewWorkspace()
            }}
            className="px-2.5 py-1"
          >
            <input
              autoFocus
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.target.value)}
              onBlur={() => {
                if (!newWorkspaceName.trim() && !creatingWorkspace) setNewWorkspaceName(null)
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setNewWorkspaceName(null)
              }}
              disabled={creatingWorkspace}
              placeholder="Workspace name…"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-2 py-1 text-xs text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
            />
          </form>
        )}
        {workspacesOpen && (
          <div className="space-y-0.5 pl-2">
            {usedWorkspaces.length === 0 && (
              <p className="px-2.5 py-1 text-xs text-neutral-400">None</p>
            )}
            {usedWorkspaces.map((w) => (
              <WorkspaceRow
                key={w.id}
                workspace={w}
                agentId={agentId}
                sessions={sessionsByWorkspace.get(w.id) ?? []}
                open={openWorkspaces[w.id] ?? false}
                onToggle={() =>
                  setOpenWorkspaces((prev) => ({ ...prev, [w.id]: !(prev[w.id] ?? false) }))
                }
                onExpand={() =>
                  setOpenWorkspaces((prev) => ({ ...prev, [w.id]: true }))
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* chats — flat list of loose (anonymous-workspace) sessions. */}
      <div className="pt-2">
        <div className="flex items-center pr-1">
          <p className="flex flex-1 items-center gap-1.5 px-2.5 pb-1 text-xs font-medium text-[var(--color-fg-subtle)]">
            <MessagesSquare className="h-3.5 w-3.5" />
            chats
          </p>
          <Tooltip content="New chat">
            <button
              type="button"
              onClick={newChat}
              disabled={createSession.isPending}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-[var(--color-accent-muted)] hover:text-[var(--color-accent)] disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
        <div className="space-y-0.5 pl-2">
          {looseChats.length === 0 && (
            <p className="px-2.5 py-1 text-xs text-neutral-400">None yet</p>
          )}
          {looseChats.map((s) => (
            <SessionLink key={s.id} session={s} />
          ))}
        </div>
      </div>
      <CreateLoopDialog
        agentId={agentId}
        open={createLoopOpen}
        onOpenChange={setCreateLoopOpen}
      />
    </div>
  )
}

function LoopRow({ loop }: { loop: Loop }) {
  const [open, setOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const updateLoop = useUpdateLoop()
  const runLoop = useRunLoop()
  const {
    data: sessions,
    isLoading,
    isError,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useLoopSessions(loop.id, open, { excludeDelegated: true })

  useEffect(() => {
    if (!menuOpen) return
    function onDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [menuOpen])

  function toggleEnabled() {
    updateLoop.mutate(
      { id: loop.id, enabled: !loop.enabled },
      {
        onSuccess: (updated) => {
          setMenuOpen(false)
          toast.success(updated.enabled ? "Loop resumed" : "Loop paused")
        },
        onError: (error) => toast.error(error.message || "Failed to update Loop"),
      },
    )
  }

  function runNow() {
    runLoop.mutate(loop.id, {
      onSuccess: () => {
        setMenuOpen(false)
        setOpen(true)
        toast.success("Loop started")
      },
      onError: (error) =>
        toast.error(error.message || "Failed to start Loop Session"),
    })
  }

  return (
    <div>
      <div className="group flex items-center rounded-lg text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-left"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{loop.name}</span>
          {!loop.enabled && <span className="text-[10px] text-neutral-400">paused</span>}
        </button>
        <div ref={menuRef} className="relative">
          <button
            type="button"
            aria-label={`Loop actions for ${loop.name}`}
            onClick={() => setMenuOpen((value) => !value)}
            className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 opacity-0 transition-opacity hover:bg-[var(--color-accent-muted)] hover:text-[var(--color-accent)] group-hover:opacity-100 data-[open=true]:opacity-100"
            data-open={menuOpen}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-6 z-30 w-32 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-surface)] py-1 shadow-md">
              <button
                type="button"
                onClick={toggleEnabled}
                disabled={updateLoop.isPending}
                className="flex w-full items-center px-3 py-1.5 text-left text-xs text-[var(--color-fg)] hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
              >
                {loop.enabled ? "Pause Loop" : "Resume Loop"}
              </button>
              <button
                type="button"
                onClick={runNow}
                disabled={runLoop.isPending}
                className="flex w-full items-center px-3 py-1.5 text-left text-xs text-[var(--color-fg)] hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
              >
                Start now
              </button>
            </div>
          )}
        </div>
      </div>
      {open && (
        <div className="space-y-0.5 pl-3">
          {isLoading && (
            <p className="px-2.5 py-1 text-xs text-neutral-400">Loading Sessions…</p>
          )}
          {isError && (
            <p className="px-2.5 py-1 text-xs text-red-500">Could not load Sessions</p>
          )}
          {!isLoading && !isError && (sessions ?? []).length === 0 && (
            <p className="px-2.5 py-1 text-xs text-neutral-400">No Sessions yet</p>
          )}
          {runningSessionsFirst(sessions ?? []).map((session) => (
            <SessionLink key={session.id} session={session} />
          ))}
          {hasNextPage && (
            <button
              type="button"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--color-accent)] hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
            >
              {isFetchingNextPage ? "Loading…" : "Load older Sessions"}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A single named-Workspace row in the sidebar: an expand toggle + folder name,
 * an `…` menu (Rename / Delete), a new Session `+`, and — when expanded — the
 * Workspace's Sessions nested beneath it. Delete hides the Workspace; `+`
 * creates a Session bound to this Workspace and navigates into it.
 */
function WorkspaceRow({ workspace, agentId, sessions, open, onToggle, onExpand }: {
  workspace: Workspace
  agentId: string
  sessions: Session[]
  open: boolean
  onToggle: () => void
  onExpand: () => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const createSession = useCreateSession()
  const updateWorkspace = useUpdateWorkspace()
  const deleteWorkspace = useDeleteWorkspace()

  function newChatHere() {
    if (createSession.isPending) return
    onExpand()
    createSession.mutate({ agentId, workspaceId: workspace.id }, {
      onSuccess: (session) => navigate(`/sessions/${session.id}`, { state: { agentId: session.agentId } }),
      onError: (err) => toast.error(err.message || "Failed to start chat"),
    })
  }

  return <div>
    <div className="flex items-center rounded-lg text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]">
      <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5">
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <FolderClosed className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{workspace.name}</span>
      </button>
      <SidebarItemActions kind="Workspace" label={workspace.name ?? workspace.id}
        onRename={(name) => updateWorkspace.mutateAsync({ id: workspace.id, name })}
        onDelete={async () => {
          await deleteWorkspace.mutateAsync(workspace.id)
          if (sessions.some((session) => location.pathname === `/sessions/${session.id}`)) navigate(`/agents/${agentId}`)
        }} />
      <Tooltip content="New session here">
        <button
          type="button"
          aria-label={`New session in ${workspace.name ?? workspace.id}`}
          onClick={newChatHere}
          disabled={createSession.isPending}
          className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-[var(--color-accent-muted)] hover:text-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
    </div>
    {open && <div className="ml-3 space-y-0.5 border-l border-[var(--color-border)] pl-1">
      {sessions.map((session) => <SessionLink key={session.id} session={session} />)}
    </div>}
  </div>
}
