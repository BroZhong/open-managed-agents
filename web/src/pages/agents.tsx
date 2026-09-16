import { useState } from "react";
import { Link } from "react-router";
import { Plus, Bot, Trash2, Loader2, GitFork } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ForkAgentDialog } from "@/components/fork-agent-dialog";
import { AgentFormDialog } from "@/components/agent-form-dialog";
import { useAgents, useDeleteAgent, type Agent } from "@/lib/hooks/use-agents";

export default function AgentsPage() {
  const [forking, setForking] = useState<Agent | null>(null);
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
      <PageHeader title="Agents" description="Configure your Agents and continue their work.">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Create Agent
        </Button>
      </PageHeader>

      <div className="page-body">
        <div>
          {isLoading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : !agents || agents.length === 0 ? (
            <div className="empty-state">
              <Bot className="mb-3 h-6 w-6 text-neutral-300" />
              <h2>No Agents yet</h2>
              <p>Create an Agent to start your first Session.</p>
              <Button className="mt-5" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />Create Agent</Button>
            </div>
          ) : (
            <div className="agent-directory">
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className="agent-card"
                >
                  <Link
                    to={`/agents/${agent.id}`}
                    aria-label={`Open ${agent.name}`}
                    className="flex h-full flex-col items-start gap-4 rounded-xl p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2"
                  >
                    <div className="flex w-full items-center gap-3 pr-20">
                      <span className="agent-identity">
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
                    <div className="mt-auto flex flex-wrap gap-2 pt-2">
                      <span
                        className="inline-block rounded-full bg-[var(--color-bg-muted)] px-2 py-0.5 text-xs font-medium text-[var(--color-fg-muted)]"
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
                  <div className="absolute right-2 top-4 flex items-center">
                    <Button variant="ghost" size="icon" title="Fork Agent" aria-label={`Fork ${agent.name}`} onClick={() => setForking(agent)}><GitFork className="h-3.5 w-3.5" /></Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title={`Delete ${agent.name}`}
                      className="agent-delete text-[var(--color-fg-muted)] hover:text-[var(--color-danger)]"
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
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {forking && <ForkAgentDialog agent={forking} onClose={() => setForking(null)} />}
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
