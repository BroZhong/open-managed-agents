import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: "idle" | "running" | "terminated";
}

const statusStyles: Record<StatusBadgeProps["status"], string> = {
  idle: "bg-neutral-100 text-neutral-600",
  running: "bg-green-100 text-green-700",
  terminated: "bg-red-100 text-red-700",
};

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        statusStyles[status]
      )}
    >
      {status === "running" && (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
        </span>
      )}
      {status}
    </span>
  );
}
