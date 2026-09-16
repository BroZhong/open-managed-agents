import { LoaderCircle } from "lucide-react";

interface StatusBadgeProps {
  status: "idle" | "running" | "waiting" | "terminated";
}

/** A waiting Turn is still active while its delegated execution runs. */
export function StatusBadge({ status }: StatusBadgeProps) {
  if (status !== "running" && status !== "waiting") return null;

  return (
    <span role="img" aria-label="Session running" title="Session running" className="inline-flex shrink-0 text-[var(--color-fg-muted)]">
      <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
    </span>
  );
}
