import { describe, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { HTTPException } from "hono/http-exception";
import { ModelProviderService } from "../src/lib/model-providers.js";

const { dnsLookup } = vi.hoisted(() => ({ dnsLookup: vi.fn() }));
vi.mock("node:dns", () => ({ lookup: dnsLookup }));

describe("provider discovery DNS diagnostics", () => {
  it.each([
    ["198.18.0.16", "Fake-IP"],
    ["198.19.255.254", "Fake-IP"],
    ["10.0.0.1", "non-public address"],
  ])(
    "preserves a safe diagnostic through fetch, SDK and Pi for %s",
    async (address, diagnostic) => {
      dnsLookup.mockImplementation((_hostname, _options, callback) =>
        callback(null, [{ address, family: 4 }]),
      );
      const stores = createMemoryStores();
      const service = new ModelProviderService(
        stores.modelProviderStore,
        "ab".repeat(32),
      );
      const result = await service
        .discover("tenant", {
          api: "openai-completions",
          baseUrl: "https://provider.example/v1",
          apiKey: "secret-must-not-appear-in-errors",
        })
        .catch((error) => error);
      expect(result).toBeInstanceOf(HTTPException);
      expect(result.status).toBe(422);
      const body = await result.getResponse().json();
      expect(body.error).toContain(diagnostic);
      expect(body.error).toContain("before API-key authentication");
      expect(body.error).not.toContain("secret-must-not-appear-in-errors");
      expect(dnsLookup).toHaveBeenCalled();
    },
  );
});
