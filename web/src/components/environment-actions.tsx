import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogHeader, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useDeleteEnvironment, type EnvironmentSummary } from "@/lib/hooks/use-environments";

export function CopyEnvironmentDialog({ environment, onClose, onConfirm }: {
  environment: Pick<EnvironmentSummary, "id" | "name"> | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={environment !== null} ariaLabel="Fork Environment" onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogHeader>
        <h2 className="text-lg font-semibold">Fork Environment</h2>
        <p className="text-sm text-neutral-600">Fork {environment?.name} into a new custom Environment? This creates an independent copy that you can edit.</p>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={() => { onConfirm(); onClose(); }}>Fork Environment</Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Confirm, then soft-delete an Environment; an API refusal (an Agent uses it) shows as a toast. */
export function DeleteEnvironmentDialog({ environment, onClose, onDeleted }: {
  environment: Pick<EnvironmentSummary, "id" | "name"> | null;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const remove = useDeleteEnvironment();
  return (
    <ConfirmDialog
      open={environment !== null}
      onOpenChange={(open) => { if (!open) onClose(); }}
      title="Delete Environment"
      description={`Delete ${environment?.name ?? ""}? Sandboxes already running its image are not affected.`}
      confirmLabel="Delete"
      onConfirm={() => {
        if (environment) remove.mutate(environment.id, { onSuccess: () => onDeleted?.(), onError: (error) => toast.error(error.message) });
      }}
    />
  );
}
