import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AGENT_FILE_NAMES,
  type AgentFileName,
  useAgentFile,
  useSaveAgentFile,
} from "@/lib/hooks/use-agent-files";

/**
 * Per-Agent multi-tab markdown editor for the Agent's Files (IDENTITY, SOUL,
 * USER, MEMORY). One tab per file; Save persists the active tab. The persona
 * takes effect on the Agent's next Turn (the session-router assembles the
 * Files into the runtime's system prompt). MEMORY is manual-edit only (same
 * editing surface — it is simply never auto-written).
 */
export function AgentFilesEditor({ agentId }: { agentId: string }) {
  const [active, setActive] = useState<AgentFileName>("IDENTITY");

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-[var(--color-border)]">
        {AGENT_FILE_NAMES.map((name) => (
          <button
            key={name}
            onClick={() => setActive(name)}
            className={cn(
              "px-3 py-2 text-sm font-medium transition-colors -mb-px border-b-2",
              active === name
                ? "border-[var(--color-fg)] text-[var(--color-fg)]"
                : "border-transparent text-neutral-500 hover:text-[var(--color-fg)]",
            )}
          >
            {name.charAt(0) + name.slice(1).toLowerCase()}
          </button>
        ))}
      </div>
      <FileTab key={active} agentId={agentId} filename={active} />
    </div>
  );
}

function FileTab({ agentId, filename }: { agentId: string; filename: AgentFileName }) {
  const { data, isLoading } = useAgentFile(agentId, filename);
  const save = useSaveAgentFile(agentId);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);

  // Reset the editor whenever the loaded file changes (tab switch / refetch).
  useEffect(() => {
    if (data && !dirty) setContent(data.content);
  }, [data, dirty]);

  const placeholder =
    filename === "MEMORY"
      ? "Long-term memory for this Agent (manual edits)…"
      : `Markdown for the Agent's ${filename.toLowerCase()}…`;

  return (
    <div className="space-y-3">
      <textarea
        value={content}
        disabled={isLoading}
        placeholder={placeholder}
        onChange={(e) => {
          setContent(e.target.value);
          setDirty(true);
        }}
        className="flex min-h-[240px] w-full rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 font-mono text-sm leading-relaxed transition-colors placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-[var(--color-border)]"
      />
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={!dirty || save.isPending}
          onClick={() =>
            save.mutate(
              { filename, content },
              { onSuccess: () => setDirty(false) },
            )
          }
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {save.isError && (
          <span className="text-xs text-[var(--color-danger)]">
            {(save.error as Error).message}
          </span>
        )}
        {!dirty && data?.updatedAt && (
          <span className="text-xs text-neutral-400">Saved</span>
        )}
      </div>
    </div>
  );
}
