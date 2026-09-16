import { useState } from "react";
import { Pencil, X, Info } from "lucide-react";
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
import { SkillFilesEditor } from "@/components/skill-files-editor";

/** The Agent's private Skill forks, alongside Library Skills available to equip. */
export function EquipPicker({ agent }: { agent: Agent }) {
  const libraryQuery = useSkills();
  const equippedQuery = useAgentSkills(agent.id);
  const equip = useEquipSkill(agent.id);
  const unequip = useUnequipSkill(agent.id);
  const pendingWrites = usePendingAgentSkillWrites(agent.id);
  const [detailsOpen, setDetailsOpen] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

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
    if (busy) return;
    if (fork) {
      unequip.mutate(fork.id, {
        onSuccess: () => setExpanded((current) => current === fork.id ? null : current),
        onError: (err) => toast.error(err.message || "Failed to disable Skill"),
      });
    } else if (libraryId) {
      equip.mutate(libraryId, {
        onError: (err) => toast.error(err.message || "Failed to enable Skill"),
      });
    }
  }

  return (
    <div className="skill-picker min-w-0 space-y-1">
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
          <div key={skill.id} data-skill-id={skill.id} className={cn("skill-compact-item", enabled && "skill-enabled")}>
            <div className="skill-compact-row">
              <label className="skill-enable-control" title={enabled ? "Enabled" : "Disabled"}>
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={busy}
                  aria-label={`Enable ${skill.name}`}
                  onChange={() => toggle(fork, libraryId)}
                />
                <span className="sr-only">{enabled ? "Enabled" : "Disabled"}</span>
              </label>
              <div className="skill-compact-copy">
                <h3 title={skill.name}>{skill.name}</h3>
                <p title={skill.description || "No description."}>{skill.description || "No description."}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Details for ${skill.name}`}
                aria-expanded={detailsOpen === skill.id}
                aria-controls={`skill-details-${skill.id}`}
                onClick={() => setDetailsOpen(detailsOpen === skill.id ? null : skill.id)}
              ><Info className="h-3.5 w-3.5" /></Button>
              <Button
                variant="ghost"
                size="icon"
                disabled={!fork || !enabled || busy}
                aria-label={isOpen ? `Close editor for ${skill.name}` : `Update ${skill.name}`}
                aria-expanded={isOpen}
                aria-controls={isOpen ? editorId : undefined}
                title={enabled ? "Edit this Agent's Skill" : "Enable this Skill to edit its Agent copy"}
                onClick={() => setExpanded(isOpen ? null : skill.id)}
              >{isOpen ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}</Button>
            </div>
            <dl id={`skill-details-${skill.id}`} hidden={detailsOpen !== skill.id} className="skill-compact-details">
              <div><dt>ID</dt><dd className="break-all font-mono">{skill.id}</dd></div>
              <div><dt>Uploaded</dt><dd><SkillTimestamp value={skill.createdAt} /></dd></div>
              <div><dt>Updated</dt><dd><SkillTimestamp value={skill.updatedAt} /></dd></div>
            </dl>

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
    </div>
  );
}

function SkillTimestamp({ value }: { value: string | null | undefined }) {
  if (!value) return <>Unknown</>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <>Unknown</>;
  return <time dateTime={value} title={date.toISOString()}>{date.toLocaleString()}</time>;
}
