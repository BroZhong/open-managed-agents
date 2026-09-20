import { LoaderCircle } from "lucide-react";

export function SessionLoading() {
  return <div role="status" aria-label="Loading Session" className="flex h-full min-h-32 items-center justify-center text-[var(--color-fg-subtle)]">
    <LoaderCircle aria-hidden="true" className="h-5 w-5 animate-spin" />
    <span className="sr-only">Loading Session…</span>
  </div>;
}
