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
  DEFAULT_MODEL,
  PI_MODELS,
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
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [sandboxImage, setSandboxImage] = useState("");
  const runtime = LOCKED_RUNTIME;

  const createMutation = useCreateAgent();
  const updateMutation = useUpdateAgent();

  useEffect(() => {
    if (open) {
      if (agent) {
        setName(agent.name);
        setDescription(agent.description ?? "");
        setSystem(agent.system);
        setModel(agent.model);
        setSandboxImage(agent.sandbox?.image ?? "");
      } else {
        setName("");
        setDescription("");
        setSystem("");
        setModel(DEFAULT_MODEL);
        setSandboxImage("");
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
      // `image` is an E2B template id; an empty choice uses SANDBOX_TEMPLATE.
      sandbox: {
        // Editing must preserve deployment-specific image/env settings (for
        // example sandbox VFS settings) that this form does not expose.
        ...agent?.sandbox,
        enabled: true,
        image: sandboxImage || undefined,
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
            onChange={(e) => setModel(e.target.value)}
          >
            {PI_MODELS.map((choice) => (
              <option key={choice.value} value={choice.value}>{choice.label}</option>
            ))}
            {agent && !PI_MODELS.some((choice) => choice.value === agent.model) && (
              <option value={agent.model}>{`${agent.model} (current)`}</option>
            )}
          </Select>
          <p className="text-xs text-neutral-500">
            Thinking uses the highest level supported by the selected model.
          </p>
          <Select
            id="agent-sandbox"
            label="Sandbox"
            value={sandboxImage}
            onChange={(e) => setSandboxImage(e.target.value)}
          >
            <option value="">Server default</option>
            <option value="auto-story">auto-story</option>
            {agent?.sandbox?.image && agent.sandbox.image !== "auto-story" && (
              <option value={agent.sandbox.image}>{`${agent.sandbox.image} (current)`}</option>
            )}
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
