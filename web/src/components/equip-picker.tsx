import { useState } from "react";
import { Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  useSkills,
  useAgentSkills,
  useEquipSkill,
  useUnequipSkill,
  usePendingAgentSkillWrites,
  type EquippedSkill,
} from "@/lib/hooks/use-skills";
import { type Agent } from "@/lib/hooks/use-agents";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SkillFilesEditor } from "@/components/skill-files-editor";

/** The Agent's private Skill forks, alongside Library Skills available to equip. */
export function EquipPicker({ agent }: { agent: Agent }) {
  const libraryQuery = useSkills();
  const equippedQuery = useAgentSkills(agent.id);
  const equip = useEquipSkill(agent.id);
  const unequip = useUnequipSkill(agent.id);
  const pendingWrites = usePendingAgentSkillWrites(agent.id);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pendingUnequip, setPendingUnequip] = useState<EquippedSkill | null>(null);

  const library = libraryQuery.data ?? [];
  const equipped = equippedQuery.data ?? [];
  const ready = libraryQuery.data !== undefined && equippedQuery.data !== undefined;
  const loading = libraryQuery.isLoading || equippedQuery.isLoading
    || (libraryQuery.data === undefined && libraryQuery.isFetching)
    || (equippedQuery.data === undefined && equippedQuery.isFetching);
  const error = libraryQuery.error || equippedQuery.error;
  const busy = pendingWrites.isPending || equip.isPending || unequip.isPending;
  const forkBySource = new Map<string, EquippedSkill>();
  for (const fork of equipped) {
    if (fork.sourceSkillId) forkBySource.set(fork.sourceSkillId, fork);
  }

  // Always show the Agent's actual metadata, even if its Library source was
  // edited or deleted after equip (ADR-0004).
  const libraryIds = new Set(library.map((skill) => skill.id));
  const rows = [
    ...library.map((skill) => ({
      skill: forkBySource.get(skill.id) ?? skill,
      fork: forkBySource.get(skill.id),
      libraryId: skill.id,
    })),
    ...equipped
      .filter((fork) => !fork.sourceSkillId || !libraryIds.has(fork.sourceSkillId))
      .map((fork) => ({ skill: fork, fork, libraryId: undefined })),
  ];

  function toggle(fork: EquippedSkill | undefined, libraryId: string | undefined) {
    if (fork) {
      setPendingUnequip(fork);
    } else if (libraryId) {
      equip.mutate(libraryId, {
        onError: (err) => toast.error(err.message || "Failed to enable Skill"),
      });
    }
  }

  function confirmUnequip() {
    if (!pendingUnequip || busy) return;
    const forkId = pendingUnequip.id;
    unequip.mutate(forkId, {
      onSuccess: () => setExpanded((current) => current === forkId ? null : current),
      onError: (err) => toast.error(err.message || "Failed to disable Skill"),
    });
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">Skills</h2>
        {busy && <span role="status" className="text-xs text-neutral-400">Saving…</span>}
      </div>

      {loading && <p className="text-sm text-neutral-400">Loading Skills…</p>}
      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 text-sm text-[var(--color-danger)]">
          <span>Failed to load Skills: {error.message}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={libraryQuery.isFetching || equippedQuery.isFetching}
            onClick={() => {
              if (libraryQuery.error) void libraryQuery.refetch();
              if (equippedQuery.error) void equippedQuery.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {!loading && !error && rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-4 text-center text-sm text-neutral-400">
          No Skills yet. Upload a Skill in the Skill Library to equip it here.
        </div>
      )}

      {ready && rows.map(({ skill, fork, libraryId }) => {
        const equipping = !!libraryId && pendingWrites.equippingSkillIds.includes(libraryId);
        const unequipping = !!fork && pendingWrites.unequippingForkIds.includes(fork.id);
        const enabled = equipping || (!!fork && !unequipping);
        const isOpen = expanded === skill.id;
        const editorId = `skill-editor-${skill.id}`;
        return (
          <div
            key={skill.id}
            className={cn(
              "min-w-0 rounded-lg border transition-colors",
              enabled
                ? "border-[var(--color-accent,#c2410c)] bg-[var(--color-bg-muted)]"
                : "border-[var(--color-border)] bg-white",
            )}
          >
            <div className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h3 className="min-w-0 flex-1 break-words text-sm font-semibold text-[var(--color-fg)] [overflow-wrap:anywhere]">
                  {skill.name}
                </h3>
                <div className="flex shrink-0 items-center gap-3">
                  <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-neutral-600">
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={busy}
                      aria-label={`Enable ${skill.name}`}
                      onChange={() => toggle(fork, libraryId)}
                      className="h-4 w-4 accent-[var(--color-accent,#c2410c)] disabled:cursor-wait"
                    />
                    {enabled ? "Enabled" : "Disabled"}
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!fork || !enabled || busy}
                    aria-label={isOpen ? `Close editor for ${skill.name}` : `Update ${skill.name}`}
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? editorId : undefined}
                    title={enabled ? "Edit this Agent's Skill" : "Enable this Skill to edit its Agent copy"}
                    onClick={() => setExpanded(isOpen ? null : skill.id)}
                  >
                    {isOpen ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                    {isOpen ? "Close editor" : "Update"}
                  </Button>
                </div>
              </div>

              <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-neutral-500 [overflow-wrap:anywhere]">
                {skill.description || "No description."}
              </p>

              <dl className="grid min-w-0 grid-cols-1 gap-3 text-xs sm:grid-cols-2 xl:grid-cols-3">
                <div className="min-w-0">
                  <dt className="text-neutral-400">ID</dt>
                  <dd className="mt-1 break-all font-mono text-neutral-600">{skill.id}</dd>
                </div>
                <div>
                  <dt className="text-neutral-400">Uploaded</dt>
                  <dd className="mt-1 text-neutral-600"><SkillTimestamp value={skill.createdAt} /></dd>
                </div>
                <div>
                  <dt className="text-neutral-400">Updated</dt>
                  <dd className="mt-1 text-neutral-600"><SkillTimestamp value={skill.updatedAt} /></dd>
                </div>
              </dl>
            </div>

            {fork && enabled && isOpen && (
              <div id={editorId} className="min-w-0 rounded-b-lg border-t border-[var(--color-border)] bg-white p-3">
                <p className="mb-3 text-xs text-neutral-500">
                  Editing this Agent's private copy. Changes do not affect the Library Skill.
                </p>
                <div className="overflow-x-auto">
                  <div className="min-w-[560px]">
                    <SkillFilesEditor skillId={skill.id} agentId={agent.id} />
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <ConfirmDialog
        open={pendingUnequip !== null}
        onOpenChange={(open) => { if (!open) setPendingUnequip(null); }}
        title="Disable Skill"
        description={`Disabling "${pendingUnequip?.name ?? ""}" removes this Agent's private copy, including any edits. ${pendingUnequip?.sourceSkillId && libraryIds.has(pendingUnequip.sourceSkillId) ? "Enabling it again creates a new copy from the Skill Library." : "Its Library source is no longer available, so it cannot be enabled again from this page."}`}
        onConfirm={confirmUnequip}
        confirmLabel="Disable and remove copy"
      />
    </div>
  );
}

function SkillTimestamp({ value }: { value: string | null | undefined }) {
  if (!value) return <>Unknown</>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <>Unknown</>;
  return <time dateTime={value} title={date.toISOString()}>{date.toLocaleString()}</time>;
}
