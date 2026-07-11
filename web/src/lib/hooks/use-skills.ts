import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiUpload } from "@/lib/api";

export interface Skill {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
}

interface SkillListResponse {
  data: Skill[];
  has_more: boolean;
  next_cursor?: string;
}

/** A file collected from a dropped folder: root-relative path + the File blob. */
export interface DroppedFile {
  path: string;
  file: File;
}

export function useSkills() {
  return useQuery({
    queryKey: ["skills"],
    queryFn: () => apiFetch<SkillListResponse>("/v1/skills").then((r) => r.data),
  });
}

export function useUploadSkills() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (files: DroppedFile[]) => {
      const form = new FormData();
      form.set("paths", JSON.stringify(files.map((f) => f.path)));
      for (const f of files) form.append("files", f.file, f.path);
      return apiUpload<{ data: Skill[] }>("/v1/skills", form);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });
}

export function useDeleteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ type: string; id: string }>(`/v1/skills/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });
}

// --- Equipped Skills (Agent forks, ADR-0004) ------------------------------

/** An Agent's equipped Skill (a fork). `sourceSkillId` is the Library Skill it came from. */
export interface EquippedSkill {
  id: string;
  name: string;
  description: string;
  sourceSkillId: string | null;
  updatedAt: string;
}

/** The Agent's equipped Skills (its forks). */
export function useAgentSkills(agentId: string) {
  return useQuery({
    queryKey: ["agents", agentId, "skills"],
    queryFn: () =>
      apiFetch<{ data: EquippedSkill[] }>(`/v1/agents/${agentId}/skills`).then((r) => r.data),
    enabled: !!agentId,
  });
}

/** Equip a Library Skill onto an Agent (forks it). */
export function useEquipSkill(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (skillId: string) =>
      apiFetch<EquippedSkill>(`/v1/agents/${agentId}/skills`, {
        method: "POST",
        body: JSON.stringify({ skillId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents", agentId, "skills"] });
      queryClient.invalidateQueries({ queryKey: ["agents", agentId] });
    },
  });
}

/** Unequip a Skill from an Agent (deletes the Agent's fork). */
export function useUnequipSkill(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (forkId: string) =>
      apiFetch<{ type: string }>(`/v1/agents/${agentId}/skills/${forkId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents", agentId, "skills"] });
      queryClient.invalidateQueries({ queryKey: ["agents", agentId] });
    },
  });
}

/**
 * Client-side mirror of the server's single/multi-Skill detection, for instant
 * drop feedback (the server re-validates authoritatively). Returns an error
 * string when the drop is invalid, else null.
 */
export function detectSkillsError(paths: string[]): string | null {
  const norm = paths.map((p) => p.replace(/^\/+/, "").replace(/^\.\//, ""));
  const rootSkillMd = norm.some((p) => p === "SKILL.md");
  const childDirs = new Set(
    norm
      .map((p) => {
        const i = p.indexOf("/");
        return i > 0 && p.slice(i + 1) === "SKILL.md" ? p.slice(0, i) : null;
      })
      .filter((d): d is string => !!d),
  );
  if (rootSkillMd && childDirs.size > 0) {
    return "Ambiguous folder: both a root SKILL.md and nested SKILL.md files were found.";
  }
  if (!rootSkillMd && childDirs.size === 0) {
    return "No SKILL.md found. A Skill folder must contain a SKILL.md.";
  }
  return null;
}

/**
 * Walk a dropped `FileSystemEntry` tree (from the drag-drop directory API) into
 * a flat list of (root-relative path, File) pairs. Skips the dropped folder's
 * own name so paths are rooted at the folder's contents (matching detection).
 */
export async function collectDroppedEntries(
  items: DataTransferItemList,
): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  const roots: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  async function walk(entry: FileSystemEntry, prefix: string): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) =>
        (entry as FileSystemFileEntry).file(res, rej),
      );
      out.push({ path: `${prefix}${entry.name}`, file });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children = await readAllEntries(reader);
      for (const child of children) await walk(child, `${prefix}${entry.name}/`);
    }
  }
  // If a single directory was dropped, root at its contents (strip its name).
  if (roots.length === 1 && roots[0].isDirectory) {
    const reader = (roots[0] as FileSystemDirectoryEntry).createReader();
    const children = await readAllEntries(reader);
    for (const child of children) await walk(child, "");
  } else {
    for (const root of roots) await walk(root, "");
  }
  return out;
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const read = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          read();
        }
      }, reject);
    read();
  });
}

/** Flatten a `<input webkitdirectory>` FileList using each File's relative path. */
export function collectInputFiles(fileList: FileList): DroppedFile[] {
  const files = Array.from(fileList);
  // Strip the common top-level folder name so paths root at its contents.
  const rel = (f: File) => (f.webkitRelativePath || f.name).split("/");
  const hasCommonRoot =
    files.length > 0 && files.every((f) => rel(f).length > 1 && rel(f)[0] === rel(files[0])[0]);
  return files.map((f) => {
    const parts = rel(f);
    const path = hasCommonRoot ? parts.slice(1).join("/") : parts.join("/");
    return { path, file: f };
  });
}
