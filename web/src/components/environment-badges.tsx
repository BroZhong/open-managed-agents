import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EnvironmentBuildSummary, EnvironmentStatus } from "@/lib/hooks/use-environments";
import { BUILD_STATUS, ENVIRONMENT_STATUS } from "@/lib/environment-status";

const badge = "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium";

/** An Environment's build status. A failed rebuild keeps the previous image serving. */
export function EnvironmentStatusBadge({ status }: { status: EnvironmentStatus }) {
  const { label, className } = ENVIRONMENT_STATUS[status];
  return (
    <span className={cn(badge, className)}>
      {status === "building" && <LoaderCircle aria-hidden="true" className="h-3 w-3 animate-spin" />}
      {label}
    </span>
  );
}

/** One build's status. */
export function BuildStatusBadge({ status }: { status: EnvironmentBuildSummary["status"] }) {
  const { label, className } = BUILD_STATUS[status];
  return <span className={cn(badge, className)}>{label}</span>;
}

/** Built-in Environments are labelled by their owner, not a tag system. */
export function BuiltInTag() {
  return <span className="rounded-md bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">Built-in</span>;
}
