import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import {
  ModelProviderService,
  type ProviderInput,
} from "../src/lib/model-providers.js";
import { createApp } from "../src/app.js";
import {
  isPublicProviderAddress,
  providerBaseUrl,
  providerFetch,
  ProviderAddressError,
} from "../src/lib/provider-fetch.js";
const input: ProviderInput = {
  name: "My provider",
  api: "openai-completions",
  baseUrl: "https://example.com/v1",
  apiKey: "!secret-not-a-command",
  models: [
    {
      id: "vendor/model",
      name: "Model",
      contextWindow: 32768,
      maxTokens: 4096,
      reasoning: false,
      input: ["text"],
    },
  ],
};
function fixture() {
  const stores = createMemoryStores();
  const probe = vi.fn().mockResolvedValue(undefined);
  const discover = vi.fn().mockResolvedValue(input.models);
  const service = new ModelProviderService(
    stores.modelProviderStore,
    "ab".repeat(32),
    probe,
    discover,
  );
  return { stores, probe, discover, service };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("Tenant provider configuration", () => {
  it("saves, reloads and clears the five-level Adaptive profile with a configuration-bound proof", async () => {
    vi.stubEnv("AUTH_DISABLED", "true");
    const { stores, service } = fixture();
    const app = createApp({ ...stores, modelProviderService: service });
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const configured = { ...input, api: "anthropic-messages", models: [{ ...input.models[0], thinkingProfile: "anthropic-adaptive" }] };
    const preview = await post("/v1/model-providers/thinking-options", { api: configured.api, model: configured.models[0] });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ profile: "anthropic-adaptive", defaultLevel: "max", choices: [
      { value: "low", label: "low" }, { value: "medium", label: "medium" }, { value: "high", label: "high" }, { value: "xhigh", label: "xhigh" }, { value: "max", label: "max" },
    ] });
    const tested = await (await post("/v1/model-providers/test", configured)).json();
    const changed = { ...configured, models: input.models };
    expect((await post("/v1/model-providers", { ...changed, verificationToken: tested.verificationToken })).status).toBe(400);
    const savedResponse = await post("/v1/model-providers", { ...configured, verificationToken: tested.verificationToken });
    expect(savedResponse.status).toBe(200);
    const saved = await savedResponse.json();
    const reloaded = await (await app.request("/v1/model-providers")).json();
    expect(reloaded.data[0].models[0].thinkingProfile).toBe("anthropic-adaptive");
    expect(JSON.stringify(reloaded)).not.toContain(input.apiKey);
    const reader = new ModelProviderService(stores.modelProviderStore, undefined);
    expect(await reader.thinkingOptions("dev", `${saved.id}/${input.models[0].id}`, vi.fn())).toMatchObject({ defaultLevel: "max", resolvedLevels: { off: "low", minimal: "low", max: "max" } });
    const clear = { ...changed, id: saved.id, apiKey: "" };
    const newProof = await (await post("/v1/model-providers/test", clear)).json();
    expect((await post("/v1/model-providers", { ...clear, verificationToken: newProof.verificationToken })).status).toBe(200);
    expect((await reader.thinkingOptions("dev", `${saved.id}/${input.models[0].id}`, vi.fn())).defaultLevel).toBe("high");
    for (const api of ["openai-completions", "openai-responses"]) {
      expect((await post("/v1/model-providers/thinking-options", { api, model: configured.models[0] })).status).toBe(422);
    }
  });
  it("preserves a sanitized HTTP 200 SSE thinking rejection through the test endpoint", async () => {
    vi.stubEnv("AUTH_DISABLED", "true");
    const stores = createMemoryStores();
    const service = new ModelProviderService(stores.modelProviderStore, "ab".repeat(32));
    const app = createApp({ ...stores, modelProviderService: service });
    const request = vi.fn<typeof fetch>(async () => new Response(
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `Unsupported parameter: thinking.budget_tokens; ${input.apiKey}` } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", request);
    const response = await app.request("/v1/model-providers/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, api: "anthropic-messages" }),
    });
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain("rejected a thinking control parameter");
    expect(body).not.toContain(input.apiKey);
    expect(request).toHaveBeenCalledOnce();
  });
  it("previews unsaved capabilities and compatible references without keys, discovery or inference", async () => {
    vi.stubEnv("AUTH_DISABLED", "true");
    const { stores, probe, discover } = fixture();
    const service = new ModelProviderService(stores.modelProviderStore, undefined, probe, discover);
    const app = createApp({ apiKeyStore: stores.apiKeyStore, modelProviderService: service });
    const preview = (model: unknown) => app.request("/v1/model-providers/thinking-options", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ api: "openai-responses", model }),
    });
    const { reasoning: _legacy, ...model } = input.models[0];
    const result = await preview(model);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toMatchObject({ source: "default", defaultLevel: "high", choices: [
      { value: "off", label: "off" }, { value: "minimal", label: "minimal" },
      { value: "low", label: "low" }, { value: "medium", label: "medium" }, { value: "high", label: "high" },
    ] });
    const catalog = await app.request("/v1/model-providers/capability-references?api=openai-responses&model=vendor%2Fgpt-5.4");
    expect(catalog.status).toBe(200);
    const references = await catalog.json();
    expect(references.data).toContainEqual(expect.objectContaining({ provider: "openai", modelId: "gpt-5.4" }));
    expect(references.recommendations).toContainEqual(expect.objectContaining({ modelId: "gpt-5.4", reason: expect.any(String) }));
    expect((await preview({ ...model, capabilityReference: { provider: "no-provider", modelId: "private-key" } })).status).toBe(422);
    expect((await preview({ ...model, thinkingMode: "provider" })).status).toBe(400);
    expect(probe).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(await stores.modelProviderStore.list("dev")).toEqual([]);
  });
  it("preserves DNS rejection through the real Pi probe without exposing transport secrets", async () => {
    const stores = createMemoryStores();
    const service = new ModelProviderService(
      stores.modelProviderStore,
      "ab".repeat(32),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        new TypeError(`fetch failed ${input.apiKey}`, {
          cause: new ProviderAddressError(true),
        }),
      ),
    );
    let response: Response | undefined;
    try {
      await service.test("a", input);
    } catch (error) {
      response = (error as { res: Response }).res;
    }
    expect(response?.status).toBe(422);
    const body = await response!.text();
    expect(body).toContain("Fake-IP");
    expect(body).toContain("before API-key authentication");
    expect(body).not.toContain(input.apiKey);
  });
  it.each([
    [401, "API key"],
    [404, "protocol"],
    [429, "rate-limited"],
  ])(
    "preserves upstream HTTP %s through the real Pi probe",
    async (status, hint) => {
      const stores = createMemoryStores();
      const service = new ModelProviderService(
        stores.modelProviderStore,
        "ab".repeat(32),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            { error: { message: `reflected ${input.apiKey}` } },
            { status },
          ),
        ),
      );
      let response: Response | undefined;
      try {
        await service.test("a", input);
      } catch (error) {
        response = (error as { res: Response }).res;
      }
      expect(response?.status).toBe(422);
      const body = await response!.text();
      expect(body).toContain(`HTTP ${status}`);
      expect(body).toContain(hint);
      expect(body).not.toContain(input.apiKey);
    },
  );
  it("reports explicit thinking-parameter rejection safely without retrying or confusing authentication failures", async () => {
    const stores = createMemoryStores();
    const service = new ModelProviderService(stores.modelProviderStore, "ab".repeat(32));
    const request = vi.fn(async () => Response.json({ error: { message: `Unsupported parameter: reasoning_effort; ${input.apiKey}` } }, { status: 400 }));
    vi.stubGlobal("fetch", request);
    let response: Response | undefined;
    try { await service.test("a", input); } catch (error) { response = (error as { res: Response }).res; }
    expect(response?.status).toBe(422);
    const body = await response!.text();
    expect(body).toContain("rejected a thinking control parameter");
    expect(body).not.toContain(input.apiKey);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockImplementation(async () => Response.json({ error: { message: "Unsupported reasoning_effort" } }, { status: 401 }));
    try { await service.test("a", input); } catch (error) { response = (error as { res: Response }).res; }
    expect(await response!.text()).toContain("Check the API key");
  });
  it("persists capability provenance and binds the test proof to manual references", async () => {
    const { service, stores, probe } = fixture();
    const unknown: ProviderInput = { ...input, api: "openai-responses", models: [{ ...input.models[0], reasoning: undefined }] };
    const tested = await service.test("a", unknown);
    const saved = await service.save("a", unknown, tested.verificationToken);
    expect(saved.models[0]).toMatchObject({ reasoning: true, reasoningSource: "default", capabilityVersion: 1 });
    expect((await stores.modelProviderStore.get("a", saved.id))?.models).toEqual(saved.models);
    const reference = { provider: "openai", modelId: "gpt-5.4" };
    await expect(service.save("a", { ...unknown, models: [{ ...unknown.models[0], capabilityReference: reference }] }, tested.verificationToken)).rejects.toMatchObject({ status: 400 });
    const configured = { ...unknown, models: [{ ...unknown.models[0], capabilityReference: reference }] };
    const proof = await service.test("a", configured);
    const withReference = await service.save("a", configured, proof.verificationToken);
    expect(withReference.models[0].capabilityReference).toEqual(reference);
    expect(probe.mock.lastCall?.[0].models[0].id).toBe("vendor/model");
    const explicit = { ...unknown, models: [{ ...unknown.models[0], reasoning: false, reasoningSource: "upstream" as const }] };
    const explicitProof = await service.test("a", explicit);
    expect((await service.save("a", explicit, explicitProof.verificationToken)).models[0]).toMatchObject({ reasoning: false, reasoningSource: "upstream", capabilityVersion: 1 });
  });
  it("requires a successful test of the exact configuration and encrypts stored credentials", async () => {
    const { service, stores } = fixture();
    const proof = await service.test("a", input);
    await expect(
      service.save(
        "a",
        { ...input, baseUrl: "https://different.example.com" },
        proof.verificationToken,
      ),
    ).rejects.toThrow();
    const saved = await service.save("a", input, proof.verificationToken);
    expect(saved).toMatchObject({ name: input.name, hasApiKey: true });
    expect(JSON.stringify(saved)).not.toContain(input.apiKey);
    const stored = await stores.modelProviderStore.get("a", saved.id);
    expect(stored?.encryptedApiKey).not.toContain(input.apiKey);
    expect(await stores.modelProviderStore.get("b", saved.id)).toBeNull();
    expect(await stores.modelProviderStore.delete("b", saved.id)).toBe(false);
    expect(await stores.modelProviderStore.list("b")).toEqual([]);
    await expect(
      service.save("b", input, proof.verificationToken),
    ).rejects.toThrow();
  });
  it("keeps a saved key when editing and retests it without returning it", async () => {
    const { service, probe } = fixture();
    const proof = await service.test("a", input);
    const saved = await service.save("a", input, proof.verificationToken);
    const edited = { ...input, id: saved.id, apiKey: "", name: "Renamed" };
    const retest = await service.test("a", edited);
    expect(probe.mock.lastCall?.[0].apiKey).toBe(input.apiKey);
    expect(
      (await service.save("a", edited, retest.verificationToken)).name,
    ).toBe("Renamed");
    await expect(service.test("b", edited)).rejects.toThrow();
  });
  it("rejects expired proofs and requires a configured encryption key", async () => {
    vi.useFakeTimers();
    const { service, stores } = fixture();
    const proof = await service.test("a", input);
    vi.advanceTimersByTime(16 * 60_000);
    await expect(
      service.save("a", input, proof.verificationToken),
    ).rejects.toThrow();
    await expect(
      new ModelProviderService(stores.modelProviderStore, undefined).test(
        "a",
        input,
      ),
    ).rejects.toThrow();
  });
  it("registers only the current Session Tenant's provider and rejects cross-Tenant selections", async () => {
    const { service, stores } = fixture();
    const proof = await service.test("a", input);
    const saved = await service.save("a", input, proof.verificationToken);
    const configure = service.configureRuntime({
      getById: async () => ({ tenantId: "b" }),
    } as never);
    await expect(
      configure(
        {
          sessionId: "session-b",
          agent: { model: `${saved.id}/vendor/model` },
        } as never,
        {} as never,
      ),
    ).rejects.toThrow("unavailable");
  });
  it("discovers models with Tenant-owned credentials and no existing model selection", async () => {
    const { service, discover } = fixture();
    const connection = {
      api: input.api,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
    };
    expect(await service.discover("a", connection)).toEqual({
      data: input.models,
    });
    expect(discover.mock.lastCall?.[0]).toMatchObject({
      ...connection,
      models: [],
    });
    const proof = await service.test("a", input);
    const saved = await service.save("a", input, proof.verificationToken);
    await service.discover("a", { ...connection, id: saved.id, apiKey: "" });
    expect(discover.mock.lastCall?.[0].apiKey).toBe(input.apiKey);
    const calls = discover.mock.calls.length;
    await expect(
      service.discover("b", { ...connection, id: saved.id, apiKey: "" }),
    ).rejects.toThrow();
    expect(discover).toHaveBeenCalledTimes(calls);
    await expect(
      service.discover("a", { ...connection, baseUrl: "https://127.0.0.1" }),
    ).rejects.toThrow();
  });
  it("exposes live discovery separately from protocol metadata and preserves safe errors", async () => {
    vi.stubEnv("AUTH_DISABLED", "true");
    const { service, stores, discover } = fixture();
    const app = createApp({
      apiKeyStore: stores.apiKeyStore,
      modelProviderService: service,
    });
    const protocols = await app.request("/v1/model-providers/protocols");
    const protocolData = await protocols.json();
    expect(protocolData.protocols).toHaveLength(3);
    expect(protocolData.models).toBeUndefined();
    const request = () =>
      app.request("/v1/model-providers/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api: input.api,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
        }),
      });
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ data: input.models });
    discover.mockRejectedValueOnce(new Error(`reflected ${input.apiKey}`));
    const failure = await request();
    expect(failure.status).toBe(422);
    expect(await failure.text()).not.toContain(input.apiKey);
  });
  it("validates HTTP input, redacts errors and blocks untested saves", async () => {
    vi.stubEnv("AUTH_DISABLED", "true");
    const { service, stores, probe } = fixture();
    const app = createApp({
      apiKeyStore: stores.apiKeyStore,
      modelProviderService: service,
    });
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (
        await post("/v1/model-providers/test", {
          ...input,
          api: "arbitrary-code",
        })
      ).status,
    ).toBe(400);
    expect(
      (await post("/v1/model-providers/test", { ...input, models: [] })).status,
    ).toBe(400);
    expect(
      (
        await post("/v1/model-providers/test", {
          ...input,
          models: [input.models[0], input.models[0]],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/v1/model-providers", {
          ...input,
          verificationToken: "fake",
        })
      ).status,
    ).toBe(400);
    probe.mockRejectedValueOnce(new Error(`Server echoes ${input.apiKey}`));
    const failed = await post("/v1/model-providers/test", input);
    expect(failed.status).toBe(422);
    expect(await failed.text()).not.toContain(input.apiKey);
    const test = await post("/v1/model-providers/test", input);
    expect(test.status).toBe(200);
    const proof = await test.json();
    const saved = await post("/v1/model-providers", { ...input, ...proof });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(input.apiKey);
    const listed = await app.request("/v1/model-providers");
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(await listed.text()).not.toContain(input.apiKey);
  });
});
describe("custom provider network boundary", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "172.16.1.1",
    "192.168.1.2",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2002:7f00:1::",
    "2001:db8::1",
  ])("rejects non-public address %s", (address) =>
    expect(isPublicProviderAddress(address)).toBe(false),
  );
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "allows public address %s",
    (address) => expect(isPublicProviderAddress(address)).toBe(true),
  );
  it.each([
    "http://example.com",
    "https://127.1",
    "https://2130706433",
    "https://[::1]",
    "https://user:key@example.com",
    "https://example.com?key=x",
    "https://example.com#fragment",
  ])("rejects unsafe endpoint %s", (url) =>
    expect(() => providerBaseUrl(url)).toThrow(),
  );
  it("rejects endpoint escapes and forbids redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("OK"));
    vi.stubGlobal("fetch", fetchMock);
    const request = providerFetch("https://example.com/v1");
    await expect(
      request("https://other.example.com/v1/messages"),
    ).rejects.toThrow();
    await expect(request("https://example.com/private")).rejects.toThrow();
    await request("https://example.com/v1/messages");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/v1/messages",
      expect.objectContaining({
        redirect: "error",
        dispatcher: expect.anything(),
      }),
    );
  });
});
