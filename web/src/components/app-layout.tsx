import { useState, useEffect } from "react"
import { Outlet } from "react-router"
import { Sidebar } from "@/components/sidebar"
import { cn } from "@/lib/utils"

const STORAGE_KEY = "oma_sidebar_collapsed"

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === "true"
  })

  useEffect(() => {
    function handleToggle(e: Event) {
      const detail = (e as CustomEvent<{ collapsed: boolean }>).detail
      setCollapsed(detail.collapsed)
    }
    window.addEventListener("sidebar-toggle", handleToggle)
    return () => window.removeEventListener("sidebar-toggle", handleToggle)
  }, [])

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main
        className={cn(
          "flex flex-1 flex-col h-screen overflow-hidden transition-all duration-200",
          collapsed ? "ml-[52px]" : "ml-[224px]"
        )}
      >
        <div className="flex-1 min-h-0 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
