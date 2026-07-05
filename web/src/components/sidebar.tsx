import { useState, useEffect, createContext, useContext } from "react"
import { useLocation, useParams, useNavigate, Link } from "react-router"
import {
  LayoutDashboard,
  Bot,
  Key,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Plus,
  Settings,
  FolderClosed,
  MessagesSquare,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"
import { useAgent } from "@/lib/hooks/use-agents"
import {
  useSession,
  useAgentSessions,
  useCreateSession,
  type Session,
} from "@/lib/hooks/use-sessions"
import { useWorkspaces, type Workspace } from "@/lib/hooks/use-workspaces"
import { StatusBadge } from "@/components/status-badge"

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
const navItems = [
  { label: "Overview", icon: LayoutDashboard, path: "/" },
  { label: "Agents", icon: Bot, path: "/agents" },
  { label: "API Keys", icon: Key, path: "/api-keys" },
]

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === "true"
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
  if (onAgent) return params.id as string
  if (onSession && session) return session.agentId
  return null
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === "true"
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
      className={cn(
        "fixed left-0 top-0 z-20 flex h-screen flex-col border-r bg-[var(--color-bg-surface)] transition-all duration-200",
        "border-[var(--color-border)]",
        collapsed ? "w-[52px]" : "w-[224px]"
      )}
    >
      {/* Header / Brand */}
      <div className="flex h-14 items-center px-3">
        <span className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">
          {collapsed ? "O" : "OMA"}
        </span>
      </div>

      {/* Navigation — swaps between the global context (Agents list, …) and
          the in-Agent context (the current Agent + its workspaces & chats). */}
      <nav className="flex-1 overflow-y-auto space-y-0.5 px-2 py-2">
        {activeAgentId ? (
          <AgentContextNav agentId={activeAgentId} collapsed={collapsed} />
        ) : (
          navItems.map((item) => {
            const isActive =
              location.pathname === item.path ||
              location.pathname.startsWith(item.path + "/")
            const Icon = item.icon

            const linkContent = (
              <Link
                key={item.path}
                to={item.path}
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

            return linkContent
          })
        )}
      </nav>

      {/* Bottom area */}
      <div className="space-y-0.5 border-t border-[var(--color-border)] px-2 py-3">
        {collapsed ? (
          <Tooltip content="Logout">
            <Button
              variant="ghost"
              size="icon"
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
  const active = location.pathname === `/sessions/${session.id}`
  const label = session.title ?? session.id
  return (
    <Link
      to={`/sessions/${session.id}`}
      className={cn(
        "flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors",
        active
          ? "bg-[var(--color-bg-muted)] text-[var(--color-fg)]"
          : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]",
      )}
    >
      <span className={cn("truncate", session.title ? "" : "font-mono")}>{label}</span>
      <StatusBadge status={session.status} />
    </Link>
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
  const { data: sessions } = useAgentSessions(agentId)
  const { data: workspaces } = useWorkspaces()
  const createSession = useCreateSession()

  const [workspacesOpen, setWorkspacesOpen] = useState(true)
  const [openWorkspaces, setOpenWorkspaces] = useState<Record<string, boolean>>({})

  if (collapsed) {
    return (
      <Tooltip content="All Agents">
        <Link
          to="/agents"
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
  for (const s of sessions ?? []) {
    const list = sessionsByWorkspace.get(s.workspaceId) ?? []
    list.push(s)
    sessionsByWorkspace.set(s.workspaceId, list)
  }
  const usedWorkspaces = [...namedById.values()].filter((w) =>
    sessionsByWorkspace.has(w.id),
  )
  // Loose chats = sessions whose workspace is not a named one (anonymous).
  const looseChats = (sessions ?? []).filter((s) => !namedById.has(s.workspaceId))

  function newChat() {
    createSession.mutate(agentId, {
      onSuccess: (session) => navigate(`/sessions/${session.id}`),
      onError: (err) => toast.error(err.message || "Failed to start chat"),
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

      {/* agent — opens the Agent's config detail (files, skills, model). */}
      <Link
        to={`/agents/${agentId}`}
        className={cn(
          "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
          location.pathname === `/agents/${agentId}`
            ? "bg-[var(--color-bg-muted)] text-[var(--color-fg)]"
            : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]",
        )}
      >
        <Settings className="h-[18px] w-[18px] shrink-0" />
        <span>agent</span>
      </Link>

      {/* + New chat — a loose session bound to a fresh anonymous workspace. */}
      <button
        type="button"
        onClick={newChat}
        disabled={createSession.isPending}
        className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-muted)] disabled:opacity-50"
      >
        <Plus className="h-[18px] w-[18px] shrink-0" />
        <span>{createSession.isPending ? "Starting…" : "New chat"}</span>
      </button>

      {/* workspaces — named Workspaces this Agent uses (collapsible). */}
      <div className="pt-2">
        <button
          type="button"
          onClick={() => setWorkspacesOpen((o) => !o)}
          className="flex w-full items-center gap-1.5 px-2.5 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-400 hover:text-[var(--color-fg-muted)]"
        >
          {workspacesOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          <span>workspaces</span>
        </button>
        {workspacesOpen && (
          <div className="space-y-0.5">
            {usedWorkspaces.length === 0 && (
              <p className="px-2.5 py-1 text-xs text-neutral-400">None</p>
            )}
            {usedWorkspaces.map((w) => {
              const wsOpen = openWorkspaces[w.id] ?? false
              const wsSessions = sessionsByWorkspace.get(w.id) ?? []
              return (
                <div key={w.id}>
                  <button
                    type="button"
                    onClick={() =>
                      setOpenWorkspaces((prev) => ({ ...prev, [w.id]: !wsOpen }))
                    }
                    className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]"
                  >
                    {wsOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <FolderClosed className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{w.name}</span>
                  </button>
                  {wsOpen && (
                    <div className="ml-3 space-y-0.5 border-l border-[var(--color-border)] pl-1">
                      {wsSessions.map((s) => (
                        <SessionLink key={s.id} session={s} />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* chats — flat list of loose (anonymous-workspace) sessions. */}
      <div className="pt-2">
        <p className="flex items-center gap-1.5 px-2.5 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
          <MessagesSquare className="h-3.5 w-3.5" />
          chats
        </p>
        {looseChats.length === 0 && (
          <p className="px-2.5 py-1 text-xs text-neutral-400">None yet</p>
        )}
        {looseChats.map((s) => (
          <SessionLink key={s.id} session={s} />
        ))}
      </div>
    </div>
  )
}
