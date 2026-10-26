import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useDeleteEnvironment, type EnvironmentSummary } from "@/lib/hooks/use-environments";

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
