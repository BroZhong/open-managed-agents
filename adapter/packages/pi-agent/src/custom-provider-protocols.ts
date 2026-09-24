export const CUSTOM_PROVIDER_PROTOCOLS = [
  { id: "openai-completions", name: "OpenAI Chat Completions" },
  { id: "openai-responses", name: "OpenAI Responses" },
  { id: "anthropic-messages", name: "Anthropic Messages" },
] as const;
export type CustomProviderProtocol =
  (typeof CUSTOM_PROVIDER_PROTOCOLS)[number]["id"];
