import { Link } from "react-router";
import { Bot, Plug } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { isManagedRdsMcpServer, useAgents } from "@/lib/hooks/use-agents";

export default function McpPage() {
  const { data: agents, isLoading } = useAgents();

  return (
    <div>
      <PageHeader title="MCP" />
      <div className="space-y-5 p-6">
        <div className="max-w-2xl">
          <p className="text-sm text-[var(--color-fg-muted)]">
            Managed MCP resources are configured per Agent. Open an Agent to enable
            or remove the Host-reviewed RDS connection.
          </p>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-24 w-full" />
            ))}
          </div>
        ) : !agents || agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--color-border)] py-24 text-neutral-500">
            <Bot className="mb-3 h-6 w-6 text-neutral-300" />
            <p>Create an Agent before configuring MCP servers.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => {
              const count =
                agent.mcpServers?.filter(isManagedRdsMcpServer).length ?? 0;
              const countLabel =
                count === 0
                  ? "No managed MCP servers"
                  : `${count} managed MCP ${count === 1 ? "server" : "servers"}`;

              return (
                <Link
                  key={agent.id}
                  to={`/agents/${agent.id}#mcp`}
                  className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-white p-4 transition-colors hover:border-[var(--color-accent)]"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
                    <Plug className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[var(--color-fg)]">
                      {agent.name}
                    </p>
                    <p className="text-xs text-[var(--color-fg-muted)]">{countLabel}</p>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
