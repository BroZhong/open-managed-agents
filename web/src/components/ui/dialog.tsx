import { cn } from "@/lib/utils"
import { useEffect, useCallback, type ReactNode } from "react"

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  ariaLabel?: string
  children: ReactNode
}

export function Dialog({ open, onOpenChange, ariaLabel, children }: DialogProps) {
  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false)
    },
    [onOpenChange]
  )

  useEffect(() => {
    if (open) {
      document.addEventListener("keydown", handleEscape)
      return () => document.removeEventListener("keydown", handleEscape)
    }
  }, [open, handleEscape])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/50"
        aria-hidden="true"
        onClick={() => onOpenChange(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className="relative z-50 mx-4 w-full max-w-md rounded-lg bg-white p-6 shadow-lg"
      >
        {children}
      </div>
    </div>
  )
}

export function DialogHeader({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("mb-4 space-y-1.5", className)}>{children}</div>
  )
}

export function DialogFooter({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("mt-6 flex justify-end gap-2", className)}>
      {children}
    </div>
  )
}
