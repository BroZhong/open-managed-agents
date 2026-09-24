import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import {
  createModels,
  InMemoryCredentialStore,
  type Model,
  type Api,
} from "@earendil-works/pi-ai";
import {
  createCustomProvider,
  type CustomProviderDefinition,
  type CustomModelDefinition,
} from "./custom-provider.js";

export class ModelDiscoveryError extends Error {}
const invalidResponse = () =>
  new ModelDiscoveryError("The endpoint did not return a valid model list.");
const MAX_MODELS = 2000;
const MAX_PAGES = 20;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Model-list payloads are bounded before the SDK parses untrusted JSON. */
function boundedFetch(requestFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await requestFetch(input, init);
    const reader = response.body?.getReader();
    if (!reader) throw invalidResponse();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES)
          throw new ModelDiscoveryError(
            "The endpoint returned a model list that is too large.",
          );
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = Buffer.concat(chunks);
    if (response.ok) {
      let body: { data?: unknown; has_more?: unknown };
      try {
        body = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw invalidResponse();
      }
      if (
        !body ||
        !Array.isArray(body.data) ||
        (body.has_more !== undefined && typeof body.has_more !== "boolean") ||
        (body.has_more === true && body.data.length === 0)
      )
        throw invalidResponse();
    }
    return new Response(bytes, {
      status: response.status,
      headers: response.headers,
    });
  };
}
function modelDefinition(raw: unknown): CustomModelDefinition {
  if (!raw || typeof raw !== "object") throw invalidResponse();
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim() || item.id.length > 200)
    throw invalidResponse();
  const integer = (
    value: unknown,
    fallback: number,
    min: number,
    max: number,
  ) =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
      ? value
      : fallback;
  const contextWindow = integer(
    item.context_window ?? item.max_input_tokens,
    32768,
    1024,
    10_000_000,
  );
  const maxTokens = Math.min(
    contextWindow,
    integer(item.max_tokens ?? item.max_output_tokens, 4096, 128, 1_000_000),
  );
  const name = item.display_name ?? item.name;
  const capabilities = item.capabilities as
    | {
        thinking?: { supported?: boolean };
        image_input?: { supported?: boolean };
      }
    | undefined;
  return {
    id: item.id.trim(),
    name:
      typeof name === "string" && name.trim()
        ? name.trim().slice(0, 200)
        : item.id.trim(),
    contextWindow,
    maxTokens,
    reasoning:
      item.reasoning === true || capabilities?.thinking?.supported === true,
    input:
      capabilities?.image_input?.supported === true ||
      (Array.isArray(item.input) && item.input.includes("image"))
        ? ["text", "image"]
        : ["text"],
  };
}

/** Pi manages discovery/credentials/catalog state; vendor SDKs own list requests
 * and pagination. Only IDs returned by this endpoint enter the resulting list. */
export async function discoverCustomProviderModels(
  definition: CustomProviderDefinition,
  requestFetch: typeof fetch,
): Promise<CustomModelDefinition[]> {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(definition.id, async () => ({
    type: "api_key",
    key: definition.apiKey,
  }));
  const models = createModels({ credentials });
  models.setProvider(
    createCustomProvider(
      { ...definition, models: [] },
      requestFetch,
      async ({ credential, signal }) => {
        if (
          credential?.type !== "api_key" ||
          typeof credential.key !== "string"
        )
          throw new ModelDiscoveryError(
            "An API key is required to fetch models.",
          );
        const config = {
          apiKey: credential.key,
          baseURL: definition.baseUrl,
          fetch: boundedFetch(requestFetch),
          maxRetries: 0,
          timeout: 20_000,
        };
        const firstPage =
          definition.api === "anthropic-messages"
            ? await new Anthropic(config).models.list(
                { limit: 100 },
                { signal },
              )
            : await new OpenAI(config).models.list({ signal });
        const discovered = new Map<string, Model<Api>>();
        let pageCount = 0;
        let itemCount = 0;
        for await (const page of firstPage.iterPages()) {
          if (++pageCount > MAX_PAGES)
            throw new ModelDiscoveryError(
              "The endpoint returned too many model pages.",
            );
          if (!Array.isArray(page.data)) throw invalidResponse();
          for (const raw of page.data) {
            if (++itemCount > MAX_MODELS)
              throw new ModelDiscoveryError(
                "The endpoint returned too many models. Use a smaller provider catalog.",
              );
            const model = modelDefinition(raw);
            discovered.set(model.id, {
              ...model,
              api: definition.api,
              provider: definition.id,
              baseUrl: definition.baseUrl,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            });
          }
        }
        return [...discovered.values()];
      },
    ),
  );
  const result = await models.refresh({
    allowNetwork: true,
    force: true,
    signal: AbortSignal.timeout(30_000),
  });
  const error = result.errors.get(definition.id);
  if (error || result.aborted) {
    if (error instanceof ModelDiscoveryError) throw error;
    const status = (error as { status?: number } | undefined)?.status;
    const message = result.aborted
      ? "Fetching models timed out. Try again."
      : status === 401 || status === 403
        ? "The endpoint rejected this API key. Check the key and model-list permissions."
        : status === 404
          ? "This endpoint does not expose a model-list API. Check the Base URL or enter a model ID manually."
          : status === 429
            ? "The endpoint rate-limited the model list. Try again later."
            : "Could not fetch models from this endpoint. Check the Base URL, protocol and API key.";
    // Never expose upstream bodies or SDK request details, which may echo keys.
    throw new ModelDiscoveryError(message, { cause: error });
  }
  return models.getModels(definition.id).map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: model.input,
  }));
}
