import { Link } from "react-router";
import { BookOpen } from "lucide-react";
import type { ReactNode } from "react";
import type { Skill } from "@/lib/hooks/use-skills";
import { formatRelativeTime } from "@/lib/utils";

export function SkillCard({ skill, to, actions }: { skill: Skill; to: string; actions?: ReactNode }) {
  return (
    <div className="agent-card" data-skill-id={skill.id}>
      <Link to={to} aria-label={`Open ${skill.name}`} className="flex h-full flex-col items-start gap-4 rounded-xl p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]">
        <div className="flex w-full items-center gap-3 pr-8">
          <span className="agent-identity"><BookOpen className="h-5 w-5" /></span>
          <h3 className="min-w-0 truncate text-sm font-semibold" title={skill.name}>{skill.name}</h3>
        </div>
        <p className="line-clamp-2 text-xs text-neutral-500">{skill.description || "No description."}</p>
        <span className="mt-auto text-xs text-neutral-400">Updated {formatRelativeTime(skill.updatedAt)}</span>
      </Link>
      {actions && <div className="absolute right-2 top-4">{actions}</div>}
    </div>
  );
}
