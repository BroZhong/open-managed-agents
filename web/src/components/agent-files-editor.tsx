import { useMemo } from "react";
import { FileManager } from "@/components/file-manager";
import { createAgentFileSource } from "@/lib/file-source";

/**
 * Agent Files editor — now a thin wrapper over the unified {@link FileManager}
 * (#103). It supplies a {@link createAgentFileSource} scoped by `agentId`.
 *
 * AgentFileSource is flat with a fixed set of four names (IDENTITY / SOUL /
 * USER / MEMORY, assembled into the runtime prompt in that order). It exposes
 * `write` and `delete` but NOT `rename` or `upload` — so FileManager, driven by
 * `methodsOf` → `resolveFileActions`, renders no rename/upload affordances. It
 * is not idle-gated, so `turnStatus` never gates writes; we pass `"idle"`.
 */
export function AgentFilesEditor({ agentId }: { agentId: string }) {
  const source = useMemo(() => createAgentFileSource(agentId), [agentId]);
  return <FileManager key={agentId} source={source} turnStatus="idle" />;
}
