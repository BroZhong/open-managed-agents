/** Pi remains the managed runtime; its configured models are selectable. */
export const LOCKED_RUNTIME = "pi-agent";

/** Provider/model ids mirror the Host catalog in deploy/pi-models.json. */
export const PI_MODELS = [
  { value: "kimi-coding-plan/k3", label: "K3" },
  { value: "bigmodel/glm-5.3", label: "GLM-5.3" },
  { value: "deepseek/deepseek-flash", label: "DeepSeek V4.1 Flash" },
  { value: "openai-codex/gpt-6-astra", label: "GPT-6 Astra" },
  { value: "openai-codex/gpt-5.6-sol", label: "GPT-5.6 Sol" },
] as const;

export const DEFAULT_MODEL = "openai-codex/gpt-5.6-sol";
