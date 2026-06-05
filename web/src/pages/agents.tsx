import { useState } from "react";
import { useNavigate } from "react-router";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentFormDialog } from "@/components/agent-form-dialog";
import { useAgents } from "@/lib/hooks/use-agents";
import { cn } from "@/lib/utils";

const runtimeColors: Record<string, string> = {
  "claude-code": "bg-blue-100 text-blue-700",
  codex: "bg-green-100 text-green-700",
  "pi-agent": "bg-purple-100 text-purple-700",
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
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : !agents || agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-neutral-500">
            <p>No agents yet. Create your first agent to get started.</p>
          </div>
        ) : (
          <table className="w-full">
            <thead className="border-b text-left text-sm text-neutral-500">
              <tr>
                <th className="pb-3 font-medium">Name</th>
                <th className="pb-3 font-medium">Model</th>
                <th className="pb-3 font-medium">Runtime</th>
                <th className="pb-3 font-medium">Sandbox</th>
                <th className="pb-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {agents.map((agent) => (
                <tr
                  key={agent.id}
                  className="cursor-pointer hover:bg-neutral-50"
                  onClick={() => navigate(`/agents/${agent.id}`)}
                >
                  <td className="py-3 text-sm font-medium text-neutral-900">
                    {agent.name}
                  </td>
                  <td className="py-3 text-sm text-neutral-600">
                    {agent.model}
                  </td>
                  <td className="py-3">
                    <span
                      className={cn(
                        "inline-block rounded-full px-2 py-0.5 text-xs font-medium",
                        runtimeColors[agent.runtime] ??
                          "bg-neutral-100 text-neutral-700"
                      )}
                    >
                      {agent.runtime}
                    </span>
                  </td>
                  <td className="py-3">
                    <span
                      className={cn(
                        "inline-block rounded-full px-2 py-0.5 text-xs font-medium",
                        agent.sandbox?.enabled
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-neutral-100 text-neutral-600"
                      )}
                    >
                      {agent.sandbox?.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </td>
                  <td className="py-3 text-sm text-neutral-500">
                    {new Date(agent.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <AgentFormDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
