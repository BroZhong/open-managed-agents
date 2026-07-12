import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Dialog, DialogHeader, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import {
  useCreateAgent,
  useUpdateAgent,
  type Agent,
} from "@/lib/hooks/use-agents";
import {
  LOCKED_RUNTIME,
  LOCKED_MODEL,
  LOCKED_MODEL_LABEL,
} from "@/lib/agent-runtime";

interface AgentFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent?: Agent;
  onSuccess?: () => void;
}

export function AgentFormDialog({
  open,
  onOpenChange,
  agent,
  onSuccess,
}: AgentFormDialogProps) {
  const isEdit = !!agent;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [system, setSystem] = useState("");

  // Runtime and model are locked for the current deployment (issue #69):
  // only the pi-agent runtime and a single model are supported, so they are
  // fixed constants rather than form state — for both new and existing Agents.
  // An Agent created with a different runtime/model is displayed and re-saved
  // as the locked values, so the form never renders an option that no longer
  // exists (which would break the disabled select).
  const runtime = LOCKED_RUNTIME;
  const model = LOCKED_MODEL;

  const createMutation = useCreateAgent();
  const updateMutation = useUpdateAgent();

  useEffect(() => {
    if (open) {
      if (agent) {
        setName(agent.name);
        setDescription(agent.description ?? "");
        setSystem(agent.system);
      } else {
        setName("");
        setDescription("");
        setSystem("");
      }
    }
  }, [open, agent]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!name.trim()) {
      toast.error("Please fill in all required fields");
      return;
    }

    const defaultSystem = "You are a helpful coding assistant. Help the user with their tasks.";
    const body = {
      name: name.trim(),
      // Human-readable, informational only — sent as "" to clear rather than
      // omitted, so editing can remove a previously-set description.
      description: description.trim(),
      model,
      system: system.trim() || defaultSystem,
      runtime,
      // Sandbox is mandatory (issue #54): every Agent runs inside a sandbox.
      // There is no opt-out in the UI; always send enabled: true. We do NOT
      // send an `image`: for the E2B backend `image` is the sandbox template
      // ID, and omitting it lets the Host default to SANDBOX_TEMPLATE
      // (`code-interpreter`, the SandboxSet from #52). Sending a container-image
      // string here would be used as a non-existent template → create 400s.
      sandbox: {
        // Editing must preserve deployment-specific image/env settings (for
        // example sandbox VFS settings) that this form does not expose.
        ...agent?.sandbox,
        enabled: true,
      },
    };

    if (isEdit) {
      updateMutation.mutate(
        { id: agent.id, ...body },
        {
          onSuccess: () => {
            toast.success("Agent updated");
            onOpenChange(false);
            onSuccess?.();
          },
          onError: (err) => {
            toast.error(err.message || "Failed to update agent");
          },
        }
      );
    } else {
      createMutation.mutate(body, {
        onSuccess: () => {
          toast.success("Agent created");
          onOpenChange(false);
          onSuccess?.();
        },
        onError: (err) => {
          toast.error(err.message || "Failed to create agent");
        },
      });
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <form onSubmit={handleSubmit}>
        <DialogHeader>
          <h2 className="text-lg font-semibold text-neutral-900">
            {isEdit ? "Edit Agent" : "Create Agent"}
          </h2>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="agent-name"
              className="text-sm font-medium text-neutral-700"
            >
              Name
            </label>
            <Input
              id="agent-name"
              placeholder="My Agent"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="agent-description"
              className="text-sm font-medium text-neutral-700"
            >
              Description
            </label>
            <Input
              id="agent-description"
              placeholder="What this agent is for (shown in the console, not sent to the model)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {/*
            Runtime and model are locked to the only combination the current
            deployment supports (issue #69). They render as disabled selects so
            the form shows what will be saved without offering other choices.
          */}
          <Select
            id="agent-runtime"
            label="Runtime"
            value={runtime}
            onChange={() => {}}
            disabled
          >
            <option value={LOCKED_RUNTIME}>{LOCKED_RUNTIME}</option>
          </Select>
          <Select
            id="agent-model"
            label="Model"
            value={model}
            onChange={() => {}}
            disabled
          >
            <option value={LOCKED_MODEL}>{LOCKED_MODEL_LABEL}</option>
          </Select>
          <Textarea
            id="agent-system"
            label="System Prompt"
            placeholder="You are a helpful assistant..."
            value={system}
            onChange={(e) => setSystem(e.target.value)}
          />
          <p className="text-xs text-neutral-500">
            Every agent runs inside an isolated sandbox.
          </p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending
              ? isEdit
                ? "Saving..."
                : "Creating..."
              : isEdit
                ? "Save Changes"
                : "Create Agent"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
