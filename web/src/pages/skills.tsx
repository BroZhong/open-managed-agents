import { PageHeader } from "@/components/page-header";
import { SkillLibrary } from "@/components/skill-library";

/**
 * The tenant Skill Library as a first-class page (reached from the global left
 * nav). Skills are reusable, instruction-only capabilities equipped onto Agents
 * by reference from the Agent detail page.
 */
export default function SkillsPage() {
  return (
    <div>
      <PageHeader title="Skills" />
      <div className="p-6">
        <div className="max-w-2xl">
          <SkillLibrary />
        </div>
      </div>
    </div>
  );
}
