import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSkills } from "@/lib/hooks/use-skills";
import { useUpdateAgent, type Agent } from "@/lib/hooks/use-agents";

/**
 * Equip picker: a checklist of the tenant's Library Skills with those already
 * on the Agent checked. Toggling reuses the agent-update route with the
 * `skills` field (equip is by reference — a skillId list — never a copy; one
 * Skill can be equipped on many Agents). The equipped Skills reach the Agent's
 * Turns through the session-router materialize path.
 */
export function EquipPicker({ agent }: { agent: Agent }) {
  const { data: skills, isLoading } = useSkills();
  const update = useUpdateAgent();
  const equipped = new Set(agent.skills ?? []);

  function toggle(skillId: string) {
    const next = new Set(equipped);
    if (next.has(skillId)) next.delete(skillId);
    else next.add(skillId);
    update.mutate({
      id: agent.id,
      name: agent.name,
      model: agent.model,
      system: agent.system,
      runtime: agent.runtime,
      sandbox: agent.sandbox,
      skills: [...next],
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">Skills</h2>
        {update.isPending && <span className="text-xs text-neutral-400">Saving…</span>}
      </div>

      {isLoading && <p className="text-sm text-neutral-400">Loading…</p>}
      {skills?.length === 0 && !isLoading && (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-4 text-center text-sm text-neutral-400">
          No Skills in the Library yet. Upload one from the entry page to equip it here.
        </div>
      )}

      <div className="space-y-2">
        {skills?.map((skill) => {
          const on = equipped.has(skill.id);
          return (
            <button
              key={skill.id}
              onClick={() => toggle(skill.id)}
              className={cn(
                "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                on
                  ? "border-[var(--color-accent,#c2410c)] bg-[var(--color-bg-muted)]"
                  : "border-[var(--color-border)] hover:bg-[var(--color-bg-muted)]",
              )}
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
          );
        })}
      </div>
    </div>
  );
}
