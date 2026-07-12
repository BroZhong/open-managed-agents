import { useState } from "react";
import { Plug, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  MANAGED_RDS_MCP_SERVER,
  isManagedRdsMcpServer,
  useUpdateAgent,
  type Agent,
  type McpServerConfig,
} from "@/lib/hooks/use-agents";

function managedRdsConfig(): McpServerConfig {
  return {
    ...MANAGED_RDS_MCP_SERVER,
    headers: { ...MANAGED_RDS_MCP_SERVER.headers },
  };
}

export function AgentMcpEditor({ agent }: { agent: Agent }) {
  const initialServers = agent.mcpServers ?? [];
  const [enabled, setEnabled] = useState(() =>
    initialServers.some(isManagedRdsMcpServer),
  );
  const hasUnmanagedConfiguration = initialServers.some(
    (server) => !isManagedRdsMcpServer(server),
  );
  const updateAgent = useUpdateAgent();

  function save() {
    updateAgent.mutate(
      {
        id: agent.id,
        mcpServers: enabled ? [managedRdsConfig()] : [],
      },
      {
        onSuccess: () => toast.success("Managed MCP configuration saved"),
        onError: (error) =>
          toast.error(error.message || "Failed to save managed MCP configuration"),
      },
    );
  }

  return (
    <div id="mcp" className="space-y-4 scroll-mt-20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">Managed MCP</h2>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            This Agent can use the Host-reviewed RDS MCP resource. Connection settings are
            fixed and secrets stay in the runtime environment.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={save}
          disabled={updateAgent.isPending}
        >
          {updateAgent.isPending ? "Saving…" : "Save MCP"}
        </Button>
      </div>

      {hasUnmanagedConfiguration && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Unsupported MCP entries are hidden and will be removed when this managed
          configuration is saved.
        </p>
      )}

      {!enabled ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--color-border)] px-4 py-10 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
            <Plug className="h-5 w-5" />
          </span>
          <div>
            <p className="text-sm font-medium text-[var(--color-fg)]">
              Managed RDS MCP is not enabled for this Agent.
            </p>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
              Enable the approved read-only RDS connection, then save the Agent.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setEnabled(true)}
          >
            Enable managed RDS MCP
          </Button>
        </div>
      ) : (
        <div className="space-y-4 rounded-xl border border-[var(--color-border)] bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
                <Plug className="h-4 w-4" />
              </span>
              <div>
                <p className="text-sm font-semibold text-[var(--color-fg)]">rds-mcp</p>
                <p className="text-xs text-emerald-700">Managed resource</p>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Remove managed RDS MCP"
              onClick={() => setEnabled(false)}
              className="text-[var(--color-danger)]"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove
            </Button>
          </div>

          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
                URL
              </dt>
              <dd className="mt-1 break-all font-mono text-xs text-[var(--color-fg)]">
                {MANAGED_RDS_MCP_SERVER.url}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
                Transport
              </dt>
              <dd className="mt-1 text-[var(--color-fg)]">Streamable HTTP</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
                Authorization
              </dt>
              <dd className="mt-1 font-mono text-xs text-[var(--color-fg)]">
                {MANAGED_RDS_MCP_SERVER.headers?.Authorization}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
