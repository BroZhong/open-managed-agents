import type { SkillArtifactStore } from "@oma-server/store";

/** Replace the complete tree, restoring the previous files if a write fails. */
export async function replaceSkillFiles(
  artifacts: SkillArtifactStore,
  tenantId: string,
  skillId: string,
  files: { path: string; body: Uint8Array | string }[],
) {
  const previous = await artifacts.getAll(tenantId, skillId);
  try {
    for (const file of files) await artifacts.put(tenantId, skillId, file.path, file.body);
    const paths = new Set(files.map((file) => file.path));
    for (const file of previous) {
      if (!paths.has(file.path)) await artifacts.delete(tenantId, skillId, file.path);
    }
  } catch (error) {
    await artifacts.deleteTree(tenantId, skillId);
    for (const file of previous) await artifacts.put(tenantId, skillId, file.path, file.body);
    throw error;
  }
}
