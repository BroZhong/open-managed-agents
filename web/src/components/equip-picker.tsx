import { useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
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
import { SkillFilesEditor } from "@/components/skill-files-editor";

/**
 * Equip picker (ADR-0004 fork-on-equip): a checklist of the tenant's Library
 * Skills. Equipping FORKS the Library Skill into an Agent-owned copy (a Skill
 * Fork); the checkmark reflects whether a fork of that Library Skill exists on
 * this Agent. Each equipped Skill expands to a file editor scoped to the fork
 * id — editing it never touches the Library Skill.
 */
export function EquipPicker({ agent }: { agent: Agent }) {
  const { data: library, isLoading } = useSkills();
  const {
    data: equipped,
    isLoading: equippedLoading,
    isFetching: equippedFetching,
    isError: equippedError,
    refetch: refetchEquipped,
  } = useAgentSkills(agent.id);
  const equip = useEquipSkill(agent.id);
  const unequip = useUnequipSkill(agent.id);
  const pendingWrites = usePendingAgentSkillWrites(agent.id);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Map Library Skill id → the Agent's fork of it (if equipped).
  const forkBySource = new Map<string, EquippedSkill>();
  for (const f of equipped ?? []) {
    if (f.sourceSkillId) forkBySource.set(f.sourceSkillId, f);
  }

  const saving = pendingWrites.isPending || equip.isPending || unequip.isPending;
  const busy = saving || equipped === undefined;

  function toggle(libraryId: string) {
    const fork = forkBySource.get(libraryId);
    if (fork) unequip.mutate(fork.id);
    else equip.mutate(libraryId);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">Skills</h2>
        {saving && <span className="text-xs text-neutral-400">Saving…</span>}
      </div>

      {(isLoading || equippedLoading || (equipped === undefined && equippedFetching)) && (
        <p className="text-sm text-neutral-400">Loading…</p>
      )}
      {equippedError && !equippedFetching && (
        <div className="flex items-center justify-between text-sm text-red-600">
          <span>Could not load equipped Skills.</span>
          <button
            className="rounded px-2 py-1 text-xs font-medium hover:bg-red-50"
            onClick={() => void refetchEquipped()}
          >
            Retry
          </button>
        </div>
      )}
      {library?.length === 0 && !isLoading && (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-4 text-center text-sm text-neutral-400">
          No Skills in the Library yet. Upload one from the entry page to equip it here.
        </div>
      )}

      <div className="space-y-2">
        {library?.map((skill) => {
          const fork = forkBySource.get(skill.id);
          const equipping = pendingWrites.equippingSkillIds.includes(skill.id);
          const unequipping = fork
            ? pendingWrites.unequippingForkIds.includes(fork.id)
            : false;
          const on = equipping || (!!fork && !unequipping);
          const isOpen = expanded === skill.id;
          return (
            <div
              key={skill.id}
              className={cn(
                "rounded-lg border transition-colors",
                on
                  ? "border-[var(--color-accent,#c2410c)] bg-[var(--color-bg-muted)]"
                  : "border-[var(--color-border)]",
              )}
            >
              <div className="flex items-center gap-2 p-3">
                <button
                  onClick={() => toggle(skill.id)}
                  disabled={busy}
                  aria-pressed={on}
                  className="flex flex-1 items-start gap-3 text-left"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                      on
                        ? "border-[var(--color-accent,#c2410c)] bg-[var(--color-accent,#c2410c)] text-white"
                        : "border-neutral-300",
                    )}
                  >
                    {on && <Check className="h-3 w-3" />}
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
                {on && fork && (
                  <button
                    aria-label={isOpen ? "Collapse editor" : "Edit equipped Skill"}
                    disabled={busy}
                    className="shrink-0 rounded p-1 text-neutral-400 hover:text-[var(--color-fg)]"
                    onClick={() => setExpanded(isOpen ? null : skill.id)}
                  >
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </button>
                )}
              </div>
              {on && isOpen && fork && (
                <div className="border-t border-[var(--color-border)] bg-white p-3">
                  <p className="mb-3 text-xs text-neutral-400">
                    Editing this Agent's private copy. Changes do not affect the Library Skill.
                  </p>
                  <SkillFilesEditor skillId={fork.id} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
