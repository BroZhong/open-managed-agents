import { createContext } from "react";
import type { EquippedSkill } from "@/lib/hooks/use-skills";

export interface ConversationResources {
  /** Restrict all resource navigation to Workspace paths in a share. */
  shared?: boolean;
  agentId: string;
  skills: EquippedSkill[];
  onOpenWorkspacePath?: (path: string) => void;
}
export const ConversationResourcesContext = createContext<ConversationResources | undefined>(undefined);
export const CodeBlockContext = createContext(false);

