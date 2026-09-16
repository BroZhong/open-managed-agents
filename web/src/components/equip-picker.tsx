import { useRef, useState } from "react";
import { Plus, Trash2, Upload } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  useSkills, useAgentSkills, useEquipSkill, useUnequipSkill,
  usePendingAgentSkillWrites, useUploadSkills, collectInputFiles, detectSkillsError,
  type EquippedSkill,
} from "@/lib/hooks/use-skills";
import type { Agent } from "@/lib/hooks/use-agents";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader, DialogFooter } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SkillCard } from "@/components/skill-card";

/** Only this Agent's private copies are displayed; the Library is opt-in. */
export function EquipPicker({ agent }: { agent: Agent }) {
  const equippedQuery = useAgentSkills(agent.id);
  const [importOpen, setImportOpen] = useState(false);
  const libraryQuery = useSkills(importOpen);
  const equip = useEquipSkill(agent.id);
  const unequip = useUnequipSkill(agent.id);
  const pendingWrites = usePendingAgentSkillWrites(agent.id);
  const upload = useUploadSkills({ overwrite: true });
  const inputRef = useRef<HTMLInputElement>(null);
  const operationRef = useRef(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [removing, setRemoving] = useState<EquippedSkill | null>(null);
  const equipped = equippedQuery.data ?? [];
  const busy = working || pendingWrites.isPending;
  const ready = equippedQuery.data !== undefined && !equippedQuery.error;
  const equippedNames = new Set(equipped.map((skill) => skill.name));
  const equippedSources = new Set(equipped.map((skill) => skill.sourceSkillId));
  const available = libraryQuery.data ?? [];
  const visible = available.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(search.toLowerCase()));
  const selectedIds = available.filter((skill) => selected.has(skill.id)).map((skill) => skill.id);

  async function equipMany(ids: string[]) {
    let count = 0;
    // Sequential requests avoid overwriting Agent.skills with concurrent equips.
    for (const id of ids) {
      const fork = await equip.mutateAsync(id);
      if (fork) {
        count++;
        setSelected((current) => { const next = new Set(current); next.delete(id); return next; });
      }
    }
    if (count) toast.success(count === 1 ? "Skill equipped" : `${count} Skills equipped`);
    return count;
  }

  async function importSelected() {
    if (busy || operationRef.current || !selectedIds.length) return;
    operationRef.current = true;
    setWorking(true);
    setError(null);
    try {
      const count = await equipMany(selectedIds);
      if (count === selectedIds.length) setImportOpen(false);
    } catch (err) {
      setError(`${err instanceof Error ? err.message : "Failed to equip Skills"}. Already equipped Skills are saved; retry the remaining selection.`);
    } finally {
      operationRef.current = false;
      setWorking(false);
    }
  }

  async function uploadAndEquip(fileList: FileList) {
    if (busy || operationRef.current || !fileList.length) return;
    const files = collectInputFiles(fileList);
    const validationError = detectSkillsError(files.map((file) => file.path));
    setError(validationError);
    if (validationError) return;
    operationRef.current = true;
    setWorking(true);
    let uploaded = false;
    try {
      const result = await upload.mutateAsync(files);
      if (!result) return;
      uploaded = true;
      await equipMany(result.data.map((skill) => skill.id));
    } catch (err) {
      setError(`${err instanceof Error ? err.message : "Failed to upload Skills"}${uploaded ? ". Uploaded Skills are saved in the Library. Choose Import Skills to retry." : ""}`);
    } finally {
      operationRef.current = false;
      setWorking(false);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">Skills</h2>
        <div className="flex flex-wrap items-center gap-2">
          {busy && <span role="status" className="text-xs text-neutral-400">Saving…</span>}
          <Button variant="outline" size="sm" disabled={busy || !ready} onClick={() => { setSelected(new Set()); setSearch(""); setError(null); setImportOpen(true); }}><Plus className="h-3.5 w-3.5" />Import Skills</Button>
          <Button variant="outline" size="sm" disabled={busy || !ready} onClick={() => inputRef.current?.click()}><Upload className="h-3.5 w-3.5" />Upload &amp; Equip</Button>
          <input ref={inputRef} type="file" aria-label="Upload Skill folder" disabled={busy || !ready}
            // @ts-expect-error non-standard directory-picker attributes
            webkitdirectory="" directory="" multiple hidden
            onChange={(e) => { if (e.target.files) void uploadAndEquip(e.target.files); e.target.value = ""; }} />
        </div>
      </div>
      {error && !importOpen && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
      {equippedQuery.isLoading && <p className="text-sm text-neutral-400">Loading Skills…</p>}
      {equippedQuery.error && <div role="alert" className="text-sm text-[var(--color-danger)]">Failed to load Skills: {equippedQuery.error.message}<Button variant="ghost" disabled={equippedQuery.isFetching} onClick={() => void equippedQuery.refetch()}>Retry</Button></div>}
      {ready && !equipped.length && <div className="rounded-xl border border-dashed border-[var(--color-border)] p-8 text-center text-sm text-neutral-500">No equipped Skills yet. Import Skills from your Library or upload a Skill folder.</div>}
      <div className="agent-directory">
        {equipped.map((skill) => (
          <SkillCard key={skill.id} skill={skill} to={`/agents/${agent.id}/skills/${skill.id}`} actions={
            <Button variant="ghost" size="icon" disabled={busy} title={`Unequip ${skill.name}`} aria-label={`Unequip ${skill.name}`} onClick={() => setRemoving(skill)}><Trash2 className="h-3.5 w-3.5" /></Button>
          } />
        ))}
      </div>
      <Dialog open={importOpen} ariaLabel="Import Skills" onOpenChange={(open) => { if (!busy) setImportOpen(open); }}>
        <DialogHeader><h2 className="text-lg font-semibold">Import Skills</h2><p className="text-sm text-neutral-500">Select Library Skills to equip as independent copies for this Agent. Existing copies will be overwritten.</p></DialogHeader>
        <input aria-label="Search Skills" className="w-full rounded-lg border border-[var(--color-border)] p-2 text-sm" placeholder="Search Skills…" value={search} disabled={busy} onChange={(e) => setSearch(e.target.value)} />
        {libraryQuery.isLoading && <p className="mt-3 text-sm">Loading Library…</p>}
        {libraryQuery.error && <div role="alert">{libraryQuery.error.message}<Button variant="ghost" onClick={() => void libraryQuery.refetch()}>Retry</Button></div>}
        {!libraryQuery.isLoading && !libraryQuery.error && <>
          {!!visible.length && <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={visible.every((skill) => selected.has(skill.id))} onChange={(e) => setSelected((current) => { const next = new Set(current); for (const skill of visible) { if (e.target.checked) next.add(skill.id); else next.delete(skill.id); } return next; })} />Select all shown</label>}
          <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
            {visible.map((skill) => <label key={skill.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-border)] p-3">
              <input type="checkbox" className="mt-1" aria-label={`Select ${skill.name}`} disabled={busy} checked={selected.has(skill.id)} onChange={(e) => setSelected((current) => { const next = new Set(current); if (e.target.checked) next.add(skill.id); else next.delete(skill.id); return next; })} />
              <span className="min-w-0"><span className="block truncate text-sm font-medium">{skill.name}</span>
                {(equippedNames.has(skill.name) || equippedSources.has(skill.id)) && <span className="my-1 inline-block rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700">{equippedNames.has(skill.name) ? "Same name · will overwrite" : "Already equipped · will overwrite"}</span>}
                <span className="line-clamp-2 text-xs text-neutral-500">{skill.description}</span></span>
            </label>)}
            {!visible.length && <p className="py-4 text-sm text-neutral-500">{available.length ? "No matching Skills." : "No Library Skills available to import."} <Link to="/skills" onClick={() => setImportOpen(false)} className="underline">Open Skill Library</Link></p>}
          </div>
        </>}
        {error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">{error}</p>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setImportOpen(false)}>Cancel</Button><Button disabled={busy || !selectedIds.length || !!libraryQuery.error || !ready} onClick={() => void importSelected()}>{working ? "Importing…" : `Equip selected (${selectedIds.length})`}</Button></DialogFooter>
      </Dialog>
      <ConfirmDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }} title="Unequip Skill" description={`Delete this Agent's copy of "${removing?.name ?? ""}"? The Library Skill stays unchanged.`} confirmLabel="Unequip" onConfirm={() => {
        if (removing) unequip.mutate(removing.id, { onError: (err) => setError(err.message), onSuccess: () => setError(null) });
      }} />
    </div>
  );
}
