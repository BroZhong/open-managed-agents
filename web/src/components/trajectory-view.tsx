import { useId, useMemo, useRef, useState } from "react";
import { TimelineView } from "@/components/timeline-view";
import type { EventDataLoader } from "@/components/event-data";
import { summarizeTrajectory, type ToolCallCount } from "@/lib/trajectory-summary";
import type { SessionEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ChartColor {
  color: string;
  textColor: string;
}

// Use distinct theme colors before their lighter shades. Sorting by tool identity
// keeps assignments stable when counts change or the chart reorders.
const TOOL_COLORS: ChartColor[] = [
  { color: "var(--color-accent)", textColor: "var(--color-accent-fg)" },
  { color: "var(--color-brand)", textColor: "var(--color-primary-fg)" },
  { color: "var(--color-warning)", textColor: "var(--color-fg)" },
  { color: "var(--color-fg)", textColor: "var(--color-primary-fg)" },
  { color: "color-mix(in srgb, var(--color-accent) 45%, var(--color-bg-surface))", textColor: "var(--color-fg)" },
  { color: "var(--color-fg-muted)", textColor: "var(--color-primary-fg)" },
  { color: "color-mix(in srgb, var(--color-brand) 35%, var(--color-bg-surface))", textColor: "var(--color-fg)" },
  { color: "color-mix(in srgb, var(--color-warning) 35%, var(--color-bg-surface))", textColor: "var(--color-fg)" },
];

function toolColors(tools: ToolCallCount[]): Map<string, ChartColor> {
  return new Map([...tools].sort((a, b) => a.id.localeCompare(b.id)).map((tool, index) => [
    tool.id, TOOL_COLORS[index % TOOL_COLORS.length],
  ]));
}

function percentage(count: number, total: number): string {
  const value = total ? count / total * 100 : 0;
  return value > 0 && value < 0.1 ? "<0.1%" : `${Number(value.toFixed(1))}%`;
}

interface Segment extends ChartColor {
  id: string;
  name: string;
  count: number;
}

function Distribution({ title, description, segments, total }: {
  title: string;
  description: string;
  segments: Segment[];
  total: number;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const listId = useId();
  const hasSelection = segments.some((segment) => segment.count > 0 && segment.id === selectedId);
  const itemId = (id: string) => `${listId}-${encodeURIComponent(id)}`;

  function toggleSelection(id: string) {
    const next = selectedId === id ? undefined : id;
    setSelectedId(next);
    if (next) itemRefs.current.get(next)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  return (
    <section aria-label={title} className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-medium text-[var(--color-fg)]">{title}</h3>
        <p className="text-xs text-[var(--color-fg-subtle)]">{description}</p>
      </div>
      <div
        role="group"
        aria-label={`${title}: ${segments.filter((segment) => segment.count > 0).map((segment) => `${segment.name} ${percentage(segment.count, total)}`).join(", ")}`}
        className="flex h-11 overflow-hidden rounded-sm bg-[var(--color-bg-muted)]"
      >
        {segments.filter((segment) => segment.count > 0).map((segment) => (
          <button
            key={segment.id}
            type="button"
            aria-label={`${segment.name}: ${segment.count.toLocaleString()} (${percentage(segment.count, total)})`}
            aria-pressed={selectedId === segment.id}
            aria-controls={itemId(segment.id)}
            onClick={() => toggleSelection(segment.id)}
            title={`${segment.name}: ${segment.count.toLocaleString()} (${percentage(segment.count, total)})`}
            style={{ width: `${segment.count / total * 100}%`, backgroundColor: segment.color, color: segment.textColor }}
            className={cn("@container flex min-w-0 items-center justify-center overflow-hidden border-l-2 border-[var(--color-bg-surface)] text-xs font-medium tabular-nums first:border-l-0 hover:brightness-110 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-fg)]",
              hasSelection && selectedId !== segment.id && "opacity-40")}
          >
            <span className="hidden px-1 @min-[48px]:inline">{percentage(segment.count, total)}</span>
          </button>
        ))}
      </div>
      <dl className="-mx-2 grid gap-x-4 gap-y-1 @min-[640px]:grid-cols-2">
        {segments.map((segment) => (
          <div key={segment.id} id={itemId(segment.id)}
            ref={(node) => { if (node) itemRefs.current.set(segment.id, node); else itemRefs.current.delete(segment.id); }}
            className={cn("flex min-w-0 scroll-my-3 items-baseline justify-between gap-3 rounded px-2 py-1.5 text-xs",
              selectedId === segment.id && "bg-[var(--color-accent-muted)] ring-1 ring-inset ring-[var(--color-accent)]")}>
            <dt className="min-w-0">
              <button type="button" aria-pressed={selectedId === segment.id} aria-label={`Highlight ${segment.name}`}
                disabled={segment.count === 0}
                onClick={() => toggleSelection(segment.id)}
                className={cn("flex min-w-0 items-baseline gap-2 rounded text-left hover:text-[var(--color-fg)]",
                  selectedId === segment.id ? "font-medium text-[var(--color-fg)]" : "text-[var(--color-fg-muted)]")}>
                <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-[2px]" style={{ backgroundColor: segment.color }} />
                <span className="break-words [overflow-wrap:anywhere]">{segment.name}</span>
              </button>
            </dt>
            <dd className="flex shrink-0 gap-3 font-mono tabular-nums">
              <span>{segment.count.toLocaleString()}</span>
              <span className="w-14 text-right text-[var(--color-fg-subtle)]">{percentage(segment.count, total)}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function BehaviorSummary({ events }: { events: SessionEvent[] }) {
  const summary = useMemo(() => summarizeTrajectory(events), [events]);
  const colors = useMemo(() => toolColors(summary.tools), [summary.tools]);

  return (
    <div className="@container h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-8 p-5 @min-[640px]:p-8">
        <header className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold">Behavior overview</h2>
            <span className="font-mono text-xs tabular-nums text-[var(--color-fg-muted)]">{summary.totalActions.toLocaleString()} recorded actions</span>
          </div>
          <p className="text-xs leading-5 text-[var(--color-fg-subtle)]">Current Session · Counts and proportions across all Turns.</p>
        </header>

        {summary.totalActions === 0 ? (
          <p className="py-12 text-center text-sm text-[var(--color-fg-subtle)]">No recorded agent actions yet.</p>
        ) : (
          <>
            <Distribution title="Behavior mix" description="Count · % of all actions" total={summary.totalActions} segments={[
              { id: "tools", name: "Tool calls", count: summary.toolCalls, color: "var(--color-accent)", textColor: "var(--color-accent-fg)" },
              { id: "thinking", name: "Thinking", count: summary.thinking, color: "var(--color-fg-muted)", textColor: "var(--color-primary-fg)" },
              { id: "output", name: "Output", count: summary.output, color: "var(--color-brand)", textColor: "var(--color-primary-fg)" },
            ]} />
            <div className="border-t border-[var(--color-border)] pt-6">
              {summary.toolCalls > 0 ? (
                <Distribution title="Tool usage" description="Count · % of tool calls" total={summary.toolCalls}
                  segments={summary.tools.map((tool) => ({ ...tool, ...colors.get(tool.id)! }))} />
              ) : <p className="text-sm text-[var(--color-fg-subtle)]">No tool calls recorded.</p>}
            </div>
          </>
        )}
        <p className="border-t border-[var(--color-border)] pt-4 text-xs leading-5 text-[var(--color-fg-subtle)]">
          Each saved thinking or text output block counts once; each tool call counts once, regardless of its result.
          Streaming fragments, tool results and system events are excluded. Proportions reflect counts, not duration or tokens.
        </p>
      </div>
    </div>
  );
}

export function TrajectoryView({ events, sessionId, loadEventData }: {
  events: SessionEvent[];
  sessionId: string;
  loadEventData?: EventDataLoader;
}) {
  const [view, setView] = useState<"summary" | "events">("summary");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div aria-label="Trajectory views" className="flex shrink-0 gap-1 border-b border-[var(--color-border)] px-4 py-2">
        {([ ["summary", "Behavior"], ["events", "Event log"] ] as const).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)}
            className={cn("rounded px-3 py-1.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]",
              view === value ? "bg-[var(--color-bg-active)] text-[var(--color-fg)]" : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]")}>
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {view === "summary" ? <BehaviorSummary events={events} /> : <TimelineView events={events} sessionId={sessionId} loadEventData={loadEventData} />}
      </div>
    </div>
  );
}
