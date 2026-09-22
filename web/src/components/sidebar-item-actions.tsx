import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { MoreHorizontal } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog"

export function SidebarItemActions({ kind, label, onRename, onDelete, onNewSession }: {
  kind: "Session" | "Workspace"
  label: string
  onRename: (name: string) => Promise<unknown>
  onDelete: () => Promise<unknown>
  onNewSession?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(label)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function outside(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", outside)
    document.addEventListener("keydown", escape)
    return () => {
      document.removeEventListener("mousedown", outside)
      document.removeEventListener("keydown", escape)
    }
  }, [open])

  async function remove() {
    setOpen(false)
    setBusy(true)
    try { await onDelete() }
    catch (error) { toast.error(error instanceof Error ? error.message : `Failed to delete ${kind.toLowerCase()}`) }
    finally { setBusy(false) }
  }

  return <>
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label={`${kind} actions`}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={busy}
        onClick={() => setOpen(!open)}
        className="mr-1 flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-[var(--color-accent-muted)] hover:text-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-50"
      ><MoreHorizontal className="h-3.5 w-3.5" /></button>
      {open && <div role="menu" aria-label={`${kind} actions`} className="absolute right-0 top-6 z-30 w-36 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-surface)] py-1 shadow-md">
        <button role="menuitem" onClick={() => { setName(label); setOpen(false); setRenaming(true) }} className="flex w-full px-3 py-1.5 text-left text-xs text-[var(--color-fg)] hover:bg-[var(--color-bg-muted)]">Rename</button>
        {onNewSession && <button role="menuitem" onClick={() => { setOpen(false); onNewSession() }} className="flex w-full px-3 py-1.5 text-left text-xs text-[var(--color-fg)] hover:bg-[var(--color-bg-muted)]">New chat here</button>}
        <button role="menuitem" aria-label="Delete" title={`Delete ${kind.toLowerCase()}`} onClick={() => void remove()} className="flex w-full px-3 py-1.5 text-left text-xs text-[var(--color-danger)] hover:bg-[var(--color-bg-muted)]">Delete</button>
      </div>}
    </div>
    {renaming && createPortal(<Dialog open onOpenChange={(value) => { if (!busy) setRenaming(value) }} ariaLabel={`Rename ${kind.toLowerCase()}`}>
      <form onSubmit={async (event) => {
        event.preventDefault()
        if (!name.trim() || busy) return
        setBusy(true)
        try { await onRename(name.trim()); setRenaming(false) }
        catch (error) { toast.error(error instanceof Error ? error.message : "Rename failed") }
        finally { setBusy(false) }
      }}>
        <DialogHeader><h2 className="text-lg font-semibold">Rename {kind.toLowerCase()}</h2></DialogHeader>
        <input autoFocus aria-label={`${kind} name`} value={name} maxLength={500} disabled={busy} onChange={(event) => setName(event.target.value)} className="w-full rounded-md border border-[var(--color-border)] px-3 py-2 text-sm" />
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setRenaming(false)}>Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </form>
    </Dialog>, document.body)}
  </>
}
