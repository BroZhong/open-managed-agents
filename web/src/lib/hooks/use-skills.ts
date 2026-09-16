import {
  useQuery,
  useMutation,
  useQueryClient,
  useMutationState,
} from "@tanstack/react-query";
import { ApiError, apiFetch, apiUpload } from "@/lib/api";

export interface Skill {
  id: string;
  name: string;
  description: string;
  createdAt: string | null;
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

export interface SkillDetail extends Skill {
  ownerType: "library" | "agent";
  ownerId: string;
  sourceSkillId: string | null;
  files: string[];
}

export function useSkill(id: string) {
  return useQuery({
    queryKey: ["skills", id],
    queryFn: () => apiFetch<SkillDetail>(`/v1/skills/${id}`),
    enabled: !!id,
  });
}

export function useSkills(enabled = true) {
  return useQuery({
    queryKey: ["skills"],
    enabled,
    queryFn: async ({ signal }) => {
      const skills: Skill[] = [];
      let cursor: string | undefined;
      do {
        const page = await apiFetch<SkillListResponse>(cursor ? `/v1/skills?cursor=${encodeURIComponent(cursor)}` : "/v1/skills", { signal });
        skills.push(...page.data);
        cursor = page.has_more ? page.next_cursor : undefined;
      } while (cursor);
      return skills;
    },
  });
}

export function useUploadSkills() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (files: DroppedFile[]) => {
      const form = new FormData();
      form.set("paths", JSON.stringify(files.map((f) => f.path)));
      for (const f of files) form.append("files", f.file, f.path);
      try {
        return await apiUpload<{ data: Skill[] }>("/v1/skills", form);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "skill_name_conflict") throw error;
        if (!window.confirm(error.message + "\nThis replaces the entire Skill folder. Existing Agent copies stay unchanged.")) return;
        form.set("overwrite", "true");
        return apiUpload<{ data: Skill[] }>("/v1/skills", form);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
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
  createdAt: string | null;
  updatedAt: string;
}

function agentSkillWriteKey(agentId: string, action: "equip" | "unequip") {
  return ["agents", agentId, "skills", "write", action] as const;
}

export function usePendingAgentSkillWrites(agentId: string) {
  const equippingSkillIds = useMutationState<string>({
    filters: {
      mutationKey: agentSkillWriteKey(agentId, "equip"),
      status: "pending",
      exact: true,
    },
    select: (mutation) => mutation.state.variables as string,
  });
  const unequippingForkIds = useMutationState<string>({
    filters: {
      mutationKey: agentSkillWriteKey(agentId, "unequip"),
      status: "pending",
      exact: true,
    },
    select: (mutation) => mutation.state.variables as string,
  });
  return {
    equippingSkillIds,
    unequippingForkIds,
    isPending: equippingSkillIds.length + unequippingForkIds.length > 0,
  };
}

/** The Agent's equipped Skills (its forks). */
export function useAgentSkills(agentId: string) {
  return useQuery({
    queryKey: ["agents", agentId, "skills"],
    queryFn: ({ signal }) =>
      apiFetch<{ data: EquippedSkill[] }>(
        `/v1/agents/${agentId}/skills`,
        { signal },
      ).then((r) => r.data),
    enabled: !!agentId,
  });
}

/** Equip a Library Skill onto an Agent (forks it). */
export function useEquipSkill(agentId: string) {
  const queryClient = useQueryClient();
  const queryKey = ["agents", agentId, "skills"] as const;
  return useMutation({
    mutationKey: agentSkillWriteKey(agentId, "equip"),
    mutationFn: async (skillId: string) => {
      const send = (overwrite = false) => apiFetch<EquippedSkill>(`/v1/agents/${agentId}/skills`, {
        method: "POST",
        body: JSON.stringify({ skillId, ...(overwrite ? { overwrite: true } : {}) }),
      });
      try {
        return await send();
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "skill_name_conflict") throw error;
        if (!window.confirm(error.message + "\nReplace this Agent's copy with the Library Skill?")) return;
        return send(true);
      }
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey, exact: true });
    },
    onSuccess: async (fork) => {
      if (!fork) return;
      await queryClient.cancelQueries(
        { queryKey, exact: true },
        { revert: false },
      );
      queryClient.setQueryData<EquippedSkill[]>(queryKey, (current = []) => [
        ...current.filter((skill) => skill.id !== fork.id && skill.name !== fork.name && skill.sourceSkillId !== fork.sourceSkillId),
        fork,
      ]);
      void queryClient.invalidateQueries({
        queryKey: ["agents", agentId],
        exact: true,
      });
    },
  });
}

/** Unequip a Skill from an Agent (deletes the Agent's fork). */
export function useUnequipSkill(agentId: string) {
  const queryClient = useQueryClient();
  const queryKey = ["agents", agentId, "skills"] as const;
  return useMutation({
    mutationKey: agentSkillWriteKey(agentId, "unequip"),
    mutationFn: (forkId: string) =>
      apiFetch<{ type: string }>(`/v1/agents/${agentId}/skills/${forkId}`, { method: "DELETE" }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey, exact: true });
    },
    onSuccess: async (_result, forkId) => {
      await queryClient.cancelQueries(
        { queryKey, exact: true },
        { revert: false },
      );
      queryClient.setQueryData<EquippedSkill[]>(queryKey, (current = []) =>
        current.filter((skill) => skill.id !== forkId),
      );
      void queryClient.invalidateQueries({
        queryKey: ["agents", agentId],
        exact: true,
      });
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
