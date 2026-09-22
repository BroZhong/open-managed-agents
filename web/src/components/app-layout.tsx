import { useState, useEffect, useRef, type CSSProperties } from "react"
import { Outlet } from "react-router"
import { Sidebar } from "@/components/sidebar"

const STORAGE_KEY = "oma_sidebar_collapsed"
const WIDTH_KEY = "oma_sidebar_width"
const DEFAULT_WIDTH = 224
const MIN_WIDTH = 200
const MAX_WIDTH = 480
const clampWidth = (width: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width))

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === "true" || (localStorage.getItem(STORAGE_KEY) === null && window.innerWidth < 768)
  })
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(WIDTH_KEY)
    const value = saved === null ? DEFAULT_WIDTH : Number(saved)
    return Number.isFinite(value) ? clampWidth(value) : DEFAULT_WIDTH
  })
  const [resizing, setResizing] = useState(false)
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width))
  }, [width])

  useEffect(() => {
    function handleToggle(e: Event) {
      const detail = (e as CustomEvent<{ collapsed: boolean }>).detail
      setCollapsed(detail.collapsed)
      drag.current = null
      setResizing(false)
    }
    window.addEventListener("sidebar-toggle", handleToggle)
    return () => window.removeEventListener("sidebar-toggle", handleToggle)
  }, [])

  return (
    <div
      className="app-shell"
      data-collapsed={collapsed}
      data-resizing={resizing}
      style={{ "--sidebar-expanded-width": `${width}px` } as CSSProperties}
    >
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Sidebar />
      {!collapsed && <div
        role="separator"
        tabIndex={0}
        aria-label="Resize sidebar"
        aria-controls="console-sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={width}
        aria-valuetext={`${width} pixels`}
        className="sidebar-resizer"
        title="Drag to resize sidebar; double-click to reset"
        onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          const next = event.key === "ArrowLeft" ? width - 16
            : event.key === "ArrowRight" ? width + 16
            : event.key === "Home" ? MIN_WIDTH
            : event.key === "End" ? MAX_WIDTH : null
          if (next !== null) {
            event.preventDefault()
            setWidth(clampWidth(next))
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width }
          setResizing(true)
        }}
        onPointerMove={(event) => {
          const current = drag.current
          if (!current || current.pointerId !== event.pointerId) return
          setWidth(clampWidth(Math.round(current.startWidth + event.clientX - current.startX)))
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          drag.current = null
          setResizing(false)
        }}
        onPointerCancel={() => { drag.current = null; setResizing(false) }}
        onLostPointerCapture={() => { drag.current = null; setResizing(false) }}
      />}
      <main id="main-content" tabIndex={-1} className="app-main">
        <div className="app-content">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
