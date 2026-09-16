import { Trash2 } from "lucide-react"
import { Dialog, DialogHeader, DialogFooter } from "./dialog"
import { Button } from "./button"

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  onConfirm: () => void
  confirmLabel?: string
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  confirmLabel = "Confirm",
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <h2 className="text-lg font-semibold text-neutral-900">{title}</h2>
        <p className="text-sm text-neutral-600">{description}</p>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          size={confirmLabel === "Delete" || confirmLabel === "Unequip" ? "icon" : "default"}
          aria-label={confirmLabel}
          title={confirmLabel}
          onClick={() => {
            onConfirm()
            onOpenChange(false)
          }}
        >
          {confirmLabel === "Delete" || confirmLabel === "Unequip" ? <Trash2 className="h-4 w-4" /> : confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
