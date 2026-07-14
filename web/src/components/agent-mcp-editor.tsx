import { useState } from "react";
import { Plug, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  useUpdateAgent,
  type Agent,
  type ManagedMcpServerRef,
} from "@/lib/hooks/use-agents";
import { useMcpCatalog, type McpCatalogEntry } from "@/lib/hooks/use-mcp-catalog";

function initialRefs(agent: Agent): Record<string, ManagedMcpServerRef> {
  const refs: Record<string, ManagedMcpServerRef> = {};
  for (const config of agent.mcpServers ?? []) {
    refs[config.catalogId] = { ...config };
  }
  return refs;
}

function ConnectionEditor({
  entry,
  value,
  onChange,
  onRemove,
}: {
  entry: McpCatalogEntry;
  value: ManagedMcpServerRef;
  onChange: (value: ManagedMcpServerRef) => void;
  onRemove: () => void;
}) {
  return (
    <article className="space-y-4 rounded-xl border border-[var(--color-border)] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
            <Plug className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-semibold text-[var(--color-fg)]">{entry.defaultName}</p>
            <p className="text-xs text-emerald-700">Managed {entry.transport}</p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Remove ${entry.defaultName}`}
          onClick={onRemove}
          className="text-[var(--color-danger)]"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs font-medium text-[var(--color-fg-muted)]">
          Name
          <input
            aria-label={`${entry.defaultName} MCP name`}
            value={value.name}
            onChange={(event) => onChange({ ...value, name: event.target.value })}
            className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <label className="space-y-1 text-xs font-medium text-[var(--color-fg-muted)]">
          Description
          <input
            aria-label={`${entry.defaultName} MCP description`}
            value={value.description ?? ""}
            onChange={(event) => onChange({ ...value, description: event.target.value })}
            className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
          />
        </label>
      </div>
      <p className="text-xs text-[var(--color-fg-subtle)]">
        Required Host environment: {entry.requiredEnv.join(", ")}
      </p>
    </article>
  );
}

export function AgentMcpEditor({ agent }: { agent: Agent }) {
  const { data: catalog, isLoading, isError } = useMcpCatalog();
  const [refs, setRefs] = useState<Record<string, ManagedMcpServerRef>>(
    () => initialRefs(agent),
  );
  const availableCatalogIds = new Set((catalog ?? []).map((entry) => entry.id));
  const missingManagedRefs = Object.keys(refs).filter(
    (catalogId) => !availableCatalogIds.has(catalogId),
  );
  const catalogComplete = !isLoading && !isError && missingManagedRefs.length === 0;
  const updateAgent = useUpdateAgent();

  function save() {
    if (!catalogComplete) return;
    const mcpServers = (catalog ?? [])
      .map((entry) => refs[entry.id])
      .filter((ref): ref is ManagedMcpServerRef => Boolean(ref));
    updateAgent.mutate(
      { id: agent.id, mcpServers },
      {
        onSuccess: () => toast.success("Managed MCP Connections saved"),
        onError: (error) =>
          toast.error(error.message || "Failed to save Managed MCP Connections"),
      },
    );
  }

  return (
    <div id="mcp" className="space-y-4 scroll-mt-20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">Managed MCP</h2>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            Choose Host-reviewed connections. You can configure their Agent-facing name and description; commands and secrets remain Host-owned.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={save}
          disabled={updateAgent.isPending || !catalogComplete}
        >
          {updateAgent.isPending ? "Saving…" : "Save MCP"}
        </Button>
      </div>

      {isError && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          The managed MCP catalog is unavailable. Existing configuration is preserved and saving is disabled.
        </p>
      )}

      {!isError && !isLoading && missingManagedRefs.length > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          An existing Managed MCP Connection is unavailable for this Tenant. Saving is disabled so it cannot be removed accidentally.
        </p>
      )}

      <div className="space-y-3">
        {(catalog ?? []).map((entry) => {
          const value = refs[entry.id];
          if (value) {
            return (
              <ConnectionEditor
                key={entry.id}
                entry={entry}
                value={value}
                onChange={(next) => setRefs((current) => ({ ...current, [entry.id]: next }))}
                onRemove={() => setRefs((current) => {
                  const next = { ...current };
                  delete next[entry.id];
                  return next;
                })}
              />
            );
          }
          return (
            <article key={entry.id} className="flex items-center justify-between gap-4 rounded-xl border border-dashed border-[var(--color-border)] p-4">
              <div>
                <p className="text-sm font-medium text-[var(--color-fg)]">{entry.defaultName}</p>
                <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{entry.defaultDescription}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRefs((current) => ({
                  ...current,
                  [entry.id]: {
                    catalogId: entry.id,
                    name: entry.defaultName,
                    description: entry.defaultDescription,
                  },
                }))}
              >
                Enable {entry.defaultName}
              </Button>
            </article>
          );
        })}
      </div>
    </div>
  );
}
