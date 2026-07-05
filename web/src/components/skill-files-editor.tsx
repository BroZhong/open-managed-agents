import { useEffect, useState } from "react";
import { FilePlus2, Trash2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TextFileEditor } from "@/components/text-file-editor";
import {
  useSkillFiles,
  useSkillFile,
  useSaveSkillFile,
  useDeleteSkillFile,
  useRenameSkillFile,
} from "@/lib/hooks/use-skills";

/**
 * Full-directory editor for a single Skill (a directory of SKILL.md + optional
 * attachment files, stored in S3). Scoped entirely by `skillId`, so the same
 * component edits a Library Skill on the Library page and an Agent's fork on the
 * Agent page — per ADR-0004 the fork is a separate id, so editing it never
 * touches the Library Skill.
 *
 * Left: file tree with add / rename / delete. Right: a text editor for the
 * selected file that saves back to S3.
 */
export function SkillFilesEditor({ skillId }: { skillId: string }) {
  const { data: files, isLoading } = useSkillFiles(skillId);
  const [active, setActive] = useState<string | null>(null);
  const del = useDeleteSkillFile(skillId);
  const rename = useRenameSkillFile(skillId);
  const save = useSaveSkillFile(skillId);

  // Default the selection to SKILL.md (or the first file) once files load.
  useEffect(() => {
    if (!files || files.length === 0) return;
    if (active && files.includes(active)) return;
    setActive(files.includes("SKILL.md") ? "SKILL.md" : files[0]);
  }, [files, active]);

  function addFile() {
    const path = window.prompt("New file path (relative to the Skill), e.g. notes.md");
    if (!path) return;
    save.mutate(
      { path: path.replace(/^\/+/, ""), content: "" },
      { onSuccess: () => setActive(path.replace(/^\/+/, "")) },
    );
  }

  return (
    <div className="grid grid-cols-[200px_1fr] gap-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Files
          </span>
          <Button size="icon" variant="ghost" aria-label="Add file" onClick={addFile}>
            <FilePlus2 className="h-4 w-4 text-neutral-400" />
          </Button>
        </div>
        {isLoading && <p className="text-sm text-neutral-400">Loading…</p>}
        {files?.length === 0 && !isLoading && (
          <p className="text-sm text-neutral-400">No files.</p>
        )}
        <ul className="space-y-0.5">
          {files?.map((path) => (
            <li
              key={path}
              className={cn(
                "group flex items-center justify-between gap-1 rounded px-2 py-1 text-sm",
                active === path
                  ? "bg-[var(--color-bg-muted)] text-[var(--color-fg)]"
                  : "text-neutral-600 hover:bg-[var(--color-bg-muted)]",
              )}
            >
              <button className="min-w-0 flex-1 truncate text-left" onClick={() => setActive(path)}>
                {path}
              </button>
              <span className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  aria-label={`Rename ${path}`}
                  className="p-0.5 text-neutral-400 hover:text-[var(--color-fg)]"
                  onClick={() => {
                    const to = window.prompt("Rename to", path);
                    if (to && to !== path)
                      rename.mutate(
                        { from: path, to: to.replace(/^\/+/, "") },
                        { onSuccess: () => setActive(to.replace(/^\/+/, "")) },
                      );
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  aria-label={`Delete ${path}`}
                  className="p-0.5 text-neutral-400 hover:text-[var(--color-danger)]"
                  onClick={() => {
                    if (window.confirm(`Delete ${path}?`)) {
                      del.mutate(path, {
                        onSuccess: () => setActive((a) => (a === path ? null : a)),
                      });
                    }
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>

      {active ? (
        <FileEditor key={active} skillId={skillId} path={active} />
      ) : (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] p-8 text-sm text-neutral-400">
          Select a file to edit.
        </div>
      )}
    </div>
  );
}

function FileEditor({ skillId, path }: { skillId: string; path: string }) {
  const { data, isLoading } = useSkillFile(skillId, path);
  const save = useSaveSkillFile(skillId);

  return (
    <TextFileEditor
      resetKey={path}
      heading={path}
      initialContent={data?.content}
      loading={isLoading}
      saving={save.isPending}
      error={save.isError ? (save.error as Error).message : undefined}
      saved={Boolean(data)}
      onSave={(content, onSuccess) => save.mutate({ path, content }, { onSuccess })}
    />
  );
}
