/** Pi remains the managed runtime; its configured models are selectable. */
export const LOCKED_RUNTIME = "pi-agent";

/** Provider/model ids mirror deploy/pi-models.json and the local Pi config. */
export const PI_MODELS = [
  { value: "kimi-coding-plan/k3", label: "K3" },
  { value: "openai-codex/gpt-6-astra", label: "GPT-6 Astra" },
  { value: "openai-codex/gpt-5.6-sol", label: "GPT-5.6 Sol" },
] as const;

export const DEFAULT_MODEL = "openai-codex/gpt-5.6-sol";
