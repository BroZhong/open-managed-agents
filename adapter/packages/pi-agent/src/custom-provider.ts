import {
  createModels,
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
  type Model,
  type Api,
  type ProviderStreams,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import {
  getBuiltinProviders,
  getBuiltinModels,
} from "@earendil-works/pi-ai/providers/all";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { type CustomProviderProtocol } from "./custom-provider-protocols.js";
export { CUSTOM_PROVIDER_PROTOCOLS, type CustomProviderProtocol } from "./custom-provider-protocols.js";
export interface CustomModelDefinition {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
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
      native.stream(model, context, { ...options, fetch: requestFetch }),
    streamSimple: (model, context, options) =>
      native.streamSimple(model, context, { ...options, fetch: requestFetch }),
  };
  const models: Model<Api>[] = definition.models.map(
    ({ catalogProvider, ...model }) => {
      const catalog =
        catalogProvider &&
        getBuiltinProviders().includes(catalogProvider as never)
          ? getBuiltinModels(catalogProvider as never).find(
              (item) => item.id === model.id && item.api === definition.api,
            )
          : undefined;
      return {
        ...model,
        api: definition.api,
        provider: definition.id,
        baseUrl: definition.baseUrl,
        cost: catalog?.cost ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        ...(catalog?.compat ? { compat: catalog.compat } : {}),
        ...(catalog?.thinkingLevelMap
          ? { thinkingLevelMap: catalog.thinkingLevelMap }
          : {}),
      };
    },
  );
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
      { maxTokens: 128, signal: AbortSignal.timeout(30_000) },
    );
    if (
      reply.stopReason === "error" ||
      reply.stopReason === "aborted" ||
      !reply.content.length
    ) {
      // Upstream errors can echo credentials or requests. Never persist or
      // return the raw error message from a user-controlled endpoint.
      throw new Error(
        `Model ${model.id} did not complete a test request. Check the protocol, URL, API key and model access.`,
      );
    }
  }
}
