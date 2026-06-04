import { Wrench, ChevronRight, Circle, CheckCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible } from "@/components/ui/collapsible";

interface ToolResult {
  content: unknown;
  isError: boolean;
}

interface ToolCardProps {
  name: string;
  toolUseId: string;
  input: unknown;
  serverName?: string;
  result?: ToolResult;
  streaming?: boolean;
}

function StatusIndicator({ result }: { result?: ToolResult }) {
  if (!result) {
    return <Circle className="h-3 w-3 text-amber-500" />;
  }
  if (result.isError) {
    return <XCircle className="h-3 w-3 text-red-500" />;
  }
  return <CheckCircle className="h-3 w-3 text-green-600" />;
}

function formatContent(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

export function ToolCard({
  name,
  input,
  serverName,
  result,
  streaming = false,
}: ToolCardProps) {
  const trigger = (
    <div
      className={cn(
        "flex items-center gap-2 rounded-xl border px-3 py-2 text-xs transition-colors hover:bg-[var(--color-bg-muted)]",
        result?.isError
          ? "border-red-200 text-[var(--color-fg-muted)]"
          : "border-[var(--color-border)] text-[var(--color-fg-muted)]",
      )}
    >
      <Wrench className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-fg-subtle)]" />
      <span className="flex-1 font-medium font-mono text-[var(--color-fg)]">
        {name}
        {serverName && (
          <span className="ml-1 font-normal text-[var(--color-fg-subtle)]">
            ({serverName})
          </span>
        )}
      </span>
      <StatusIndicator result={result} />
      <ChevronRight className="h-3 w-3 text-[var(--color-fg-subtle)] transition-transform duration-200" />
    </div>
  );

  const inputStr =
    typeof input === "string"
      ? input
      : JSON.stringify(input, null, 2) ?? "{}";

  return (
    <Collapsible trigger={trigger} defaultOpen={streaming}>
      <div className="mt-1 space-y-2 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-muted)] px-3 py-2">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
            Input
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--color-bg-surface)] p-2 text-[11px] text-[var(--color-fg-muted)] border border-[var(--color-border-subtle)]">
            {inputStr}
            {streaming && (
              <span className="inline-block h-3 w-0.5 animate-pulse bg-[var(--color-fg-subtle)] align-middle" />
            )}
          </pre>
        </div>

        {result && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
              Result
            </div>
            <pre
              className={cn(
                "overflow-x-auto whitespace-pre-wrap break-all rounded-lg p-2 text-[11px] border",
                result.isError
                  ? "border-red-200 bg-red-50 text-red-700"
                  : "border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] text-[var(--color-fg-muted)]",
              )}
            >
              {formatContent(result.content)}
            </pre>
          </div>
        )}
      </div>
    </Collapsible>
  );
}
