import { useState, useEffect, createContext, useContext } from "react"
import { useLocation, Link } from "react-router"
import { MessageSquare, Bot, Key, PanelLeftClose, PanelLeftOpen, LogOut } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"

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

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === "true"
  })
  const location = useLocation()
  const { logout } = useAuth()

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

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 px-2 py-2">
        {navItems.map((item) => {
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
        })}
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
