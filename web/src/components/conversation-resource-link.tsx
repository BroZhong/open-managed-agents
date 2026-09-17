import { useContext, type ReactNode } from "react";
import { Link } from "react-router";
import { ConversationResourcesContext, CodeBlockContext } from "@/lib/conversation-resources";
import { resolveResourcePath } from "@/lib/resource-path";

export function ConversationResourceLink({ href, children, inlineCode = false }: {
  href?: string; children: ReactNode; inlineCode?: boolean;
}) {
  const resources = useContext(ConversationResourcesContext);
  const codeBlock = useContext(CodeBlockContext);
  const target = resources && href && !codeBlock ? resolveResourcePath(href, resources.skills) : null;
  if (resources?.shared && target?.kind !== "workspace") {
    return <span title="This link is outside the shared Workspace.">{children}</span>;
  }
  if (resources && target?.kind === "skill") {
    return <Link to={`/agents/${resources.agentId}/skills/${target.skillId}`}>{children}</Link>;
  }
  if (target?.kind === "unavailable-skill") {
    return <span title="This Skill is not equipped on the current Agent.">{children}</span>;
  }
  if (!inlineCode && resources?.onOpenWorkspacePath && target?.kind === "workspace") {
    return <a href={href} onClick={(event) => { event.preventDefault(); resources.onOpenWorkspacePath!(target.path); }}>{children}</a>;
  }
  return inlineCode ? <>{children}</> : <a href={href}>{children}</a>;
}
