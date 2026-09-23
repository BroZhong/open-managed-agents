import { describe, expect, it, vi } from "vitest";
import {
  discoverCustomProviderModels,
  ModelDiscoveryError,
} from "../src/provider-discovery.js";
import type { CustomProviderDefinition } from "../src/custom-provider.js";
const definition: CustomProviderDefinition = {
  id: "custom-probe",
  name: "Discovery",
  api: "openai-completions",
  baseUrl: "https://gateway.example.com/v1",
  apiKey: "!literal-secret",
  models: [],
};
describe("endpoint discovery through Pi refresh and vendor SDKs", () => {
  it.each(["openai-completions", "openai-responses"] as const)(
    "fetches only endpoint-returned models for %s",
    async (api) => {
      const request = vi.fn<typeof fetch>(async (url, init) => {
        expect(String(url)).toBe("https://gateway.example.com/v1/models");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer !literal-secret",
        );
        return Response.json({
          object: "list",
          data: [
            {
              id: "vendor/custom-only",
              name: "Private model",
              context_window: 65536,
              max_tokens: 8192,
              input: ["text", "image"],
            },
            { id: "vendor/custom-only" },
            { id: "another-private-id" },
          ],
        });
      });
      const result = await discoverCustomProviderModels(
        { ...definition, api },
        request,
      );
      expect(result.map((model) => model.id)).toEqual([
        "vendor/custom-only",
        "another-private-id",
      ]);
      expect(request).toHaveBeenCalledOnce();
    },
  );
  it("preserves metadata returned by the endpoint and uses conservative defaults when absent", async () => {
    const result = await discoverCustomProviderModels(definition, async () =>
      Response.json({
        data: [
          {
            id: "private-id",
            display_name: "Private",
            max_input_tokens: 64000,
            max_tokens: 8000,
            capabilities: {
              thinking: { supported: true },
              image_input: { supported: true },
            },
          },
          { id: "unknown-id" },
        ],
      }),
    );
    expect(result[0]).toEqual({
      id: "private-id",
      name: "Private",
      contextWindow: 64000,
      maxTokens: 8000,
      reasoning: true,
      input: ["text", "image"],
    });
    expect(result[1]).toMatchObject({
      contextWindow: 32768,
      maxTokens: 4096,
      reasoning: false,
    });
  });
  it("uses Anthropic's models API, headers and SDK pagination", async () => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const requestUrl = new URL(String(url));
      expect(requestUrl.origin + requestUrl.pathname).toBe(
        "https://gateway.example.com/v1/models",
      );
      expect(new Headers(init?.headers).get("x-api-key")).toBe(
        "!literal-secret",
      );
      expect(new Headers(init?.headers).get("anthropic-version")).toBeTruthy();
      const lastPage = requestUrl.searchParams.get("after_id") === "model-one";
      const id = lastPage ? "model-two" : "model-one";
      return Response.json({
        data: [{ id, display_name: id }],
        has_more: !lastPage,
        first_id: id,
        last_id: id,
      });
    });
    const result = await discoverCustomProviderModels(
      {
        ...definition,
        api: "anthropic-messages",
        baseUrl: "https://gateway.example.com",
      },
      request,
    );
    expect(result.map((model) => model.id)).toEqual(["model-one", "model-two"]);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("returns an empty endpoint list without adding built-in suggestions", async () => {
    expect(
      await discoverCustomProviderModels(definition, async () =>
        Response.json({ data: [] }),
      ),
    ).toEqual([]);
  });
  it.each([
    {},
    { data: "bad" },
    { data: [null] },
    { data: [{ name: "missing-id" }] },
  ])("rejects malformed model lists", async (payload) => {
    await expect(
      discoverCustomProviderModels(definition, async () =>
        Response.json(payload),
      ),
    ).rejects.toBeInstanceOf(ModelDiscoveryError);
  });
  it.each([401, 403, 404, 429, 500])(
    "handles HTTP %s without reflecting keys or request details",
    async (status) => {
      const request = vi.fn<typeof fetch>(async () =>
        Response.json({ error: { message: "!literal-secret" } }, { status }),
      );
      const error = await discoverCustomProviderModels(
        definition,
        request,
      ).catch((error) => error as Error);
      expect(error).toBeInstanceOf(ModelDiscoveryError);
      expect((error as Error).message).not.toContain("!literal-secret");
      expect(request).toHaveBeenCalledOnce();
    },
  );
  it("bounds model count and response size", async () => {
    await expect(
      discoverCustomProviderModels(definition, async () =>
        Response.json({
          data: Array.from({ length: 2001 }, (_, i) => ({ id: `model-${i}` })),
        }),
      ),
    ).rejects.toThrow("too many models");
    await expect(
      discoverCustomProviderModels(definition, async () =>
        Response.json({ data: [], padding: "x".repeat(2 * 1024 * 1024) }),
      ),
    ).rejects.toBeInstanceOf(ModelDiscoveryError);
  });
});
