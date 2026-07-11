import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Dialog, DialogHeader, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useAgents } from "@/lib/hooks/use-agents";
import { useCreateSession } from "@/lib/hooks/use-sessions";

interface CreateSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preselectedAgentId?: string;
}

export function CreateSessionDialog({
  open,
  onOpenChange,
  preselectedAgentId,
}: CreateSessionDialogProps) {
  const navigate = useNavigate();
  const { data: agents, isLoading: agentsLoading } = useAgents();
  const createSession = useCreateSession();

  const [selectedAgentId, setSelectedAgentId] = useState(
    preselectedAgentId ?? ""
  );

  useEffect(() => {
    if (preselectedAgentId) {
      setSelectedAgentId(preselectedAgentId);
    }
  }, [preselectedAgentId]);

  useEffect(() => {
    if (open && !preselectedAgentId) {
      if (agents && agents.length === 1) {
        setSelectedAgentId(agents[0].id);
      } else {
        setSelectedAgentId("");
      }
    }
  }, [open, preselectedAgentId, agents]);

  function handleCreate() {
    if (!selectedAgentId) return;
    createSession.mutate(selectedAgentId, {
      onSuccess: (session) => {
        toast.success("Session created");
        onOpenChange(false);
        navigate(`/sessions/${session.id}`, {
          state: { agentId: session.agentId },
        });
      },
      onError: (err) => {
        toast.error(err.message || "Failed to create session");
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <h2 className="text-lg font-semibold">New Session</h2>
        <p className="text-sm text-neutral-500">
          Create a new session with an agent.
        </p>
      </DialogHeader>

      {preselectedAgentId || (agents && agents.length === 1) ? (
        <div className="space-y-1.5">
          <span className="text-sm font-medium text-neutral-700">Agent</span>
          <p className="text-sm text-neutral-900">
            {agents?.find((a) => a.id === selectedAgentId)?.name ?? "Loading..."}
          </p>
        </div>
      ) : (
        <Select
          id="agent-select"
          label="Agent"
          value={selectedAgentId}
          onChange={(e) => setSelectedAgentId(e.target.value)}
          disabled={agentsLoading}
        >
          <option value="" disabled>
            {agentsLoading ? "Loading agents..." : "Select an agent"}
          </option>
          {agents?.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </Select>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          onClick={handleCreate}
          disabled={!selectedAgentId || createSession.isPending}
        >
          {createSession.isPending ? "Creating..." : "Create Session"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
