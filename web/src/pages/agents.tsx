import { useState } from "react";
import { Link } from "react-router";
import { Plus, Bot, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AgentFormDialog } from "@/components/agent-form-dialog";
import { useAgents, useDeleteAgent, type Agent } from "@/lib/hooks/use-agents";
import { cn } from "@/lib/utils";

const runtimeColors: Record<string, string> = {
  "claude-code": "bg-blue-100 text-blue-700",
  codex: "bg-green-100 text-green-700",
  "pi-agent": "bg-[var(--color-accent-muted)] text-[var(--color-accent)]",
};

export default function AgentsPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [agentToDelete, setAgentToDelete] = useState<Agent | null>(null);
  const { data: agents, isLoading } = useAgents();
  const deleteMutation = useDeleteAgent();

  function handleDelete() {
    if (!agentToDelete || deleteMutation.isPending) return;
    deleteMutation.mutate(agentToDelete.id, {
      onSuccess: () => toast.success("Agent deleted"),
      onError: (err) => toast.error(err.message || "Failed to delete agent"),
    });
  }

  return (
    <div>
      <PageHeader title="Agents">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Create Agent
        </Button>
      </PageHeader>

      <div className="p-6">
        <div>
          {isLoading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : !agents || agents.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--color-border)] py-24 text-neutral-500">
              <Bot className="mb-3 h-6 w-6 text-neutral-300" />
              <p>No agents yet. Create your first agent to get started.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className="relative rounded-xl border border-[var(--color-border)] bg-white transition-colors hover:border-[var(--color-accent)]"
                >
                  <Link
                    to={`/agents/${agent.id}`}
                    aria-label={`Open ${agent.name}`}
                    className="flex h-full flex-col items-start gap-3 rounded-xl p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2"
                  >
                    <div className="flex w-full items-center gap-3 pr-20">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
                        <Bot className="h-5 w-5" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[var(--color-fg)]">
                          {agent.name}
                        </p>
                        <p className="truncate text-xs text-neutral-500">{agent.model}</p>
                      </div>
                    </div>
                    {agent.description && (
                      <p className="line-clamp-2 text-xs text-neutral-500">
                        {agent.description}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <span
                        className={cn(
                          "inline-block rounded-full px-2 py-0.5 text-xs font-medium",
                          runtimeColors[agent.runtime] ?? "bg-neutral-100 text-neutral-700",
                        )}
                      >
                        {agent.runtime}
                      </span>
                      {agent.sandbox?.enabled && (
                        <span className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                          Sandbox
                        </span>
                      )}
                    </div>
                  </Link>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute right-2 top-3 text-[var(--color-danger)]"
                    aria-label={`Delete ${agent.name}`}
                    aria-busy={deleteMutation.isPending && deleteMutation.variables === agent.id}
                    disabled={deleteMutation.isPending}
                    onClick={() => setAgentToDelete(agent)}
                  >
                    {deleteMutation.isPending && deleteMutation.variables === agent.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <AgentFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog
        open={agentToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setAgentToDelete(null);
        }}
        title="Delete Agent"
        description={`Are you sure you want to delete "${agentToDelete?.name ?? ""}"? This action cannot be undone.`}
        onConfirm={handleDelete}
        confirmLabel="Delete"
      />
    </div>
  );
}
