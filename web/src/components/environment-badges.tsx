import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EnvironmentStatus } from "@/lib/hooks/use-environments";

const STATUS: Record<EnvironmentStatus, { label: string; className: string }> = {
  pending: { label: "待构建", className: "bg-amber-50 text-amber-700" },
  building: { label: "构建中", className: "bg-blue-50 text-blue-700" },
  failed: { label: "构建失败", className: "bg-red-50 text-red-700" },
  ready: { label: "就绪", className: "bg-green-50 text-green-700" },
};

/** An Environment's build status. A failed rebuild keeps the previous image serving. */
export function EnvironmentStatusBadge({ status }: { status: EnvironmentStatus }) {
  const { label, className } = STATUS[status];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium", className)}>
      {status === "building" && <LoaderCircle aria-hidden="true" className="h-3 w-3 animate-spin" />}
      {label}
    </span>
  );
}

/** Built-in Environments are labelled by their owner, not a tag system. */
export function BuiltInTag() {
  return <span className="rounded-md bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">平台内置</span>;
}
