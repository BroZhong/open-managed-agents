import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Presentational text-file editor: a monospace textarea plus a Save button,
 * dirty tracking, and inline error / "Saved" affordances. It owns no data
 * hooks — the caller loads/saves and passes the state in — so the same editing
 * surface backs the Agent Files editor and the Skill directory editor without
 * either duplicating the textarea + dirty/save logic.
 *
 * `resetKey` re-syncs the editor to `initialContent` when it changes (a tab
 * switch or a refetch); edits in progress are preserved until the caller
 * confirms a save cleared them.
 */
export function TextFileEditor({
  resetKey,
  initialContent,
  loading,
  saving,
  error,
  saved,
  placeholder,
  heading,
  onSave,
}: {
  resetKey: string;
  initialContent: string | undefined;
  loading: boolean;
  saving: boolean;
  error?: string;
  saved: boolean;
  placeholder?: string;
  heading?: string;
  onSave: (content: string, onSuccess: () => void) => void;
}) {
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);

  // Reset the editor whenever the loaded file changes (tab switch / refetch),
  // unless the user has unsaved edits in flight.
  useEffect(() => {
    if (initialContent !== undefined && !dirty) setContent(initialContent);
  }, [initialContent, dirty]);

  // A new file selection (resetKey change) drops any dirty state for the prior
  // file. Callers pass a stable per-file key so React remounts are unnecessary.
  useEffect(() => {
    setDirty(false);
  }, [resetKey]);

  return (
    <div className="space-y-3">
      {heading && <div className="text-xs font-medium text-neutral-500">{heading}</div>}
      <textarea
        value={content}
        disabled={loading}
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
          disabled={!dirty || saving}
          onClick={() => onSave(content, () => setDirty(false))}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        {error && <span className="text-xs text-[var(--color-danger)]">{error}</span>}
        {!dirty && saved && <span className="text-xs text-neutral-400">Saved</span>}
      </div>
    </div>
  );
}
