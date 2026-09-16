import { useRef, useState } from "react";
import { Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SkillCard } from "@/components/skill-card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { Skill } from "@/lib/hooks/use-skills";
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
 * them. Cards open the dedicated file workbench; Agents equip private copies.
 */
export function SkillLibrary() {
  const { data: skills, isLoading, error: loadError, refetch } = useSkills();
  const upload = useUploadSkills();
  const del = useDeleteSkill();
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Skill | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(files: DroppedFile[]) {
    if (upload.isPending) return;
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
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload Skill folder"
        aria-disabled={upload.isPending}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!upload.isPending) inputRef.current?.click();
          }
        }}
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
          disabled={upload.isPending}
          // @ts-expect-error non-standard directory-picker attributes
          webkitdirectory=""
          directory=""
          multiple
          hidden
          aria-label="Skill folder files"
          onChange={(e) => {
            if (e.target.files) void submit(collectInputFiles(e.target.files));
            e.target.value = "";
          }}
        />
      </div>

      {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}

      {loadError && <div role="alert" className="text-sm text-[var(--color-danger)]">{loadError.message}<Button variant="ghost" onClick={() => void refetch()}>Retry</Button></div>}
      {isLoading && <p className="text-sm text-neutral-400">Loading…</p>}
      {skills?.length === 0 && !isLoading && <p className="text-sm text-neutral-400">No Skills yet. Upload a Skill folder to get started.</p>}
      <div className="agent-directory">
        {skills?.map((skill) => (
          <SkillCard key={skill.id} skill={skill} to={`/skills/${skill.id}`} actions={
            <Button variant="ghost" size="icon" title={`Delete ${skill.name}`} aria-label={`Delete ${skill.name}`} disabled={del.isPending} onClick={() => setDeleting(skill)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          } />
        ))}
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title="Delete Skill"
        description={`Delete "${deleting?.name ?? ""}" from the Library? Existing Agent copies stay unchanged.`}
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleting) del.mutate(deleting.id, { onError: (err) => setError(err.message) });
        }}
      />
    </div>
  );
}
