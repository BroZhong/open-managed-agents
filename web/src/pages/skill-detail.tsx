import { Link, useParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { SkillFilesEditor } from "@/components/skill-files-editor";
import { Button } from "@/components/ui/button";
import { useSkill } from "@/lib/hooks/use-skills";

export default function SkillDetailPage() {
  const { skillId = "", id: agentId } = useParams();
  const { data: skill, isLoading, error, refetch } = useSkill(skillId);
  const back = agentId ? `/agents/${agentId}` : "/skills";
  const matchesOwner = skill && (agentId ? skill.ownerType === "agent" && skill.ownerId === agentId : skill.ownerType === "library");
  return (
    <div>
      <PageHeader title={matchesOwner ? skill.name : "Skill"} description={matchesOwner ? skill.description : undefined}>
        <Link to={back} className="inline-flex items-center gap-2 text-sm text-neutral-500"><ArrowLeft className="h-4 w-4" />{agentId ? "Back to Agent" : "Back to Skills"}</Link>
      </PageHeader>
      <div className="page-body">
        {isLoading ? <p>Loading Skill…</p> : error ? (
          <div role="alert">{error.message}<Button variant="ghost" onClick={() => void refetch()}>Retry</Button></div>
        ) : !matchesOwner ? <p>Skill not found.</p> : (
          <>
            <p className="mb-4 text-xs text-neutral-500">{agentId ? "This Agent's private Skill copy. Changes do not affect other Agents or the Library." : "Library Skill. Changes do not affect existing Agent copies."}</p>
            <div className="h-[calc(100dvh-240px)] min-h-[480px] overflow-hidden rounded-xl border border-[var(--color-border)] bg-white">
              <SkillFilesEditor skillId={skill.id} agentId={agentId} presentation="workbench" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
