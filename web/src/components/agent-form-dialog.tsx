import { useModelProviders } from "@/lib/hooks/use-model-providers";
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

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LABELS = ["关闭", "极低", "低", "中", "高", "很高", "最大"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];

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
  const providers = useModelProviders(open);
  const choices = [...PI_MODELS, ...(providers.data ?? []).flatMap(provider => provider.models.map(model => ({ value: `${provider.id}/${model.id}`, label: `${model.name} · ${provider.name}` })))];
  const isEdit = !!agent;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [system, setSystem] = useState("");
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [thinking, setThinking] = useState<ThinkingLevel | undefined>();
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
        setThinking(agent.thinking ?? undefined);
      } else {
        setName("");
        setDescription("");
        setSystem("");
        setModel(DEFAULT_MODEL);
        setThinking(undefined);
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
      thinking: thinking ?? null,
      system: system.trim() || defaultSystem,
      runtime,
      // Sandbox is mandatory (issue #54): every Agent runs inside a sandbox.
      // New Agents inherit the Host's default Sandbox template.
      sandbox: {
        // Preserve deployment-specific settings that this form does not expose.
        ...agent?.sandbox,
        enabled: true,
        // The retired auto-story choice follows the Host default when saved.
        image: agent?.sandbox?.image === "auto-story" ? undefined : agent?.sandbox?.image,
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
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>{choice.label}</option>
            ))}
            {agent && !choices.some((choice) => choice.value === agent.model) && (
              <option value={agent.model}>{`${agent.model} (current)`}</option>
            )}
          </Select>
          <div className="space-y-2 rounded-xl border border-neutral-200 bg-neutral-50/70 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="agent-thinking" className="text-sm font-medium text-neutral-700">思考强度</label>
              <span className="text-xs font-medium text-neutral-500">
                {thinking ? THINKING_LABELS[THINKING_LEVELS.indexOf(thinking)] : "自动 · 模型最高"}
              </span>
            </div>
            <div className="relative px-1 pt-1">
              <input
                id="agent-thinking"
                type="range"
                min={0}
                max={THINKING_LEVELS.length - 1}
                step={1}
                value={thinking ? THINKING_LEVELS.indexOf(thinking) : THINKING_LEVELS.length - 1}
                aria-label="思考强度"
                aria-valuetext={thinking ? THINKING_LABELS[THINKING_LEVELS.indexOf(thinking)] : "自动 · 模型最高"}
                onChange={(e) => setThinking(THINKING_LEVELS[Number(e.target.value)])}
                style={{ background: `linear-gradient(to right, var(--color-accent) ${(thinking ? THINKING_LEVELS.indexOf(thinking) : THINKING_LEVELS.length - 1) / (THINKING_LEVELS.length - 1) * 100}%, var(--color-bg-active) ${(thinking ? THINKING_LEVELS.indexOf(thinking) : THINKING_LEVELS.length - 1) / (THINKING_LEVELS.length - 1) * 100}%)` }}
                className="thinking-slider w-full"
              />
              <div className="mt-1 flex justify-between px-0.5 text-[10px] text-neutral-400" aria-hidden="true">
                {THINKING_LABELS.map((label) => <span key={label}>{label}</span>)}
              </div>
            </div>
            <button type="button" onClick={() => setThinking(undefined)} className="text-xs text-neutral-500 underline" aria-label="重置思考强度">恢复自动</button>
            <p className="text-xs leading-5 text-neutral-500">按模型支持的等级自动适配；不支持思考的模型保持关闭。强度越高，通常耗时越长。</p>
          </div>
          <p className="text-xs text-neutral-500">{providers.error ? "Custom models could not be loaded. " : ""}<a href="/model-providers" className="underline">Manage model providers</a></p>
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
