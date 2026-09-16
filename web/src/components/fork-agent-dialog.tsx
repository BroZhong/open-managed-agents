import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useForkAgent, type Agent } from "@/lib/hooks/use-agents";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader, DialogFooter } from "@/components/ui/dialog";

export function ForkAgentDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [name, setName] = useState(`${agent.name} (fork)`);
  const fork = useForkAgent();
  const navigate = useNavigate();
  return (
    <Dialog open ariaLabel="Fork Agent" onOpenChange={(open) => { if (!open && !fork.isPending) onClose(); }}>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim() || fork.isPending) return;
        fork.mutate({ id: agent.id, name: name.trim() }, { onSuccess: (copy) => { toast.success("Agent forked"); onClose(); navigate(`/agents/${copy.id}`); } });
      }}>
        <DialogHeader><h2 className="text-lg font-semibold">Fork Agent</h2><p className="text-sm text-neutral-500">Copy this Agent's configuration, custom instructions and current Skills. Each Skill will be an independent copy.</p></DialogHeader>
        <label className="block text-sm">Name<input autoFocus className="mt-2 w-full rounded-lg border border-[var(--color-border)] p-2" value={name} required disabled={fork.isPending} onChange={(event) => setName(event.target.value)} /></label>
        {fork.error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">{fork.error.message}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={fork.isPending} onClick={onClose}>Cancel</Button><Button type="submit" disabled={!name.trim() || fork.isPending}>{fork.isPending ? "Forking…" : "Fork Agent"}</Button></DialogFooter>
      </form>
    </Dialog>
  );
}
