import { Database, Plug } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { MANAGED_RDS_MCP_SERVER } from "@/lib/hooks/use-agents";

export default function McpPage() {
  return (
    <div>
      <PageHeader title="MCP" />
      <div className="space-y-5 p-6">
        <div className="max-w-2xl space-y-1">
          <p className="text-sm text-[var(--color-fg-muted)]">
            Browse Host-reviewed MCP integrations available to your Agents.
          </p>
          <p className="text-xs text-[var(--color-fg-subtle)]">
            To use an integration, connect it from an Agent&apos;s detail page.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <article className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-sm">
            <div className="flex items-start gap-4 p-5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
                <Database className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold text-[var(--color-fg)]">
                    {MANAGED_RDS_MCP_SERVER.name}
                  </h2>
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                    Available
                  </span>
                </div>
                <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
                  Query and inspect authorized RDS resources through the managed MCP gateway.
                </p>
              </div>
            </div>
            <dl className="grid gap-3 border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-muted)] px-5 py-4 text-xs sm:grid-cols-[8rem_1fr]">
              <dt className="flex items-center gap-1.5 font-medium text-[var(--color-fg-subtle)]">
                <Plug className="h-3.5 w-3.5" />
                Transport
              </dt>
              <dd className="font-mono text-[var(--color-fg-muted)]">
                {MANAGED_RDS_MCP_SERVER.transport}
              </dd>
              <dt className="font-medium text-[var(--color-fg-subtle)]">Endpoint</dt>
              <dd className="break-all font-mono text-[var(--color-fg-muted)]">
                {MANAGED_RDS_MCP_SERVER.url}
              </dd>
            </dl>
          </article>
        </div>
      </div>
    </div>
  );
}
