import { useState, useEffect, createContext, useContext } from "react"
import { useLocation, useParams, Link } from "react-router"
import {
  MessageSquare,
  Bot,
  Key,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  ChevronLeft,
  Plus,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"
import { useAgent } from "@/lib/hooks/use-agents"
import { useSession, useAgentSessions } from "@/lib/hooks/use-sessions"
import { StatusBadge } from "@/components/status-badge"

const STORAGE_KEY = "oma_sidebar_collapsed"

interface SidebarContextValue {
  collapsed: boolean
}

const SidebarContext = createContext<SidebarContextValue>({ collapsed: false })

export function useSidebarState() {
  return useContext(SidebarContext)
}

// Agents are the primary subject of the console (Agent-centric entry).
const navItems = [
  { label: "Agents", icon: Bot, path: "/agents" },
  { label: "Sessions", icon: MessageSquare, path: "/sessions" },
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
          the in-Agent context (the current Agent + its Sessions). */}
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

/**
 * In-Agent sidebar context: a "back to all Agents" switcher, the current
 * Agent's name, "New Session", and this Agent's Session list. Renders in place
 * of the global nav whenever the route is scoped to an Agent.
 */
function AgentContextNav({ agentId, collapsed }: { agentId: string; collapsed: boolean }) {
  const location = useLocation()
  const { data: agent } = useAgent(agentId)
  const { data: sessions } = useAgentSessions(agentId)

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

      <Link
        to={`/agents/${agentId}`}
        className="flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent-muted)]"
      >
        <Plus className="h-[18px] w-[18px] shrink-0" />
        <span>New Session</span>
      </Link>

      <div className="pt-2">
        <p className="px-2.5 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
          Sessions
        </p>
        {sessions?.length === 0 && (
          <p className="px-2.5 py-1 text-xs text-neutral-400">None yet</p>
        )}
        {sessions?.map((s) => (
          <Link
            key={s.id}
            to={`/sessions/${s.id}`}
            className={cn(
              "flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors",
              location.pathname === `/sessions/${s.id}`
                ? "bg-[var(--color-bg-muted)] text-[var(--color-fg)]"
                : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]",
            )}
          >
            <span className="truncate font-mono">{s.id}</span>
            <StatusBadge status={s.status} />
          </Link>
        ))}
      </div>
    </div>
  )
}
