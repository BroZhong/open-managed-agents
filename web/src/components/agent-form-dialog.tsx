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

const RUNTIME_MODELS: Record<string, { label: string; value: string }[]> = {
  "claude-code": [
    { label: "Default", value: "default" },
    { label: "Claude Opus 4.7 (1M)", value: "global.anthropic.claude-opus-4-7" },
    { label: "Claude Opus 4.6 (1M)", value: "global.anthropic.claude-opus-4-6-v1[1m]" },
    { label: "Claude Opus 4.6", value: "global.anthropic.claude-opus-4-6-v1" },
    { label: "Claude Sonnet 4.6 (1M)", value: "global.anthropic.claude-sonnet-4-6" },
    { label: "Claude Sonnet 4.5", value: "global.anthropic.claude-sonnet-4-5-20250929-v1:0" },
    { label: "Claude Opus 4.5", value: "global.anthropic.claude-opus-4-5-20251101-v1:0" },
    { label: "Claude Haiku 4.5", value: "global.anthropic.claude-haiku-4-5-20251001-v1:0" },
  ],
  codex: [
    { label: "Default", value: "default" },
    { label: "GPT 5.5", value: "gpt-5.5" },
    { label: "GPT 5.4", value: "gpt-5.4" },
    { label: "GPT 5.4 Mini", value: "gpt-5.4-mini" },
    { label: "GPT 5.3 Codex", value: "gpt-5.3-codex" },
    { label: "GPT 5.2", value: "gpt-5.2" },
    { label: "o3", value: "o3" },
  ],
  "pi-agent": [
    { label: "Default", value: "default" },
    { label: "Gemini 2.5 Pro", value: "google/gemini-2.5-pro" },
    { label: "Gemini 2.5 Flash", value: "google/gemini-2.5-flash" },
    { label: "Gemini 3 Pro Preview", value: "google/gemini-3-pro-preview" },
    { label: "Gemini 3 Flash Preview", value: "google/gemini-3-flash-preview" },
    { label: "Claude Sonnet 4.6 (Bedrock)", value: "amazon-bedrock/anthropic.claude-sonnet-4-6" },
    { label: "Claude Opus 4.7 (Bedrock)", value: "amazon-bedrock/anthropic.claude-opus-4-7" },
    { label: "GPT 5.4 (Codex)", value: "openai-codex/gpt-5.4" },
  ],
};

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
  const [model, setModel] = useState("");
  const [system, setSystem] = useState("");
  const [runtime, setRuntime] = useState("claude-code");

  const createMutation = useCreateAgent();
  const updateMutation = useUpdateAgent();

  useEffect(() => {
    if (open) {
      if (agent) {
        setName(agent.name);
        setModel(agent.model);
        setSystem(agent.system);
        setRuntime(agent.runtime);
      } else {
        setName("");
        setModel("");
        setSystem("");
        setRuntime("claude-code");
      }
    }
  }, [open, agent]);

  function handleRuntimeChange(newRuntime: string) {
    setRuntime(newRuntime);
    const models = RUNTIME_MODELS[newRuntime];
    if (models && models.length > 0) {
      setModel(models[0].value);
    } else {
      setModel("");
    }
  }

  useEffect(() => {
    if (open && !isEdit && !model) {
      const models = RUNTIME_MODELS[runtime];
      if (models && models.length > 0) {
        setModel(models[0].value);
      }
    }
  }, [open, isEdit, runtime, model]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!name.trim() || !model.trim()) {
      toast.error("Please fill in all required fields");
      return;
    }

    const defaultSystem = "You are a helpful coding assistant. Help the user with their tasks.";
    const body = {
      name: name.trim(),
      model: model.trim(),
      system: system.trim() || defaultSystem,
      runtime,
      // Sandbox is mandatory (issue #54): every Agent runs inside a sandbox.
      // There is no opt-out in the UI; always send enabled: true.
      sandbox: {
        enabled: true,
        image: "open-managed-agents/sandbox:latest",
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
  const availableModels = RUNTIME_MODELS[runtime] ?? [];

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
          <Select
            id="agent-runtime"
            label="Runtime"
            value={runtime}
            onChange={(e) => handleRuntimeChange(e.target.value)}
          >
            <option value="claude-code">claude-code</option>
            <option value="codex">codex</option>
            <option value="pi-agent">pi-agent</option>
          </Select>
          <Select
            id="agent-model"
            label="Model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {availableModels.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
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
