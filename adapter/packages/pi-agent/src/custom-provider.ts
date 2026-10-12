import {
  createModels,
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
  type Model,
  type Api,
  type ProviderStreams,
  type RefreshModelsContext,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveCustomModel } from "./custom-capabilities.js";
import { safeCustomProviderStream } from "./custom-provider-errors.js";

import { type CustomProviderProtocol } from "./custom-provider-protocols.js";
export {
  CUSTOM_PROVIDER_PROTOCOLS,
  type CustomProviderProtocol,
} from "./custom-provider-protocols.js";
export interface CustomModelDefinition {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning?: boolean;
  reasoningSource?: "upstream" | "default" | "legacy";
  capabilityVersion?: 1;
  capabilityReference?: { provider: string; modelId: string };
  /** Explicit native Anthropic Adaptive effort mapping, including xhigh/max. */
  thinkingProfile?: "anthropic-adaptive";
  thinkingMode?: "app" | "provider";
  input: ("text" | "image")[];
  /** Optional reference to Pi's metadata, including provider compatibility flags. */
  catalogProvider?: string;
}
export interface CustomProviderDefinition {
  id: string;
  name: string;
  api: CustomProviderProtocol;
  baseUrl: string;
  apiKey: string;
  models: CustomModelDefinition[];
}

export function createCustomProvider(
  definition: CustomProviderDefinition,
  requestFetch: typeof fetch,
  fetchModels?: (
    context: RefreshModelsContext,
  ) => Promise<readonly Model<Api>[]>,
) {
  const factories = {
    "openai-completions": openAICompletionsApi,
    "openai-responses": openAIResponsesApi,
    "anthropic-messages": anthropicMessagesApi,
  };
  const native = factories[definition.api]();
  // Only inject Host transport policy. Pi owns serialization, auth headers,
  // tool calls, streaming and error interpretation for both probes and Turns.
  const api: ProviderStreams = {
    stream: (model, context, options) =>
      safeCustomProviderStream(requestFetch, fetch => native.stream(model, context, { ...options, fetch })),
    streamSimple: (model, context, options) =>
      safeCustomProviderStream(requestFetch, fetch => native.streamSimple(model, context, { ...options, fetch })),
  };
  const models = definition.models.map(model => resolveCustomModel(definition, model).model);
  return createProvider({
    id: definition.id,
    name: definition.name,
    baseUrl: definition.baseUrl,
    auth: { apiKey: envApiKeyAuth("API key", []) },
    models,
    api,
    fetchModels,
  });
}

export async function registerCustomProvider(
  runtime: ModelRuntime,
  definition: CustomProviderDefinition,
  requestFetch: typeof fetch,
) {
  runtime.registerNativeProvider(
    createCustomProvider(definition, requestFetch),
  );
  // Runtime credentials are literal strings, never models.json shell commands
  // or environment references, and never written to the Host auth.json.
  await runtime.setRuntimeApiKey(definition.id, definition.apiKey, {
    allowNetwork: false,
  });
}

export async function testCustomProvider(
  definition: CustomProviderDefinition,
  requestFetch: typeof fetch,
) {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(definition.id, async () => ({
    type: "api_key",
    key: definition.apiKey,
  }));
  const models = createModels({ credentials });
  models.setProvider(createCustomProvider(definition, requestFetch));
  for (const model of models.getModels(definition.id)) {
    const reply = await models.completeSimple(
      model,
      {
        messages: [
          { role: "user", content: "Reply with OK.", timestamp: Date.now() },
        ],
      },
      { maxTokens: 128, reasoning: getSupportedThinkingLevels(model).filter(level => level !== "off").at(-1), signal: AbortSignal.timeout(30_000) },
    );
    if (
      reply.stopReason === "error" ||
      reply.stopReason === "aborted" ||
      !reply.content.length
    ) {
      // Upstream errors can echo credentials or requests. Never persist or
      // return the raw error message from a user-controlled endpoint.
      throw new Error(
        reply.errorMessage ?? `Model ${model.id} did not complete a test request. Check the protocol, URL, API key and model access.`,
      );
    }
  }
}
