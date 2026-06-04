import { useState } from "react";
import { useNavigate } from "react-router";
import { Plus, MonitorX } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/status-badge";
import { CreateSessionDialog } from "@/components/create-session-dialog";
import { useSessions } from "@/lib/hooks/use-sessions";
import { cn, formatRelativeTime } from "@/lib/utils";

const STATUS_FILTERS = [
  { label: "All", value: undefined },
  { label: "Idle", value: "idle" },
  { label: "Running", value: "running" },
  { label: "Terminated", value: "terminated" },
] as const;

export default function SessionsPage() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<string | undefined>(
    undefined
  );
  const [createOpen, setCreateOpen] = useState(false);

  const { data: sessions, isLoading } = useSessions(statusFilter);

  return (
    <div>
      <PageHeader title="Sessions">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          New Session
        </Button>
      </PageHeader>

      <div className="p-6">
        {/* Filter bar */}
        <div className="mb-4 flex gap-1">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.label}
              onClick={() => setStatusFilter(filter.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                statusFilter === filter.value
                  ? "bg-neutral-900 text-white"
                  : "text-neutral-600 hover:bg-neutral-100"
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {/* Loading state */}
        {isLoading && (
          <div className="overflow-hidden rounded-md border border-neutral-200">
            <table className="w-full">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Session ID
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Agent
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-neutral-100">
                    <td className="px-4 py-3">
                      <Skeleton className="h-4 w-24" />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton className="h-4 w-32" />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton className="h-5 w-16" />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton className="h-4 w-20" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && sessions && sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-neutral-300 py-16">
            <MonitorX className="h-10 w-10 text-neutral-400" />
            <p className="mt-4 text-sm text-neutral-500">
              No sessions yet. Create one to get started.
            </p>
            <Button
              size="sm"
              className="mt-4"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              New Session
            </Button>
          </div>
        )}

        {/* Sessions table */}
        {!isLoading && sessions && sessions.length > 0 && (
          <div className="overflow-hidden rounded-md border border-neutral-200">
            <table className="w-full">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Session ID
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Agent
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr
                    key={session.id}
                    onClick={() => navigate(`/sessions/${session.id}`)}
                    className="cursor-pointer border-b border-neutral-100 transition-colors hover:bg-neutral-50 last:border-b-0"
                  >
                    <td className="px-4 py-3 font-mono text-sm text-neutral-700">
                      {session.id.slice(0, 8)}...
                    </td>
                    <td className="px-4 py-3 text-sm text-neutral-900">
                      {session.agent.name}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={session.status} />
                    </td>
                    <td className="px-4 py-3 text-sm text-neutral-500">
                      {formatRelativeTime(session.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
