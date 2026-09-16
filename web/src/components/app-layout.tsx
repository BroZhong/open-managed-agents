import { useState, useEffect } from "react"
import { Outlet } from "react-router"
import { Sidebar } from "@/components/sidebar"

const STORAGE_KEY = "oma_sidebar_collapsed"

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === "true" || (localStorage.getItem(STORAGE_KEY) === null && window.innerWidth < 768)
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
    <div className="app-shell" data-collapsed={collapsed}>
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Sidebar />
      <main id="main-content" tabIndex={-1} className="app-main">
        <div className="app-content">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
