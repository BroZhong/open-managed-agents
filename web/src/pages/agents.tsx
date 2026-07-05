import { useState } from "react";
import { useNavigate } from "react-router";
import { Plus, Bot } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentFormDialog } from "@/components/agent-form-dialog";
import { useAgents } from "@/lib/hooks/use-agents";
import { cn } from "@/lib/utils";

const runtimeColors: Record<string, string> = {
  "claude-code": "bg-blue-100 text-blue-700",
  codex: "bg-green-100 text-green-700",
  "pi-agent": "bg-[var(--color-accent-muted)] text-[var(--color-accent)]",
};

export default function AgentsPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();
  const { data: agents, isLoading } = useAgents();

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
                <button
                  key={agent.id}
                  onClick={() => navigate(`/agents/${agent.id}`)}
                  className="flex flex-col items-start gap-3 rounded-xl border border-[var(--color-border)] bg-white p-4 text-left transition-colors hover:border-[var(--color-accent)]"
                >
                  <div className="flex w-full items-center gap-3">
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
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <AgentFormDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
