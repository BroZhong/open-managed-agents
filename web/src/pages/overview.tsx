import { useMemo } from "react";
import { Link } from "react-router";
import { Bot, Activity } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgents } from "@/lib/hooks/use-agents";
import { useSessions } from "@/lib/hooks/use-sessions";

/** First non-empty line of the system prompt, used as a one-line preview. */
function systemPreview(system: string): string {
  const line = system
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? "No system prompt";
}

export default function OverviewPage() {
  const { data: agents, isLoading: agentsLoading } = useAgents();
  // One tenant-scoped list of ALL sessions; grouped by agentId client-side.
  const { data: sessions, isLoading: sessionsLoading } = useSessions();

  const isLoading = agentsLoading || sessionsLoading;

  const { totalAgents, totalRunning, perAgent } = useMemo(() => {
    const perAgent = new Map<string, { running: number; total: number }>();
    for (const s of sessions ?? []) {
      const entry = perAgent.get(s.agentId) ?? { running: 0, total: 0 };
      entry.total += 1;
      if (s.status === "running") entry.running += 1;
      perAgent.set(s.agentId, entry);
    }
    let totalRunning = 0;
    for (const s of sessions ?? []) {
      if (s.status === "running") totalRunning += 1;
    }
    return {
      totalAgents: agents?.length ?? 0,
      totalRunning,
      perAgent,
    };
  }, [agents, sessions]);

  return (
    <div>
      <PageHeader title="Dashboard" />

      <div className="space-y-8 p-6">
        {/* Summary cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SummaryCard
            icon={<Bot className="h-5 w-5" />}
            label="Agents"
            value={totalAgents}
            loading={isLoading}
          />
          <SummaryCard
            icon={<Activity className="h-5 w-5" />}
            label="Running Sessions"
            value={totalRunning}
            loading={isLoading}
          />
        </div>

        {/* Agent list */}
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Agents
          </h2>

          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : !agents || agents.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--color-border)] py-24 text-neutral-500">
              <Bot className="mb-3 h-6 w-6 text-neutral-300" />
              <p>No agents yet. Create your first agent to get started.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {agents.map((agent) => {
                const stats = perAgent.get(agent.id) ?? { running: 0, total: 0 };
                return (
                  <Link
                    key={agent.id}
                    to={`/agents/${agent.id}`}
                    className="flex items-center gap-4 rounded-xl border border-[var(--color-border)] bg-white p-4 transition-colors hover:border-[var(--color-accent)]"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
                      <Bot className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[var(--color-fg)]">
                        {agent.name}
                      </p>
                      <p className="truncate text-xs text-neutral-500">
                        {systemPreview(agent.system)}
                      </p>
                    </div>
                    <SessionBadge running={stats.running} total={stats.total} />
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  loading: boolean;
}) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-[var(--color-border)] bg-white p-5">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          {label}
        </p>
        {loading ? (
          <Skeleton className="mt-1 h-7 w-12" />
        ) : (
          <p className="text-2xl font-semibold text-[var(--color-fg)]">{value}</p>
        )}
      </div>
    </div>
  );
}

function SessionBadge({ running, total }: { running: number; total: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--color-bg-muted)] px-3 py-1 text-xs font-medium text-[var(--color-fg-muted)]">
      {running > 0 && (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
        </span>
      )}
      <span className={running > 0 ? "text-[var(--color-fg)]" : undefined}>
        {running} running
      </span>
      <span className="text-neutral-400">/ {total} total</span>
    </span>
  );
}
