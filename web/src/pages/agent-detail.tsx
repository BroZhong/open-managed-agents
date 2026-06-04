import { useState } from "react";
import { useParams, useNavigate } from "react-router";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AgentFormDialog } from "@/components/agent-form-dialog";
import { CreateSessionDialog } from "@/components/create-session-dialog";
import { useAgent, useDeleteAgent } from "@/lib/hooks/use-agents";
import { cn } from "@/lib/utils";

const runtimeColors: Record<string, string> = {
  "claude-code": "bg-blue-100 text-blue-700",
  codex: "bg-green-100 text-green-700",
  "pi-agent": "bg-purple-100 text-purple-700",
};

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: agent, isLoading } = useAgent(id ?? "");
  const deleteMutation = useDeleteAgent();

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [createSessionOpen, setCreateSessionOpen] = useState(false);

  function handleDelete() {
    if (!id) return;
    deleteMutation.mutate(id, {
      onSuccess: () => {
        toast.success("Agent deleted");
        navigate("/agents");
      },
      onError: (err) => {
        toast.error(err.message || "Failed to delete agent");
      },
    });
  }

  if (isLoading) {
    return (
      <div>
        <PageHeader title="">
          <Skeleton className="h-5 w-32" />
        </PageHeader>
        <div className="space-y-4 p-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div>
        <PageHeader title="Agent Not Found" />
        <div className="flex items-center justify-center px-6 py-24 text-neutral-500">
          This agent could not be found.
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={agent.name}>
        <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </PageHeader>

      <div className="p-6">
        <div className="space-y-6">
          {/* Config section */}
          <section>
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Configuration
            </h2>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-sm font-medium text-neutral-500">Name</dt>
                <dd className="mt-1 text-sm text-neutral-900">{agent.name}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-neutral-500">Model</dt>
                <dd className="mt-1 text-sm text-neutral-900">{agent.model}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-neutral-500">
                  Runtime
                </dt>
                <dd className="mt-1">
                  <span
                    className={cn(
                      "inline-block rounded-full px-2 py-0.5 text-xs font-medium",
                      runtimeColors[agent.runtime] ??
                        "bg-neutral-100 text-neutral-700"
                    )}
                  >
                    {agent.runtime}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-neutral-500">
                  Created
                </dt>
                <dd className="mt-1 text-sm text-neutral-900">
                  {new Date(agent.createdAt).toLocaleString()}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-sm font-medium text-neutral-500">
                  System Prompt
                </dt>
                <dd className="mt-1 whitespace-pre-wrap rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-900">
                  {agent.system}
                </dd>
              </div>
            </dl>
          </section>

          {/* Sessions section */}
          <section>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
                Sessions
              </h2>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCreateSessionOpen(true)}
              >
                New Session
              </Button>
            </div>
            <div className="mt-4 flex items-center justify-center rounded-md border border-dashed border-neutral-300 py-12 text-sm text-neutral-500">
              Sessions for this agent will appear here.
            </div>
          </section>
        </div>
      </div>

      <AgentFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        agent={agent}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete Agent"
        description={`Are you sure you want to delete "${agent.name}"? This action cannot be undone.`}
        onConfirm={handleDelete}
        confirmLabel="Delete"
      />

      <CreateSessionDialog
        open={createSessionOpen}
        onOpenChange={setCreateSessionOpen}
        preselectedAgentId={agent.id}
      />
    </div>
  );
}
