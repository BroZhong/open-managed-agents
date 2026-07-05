import { useRef, useState } from "react";
import { Trash2, Upload, BookOpen, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SkillFilesEditor } from "@/components/skill-files-editor";
import {
  collectDroppedEntries,
  collectInputFiles,
  detectSkillsError,
  useSkills,
  useUploadSkills,
  useDeleteSkill,
  type DroppedFile,
} from "@/lib/hooks/use-skills";

/**
 * The tenant Skill Library: drag a folder (or pick one) to upload reusable,
 * instruction-only Skills, then browse, preview/edit their files, and delete
 * them. Skills are equipped (forked) onto Agents elsewhere. Self-contained so
 * it can sit on the entry page alongside the Agents list.
 */
export function SkillLibrary() {
  const { data: skills, isLoading } = useSkills();
  const upload = useUploadSkills();
  const del = useDeleteSkill();
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(files: DroppedFile[]) {
    setError(null);
    if (files.length === 0) {
      setError("Drop a folder containing a SKILL.md.");
      return;
    }
    const clientError = detectSkillsError(files.map((f) => f.path));
    if (clientError) {
      setError(clientError);
      return;
    }
    upload.mutate(files, { onError: (e) => setError((e as Error).message) });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <BookOpen className="h-4 w-4 text-[var(--color-accent,#c2410c)]" />
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">Skill Library</h2>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setDragging(false);
          const files = await collectDroppedEntries(e.dataTransfer.items);
          void submit(files);
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors",
          dragging
            ? "border-[var(--color-accent,#c2410c)] bg-[var(--color-bg-muted)]"
            : "border-[var(--color-border)] hover:bg-[var(--color-bg-muted)]",
        )}
      >
        <Upload className="h-5 w-5 text-neutral-400" />
        <p className="text-sm text-neutral-500">
          {upload.isPending ? "Uploading…" : "Drag a Skill folder here, or click to choose"}
        </p>
        <input
          ref={inputRef}
          type="file"
          // @ts-expect-error non-standard directory-picker attributes
          webkitdirectory=""
          directory=""
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void submit(collectInputFiles(e.target.files));
            e.target.value = "";
          }}
        />
      </div>

      {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}

      <div className="space-y-2">
        {isLoading && <p className="text-sm text-neutral-400">Loading…</p>}
        {skills?.length === 0 && !isLoading && (
          <p className="text-sm text-neutral-400">No Skills yet.</p>
        )}
        {skills?.map((skill) => {
          const isOpen = expanded === skill.id;
          return (
            <div
              key={skill.id}
              className="rounded-lg border border-[var(--color-border)] bg-white"
            >
              <div className="flex items-start justify-between gap-3 p-3">
                <button
                  className="flex min-w-0 flex-1 items-start gap-2 text-left"
                  onClick={() => setExpanded(isOpen ? null : skill.id)}
                >
                  <span className="mt-0.5 shrink-0 text-neutral-400">
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-[var(--color-fg)]">
                      {skill.name}
                    </span>
                    {skill.description && (
                      <span className="block truncate text-xs text-neutral-500">
                        {skill.description}
                      </span>
                    )}
                  </span>
                </button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${skill.name}`}
                  onClick={() => del.mutate(skill.id)}
                >
                  <Trash2 className="h-4 w-4 text-neutral-400" />
                </Button>
              </div>
              {isOpen && (
                <div className="border-t border-[var(--color-border)] p-3">
                  <SkillFilesEditor skillId={skill.id} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
