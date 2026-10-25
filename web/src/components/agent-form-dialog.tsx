import { useModelProviders } from "@/lib/hooks/use-model-providers";
import { useEnvironments, type EnvironmentSummary } from "@/lib/hooks/use-environments";
import { useModelThinkingOptions, type ThinkingLevel } from "@/lib/hooks/use-thinking-options";
import { AgentThinkingPicker } from "@/components/agent-thinking-picker";
import { useState } from "react";
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

const ENVIRONMENT_STATUS: Record<EnvironmentSummary["status"], string> = {
  pending: "待构建", building: "构建中", failed: "构建失败", ready: "就绪",
};
/** The built-in a Sandboxed Agent runs in unless it names another (ADR-0024). */
export const DEFAULT_ENVIRONMENT_ID = "env_video_production";

/**
 * The Environments an Agent can be bound to (ADR-0024): the ready ones,
 * built-ins first, and, whatever their status, the Agent's own binding,
 * which an edit keeps, and the default, which the Host binds as it is.
 */
function environmentChoices(environments: EnvironmentSummary[], current?: string) {
  const rank = (environment: EnvironmentSummary) => (environment.ownerType === "platform" ? 0 : 1);
  const label = (environment: EnvironmentSummary) => environment.ownerType === "platform" ? `${environment.name} · 平台内置` : environment.name;
  const choices = environments.filter((environment) => environment.status === "ready")
    .sort((a, b) => rank(a) - rank(b))
    .map((environment) => ({ value: environment.id, label: label(environment) }));
  for (const kept of new Set([current ?? DEFAULT_ENVIRONMENT_ID, DEFAULT_ENVIRONMENT_ID])) {
    if (choices.some((choice) => choice.value === kept)) continue;
    const listed = environments.find((environment) => environment.id === kept);
    if (!listed && kept === DEFAULT_ENVIRONMENT_ID && kept !== current) continue;
    const role = kept === current ? "current" : "default";
    choices.push({ value: kept, label: `${listed ? label(listed) : kept} (${role}${listed ? `, ${ENVIRONMENT_STATUS[listed.status]}` : ""})` });
  }
  return choices;
}

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
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [system, setSystem] = useState(agent?.system ?? "");
  const [model, setModel] = useState<string>(agent?.model ?? DEFAULT_MODEL);
  const [thinking, setThinking] = useState<ThinkingLevel | undefined>(agent?.thinking ?? undefined);
  const [environmentId, setEnvironmentId] = useState(agent?.environmentId ?? DEFAULT_ENVIRONMENT_ID);
  const environments = useEnvironments(open);
  const environmentOptions = environmentChoices(environments.data ?? [], agent?.environmentId);
  const [lastInput, setLastInput] = useState({ open, agent });
  const thinkingOptions = useModelThinkingOptions(model, open);
  const runtime = LOCKED_RUNTIME;

  const createMutation = useCreateAgent();
  const updateMutation = useUpdateAgent();

  if (lastInput.open !== open || lastInput.agent !== agent) {
    setLastInput({ open, agent });
    if (open) {
      if (agent) {
        setName(agent.name);
        setDescription(agent.description ?? "");
        setSystem(agent.system);
        setModel(agent.model);
        setThinking(agent.thinking ?? undefined);
        setEnvironmentId(agent.environmentId ?? DEFAULT_ENVIRONMENT_ID);
      } else {
        setName("");
        setDescription("");
        setSystem("");
        setModel(DEFAULT_MODEL);
        setThinking(undefined);
        setEnvironmentId(DEFAULT_ENVIRONMENT_ID);
      }
    }
  }

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
      // Sandbox is mandatory (issue #54): every Agent runs inside a sandbox,
      // whose image and variables its Environment provides (ADR-0024).
      sandbox: { enabled: true },
      // An Agent without an Environment sends none for the default, which
      // the Host binds whatever it is building.
      ...(environmentId === DEFAULT_ENVIRONMENT_ID && !agent?.environmentId ? {} : { environmentId }),
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
          <AgentThinkingPicker value={thinking} onChange={setThinking} options={thinkingOptions.isError ? undefined : thinkingOptions.data}
            loading={thinkingOptions.isFetching} error={thinkingOptions.error?.message} onRetry={() => void thinkingOptions.refetch()} />
          <p className="text-xs text-neutral-500">{providers.error ? "Custom models could not be loaded. " : ""}<a href="/model-providers" className="underline">Manage model providers</a></p>
          <Textarea
            id="agent-system"
            label="System Prompt"
            placeholder="You are a helpful assistant..."
            value={system}
            onChange={(e) => setSystem(e.target.value)}
          />
          <Select
            id="agent-environment"
            label="Environment"
            value={environmentId}
            onChange={(e) => setEnvironmentId(e.target.value)}
          >
            {environmentOptions.map((choice) => (
              <option key={choice.value} value={choice.value}>{choice.label}</option>
            ))}
          </Select>
          <p className="text-xs text-neutral-500">
            Every agent runs inside an isolated sandbox. New Sessions run in the chosen Environment; existing Sessions keep theirs.
            {environments.error ? " Environments could not be loaded." : ""}
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
