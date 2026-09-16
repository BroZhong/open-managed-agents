import { useMemo } from "react";
import { Link } from "react-router";
import { Bot, Activity, ArrowUpRight, Plus } from "lucide-react";
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
      <PageHeader title="Dashboard" description="Your Agents and their activity, in one place.">
        <Link to="/agents" className="section-link">Manage Agents <ArrowUpRight className="h-4 w-4" /></Link>
      </PageHeader>

      <div className="page-body space-y-8">
        <div className="overview-intro">
          <h2>A place for your Agents to work.</h2>
          <p>Continue a Session, review progress, or configure an Agent.</p>
        </div>
        {/* Summary cards */}
        <div className="summary-grid">
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
          <div className="section-heading">
            <h2>Your Agents</h2>
            <Link to="/agents" className="section-link">View all <ArrowUpRight className="h-3.5 w-3.5" /></Link>
          </div>

          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : !agents || agents.length === 0 ? (
            <div className="empty-state">
              <Bot className="mb-3 h-6 w-6 text-neutral-300" />
              <h2>Start with your first Agent</h2>
              <p>Give it instructions and Skills, then start a Session.</p>
              <Link to="/agents" className="section-link mt-5"><Plus className="h-4 w-4" />Set up an Agent</Link>
            </div>
          ) : (
            <div className="agent-list">
              {agents.map((agent) => {
                const stats = perAgent.get(agent.id) ?? { running: 0, total: 0 };
                return (
                  <Link
                    key={agent.id}
                    to={`/agents/${agent.id}`}
                    className="agent-list-row"
                  >
                    <span className="agent-identity">
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
    <div className="summary-card">
      <span className="summary-icon">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="summary-label">
          {label}
        </p>
        {loading ? (
          <Skeleton className="mt-1 h-7 w-12" />
        ) : (
          <p className="summary-value">{value}</p>
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
