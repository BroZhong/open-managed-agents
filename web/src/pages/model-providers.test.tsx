// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ModelProvidersPage from "./model-providers";
const model = {
  id: "private-model-a",
  name: "Private Model A",
  contextWindow: 32768,
  maxTokens: 4096,
  reasoning: false,
  input: ["text"],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(providers: unknown[] = []) {
  const cache = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  cache.setQueryData(["model-providers"], providers);
  cache.setQueryData(["provider-protocols"], {
    protocols: [
      { id: "openai-completions", name: "OpenAI Chat Completions" },
      { id: "anthropic-messages", name: "Anthropic Messages" },
    ],
  });
  render(
    <QueryClientProvider client={cache}>
      <ModelProvidersPage />
    </QueryClientProvider>,
  );
}
function fillConnection() {
  fireEvent.click(screen.getByRole("button", { name: "Add Provider" }));
  fireEvent.change(screen.getByLabelText("Provider name"), {
    target: { value: "Gateway" },
  });
  fireEvent.change(screen.getByLabelText("Base URL"), {
    target: { value: "https://models.example.com/v1" },
  });
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "secret" },
  });
}
it("lets users configure, test and save exactly five Adaptive effort levels", async () => {
  const provider = { id: "custom-one", name: "Opus Gateway", api: "anthropic-messages", baseUrl: "https://models.example.com", hasApiKey: true,
    testedAt: "2026-10-12T00:00:00Z", models: [{ ...model, id: "global.anthropic.claude-opus-5-5", reasoning: true }] };
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/capability-references?")) return Response.json({ data: [], recommendations: [] });
    if (url.endsWith("/thinking-options")) {
      const chosen = JSON.parse(String(init?.body)).model.thinkingProfile;
      const levels = chosen ? ["low", "medium", "high", "xhigh", "max"] : ["off", "minimal", "low", "medium", "high"];
      return Response.json({ model: model.id, source: chosen ? "manual" : "default", profile: chosen,
        choices: levels.map(value => ({ value, label: value })), defaultLevel: chosen ? "max" : "high",
        resolvedLevels: chosen ? { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }
          : { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
      });
    }
    if (url.endsWith("/test")) return Response.json({ verificationToken: "proof", testedAt: "2026-10-12T00:00:00Z" });
    if (init?.method === "POST") return Response.json(provider);
    return Response.json({ data: [provider] });
  });
  vi.stubGlobal("fetch", request);
  setup([provider]);
  fireEvent.click(screen.getByRole("button", { name: "Edit Opus Gateway" }));
  fireEvent.click(screen.getByText("Model settings"));
  fireEvent.click(screen.getByText("高级思考设置"));
  fireEvent.click(await screen.findByLabelText("思考档位方案"));
  fireEvent.click(screen.getByRole("button", { name: "Anthropic Adaptive · 五档" }));
  await screen.findByText("低 · 中 · 高 · 很高 · 最大");
  expect(screen.queryByText(/请求关闭（未确认）/)).toBeNull();
  expect(screen.getByText("手动配置 · 自动使用最大")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save provider" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Test selected models" }));
  await screen.findByText(/All selected models responded/);
  fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
  await waitFor(() => expect(request.mock.calls.some(([url, init]) => url.endsWith("/model-providers") && init?.method === "POST")).toBe(true));
  const saved = request.mock.calls.find(([url, init]) => url.endsWith("/model-providers") && init?.method === "POST")!;
  expect(JSON.parse(String(saved[1]?.body))).toMatchObject({ id: "custom-one", apiKey: "", verificationToken: "proof", models: [{ id: "global.anthropic.claude-opus-5-5", thinkingProfile: "anthropic-adaptive" }] });
});
it("fetches endpoint models before selection, then tests and saves the chosen model", async () => {
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/discover")) return Response.json({ data: [model] });
    if (url.endsWith("/test"))
      return Response.json({
        verificationToken: "proof",
        testedAt: new Date().toISOString(),
      });
    if (init?.method === "POST") return Response.json({ id: "custom-one" });
    return Response.json({ data: [] });
  });
  vi.stubGlobal("fetch", request);
  setup();
  fillConnection();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: /Private Model A/ }),
  );
  expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
    api: "openai-completions",
    baseUrl: "https://models.example.com/v1",
    apiKey: "secret",
  });
  expect(
    (screen.getByRole("button", { name: "Save provider" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Test selected models" }));
  await screen.findByText(/All selected models responded/);
  fireEvent.change(screen.getByLabelText("Provider name"), {
    target: { value: "Renamed" },
  });
  expect(
    (screen.getByRole("button", { name: "Save provider" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    screen.getByRole("checkbox", { name: /Private Model A/ }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Test selected models" }));
  await screen.findByText(/All selected models responded/);
  fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
  await waitFor(() =>
    expect(
      request.mock.calls.some(
        ([url, init]) =>
          url.endsWith("/model-providers") && init?.method === "POST",
      ),
    ).toBe(true),
  );
  const saved = request.mock.calls.find(
    ([url, init]) =>
      url.endsWith("/model-providers") && init?.method === "POST",
  )!;
  expect(JSON.parse(String(saved[1]?.body))).toMatchObject({
    verificationToken: "proof",
    models: [model],
  });
});
it.each(["Base URL", "API key", "Protocol"])(
  "clears endpoint results and selected models when %s changes",
  async (field) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [model] })),
    );
    setup();
    fillConnection();
    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Private Model A/ }),
    );
    if (field === "Protocol") {
      fireEvent.click(screen.getByLabelText("Protocol"));
      fireEvent.click(
        screen.getByRole("button", { name: "Anthropic Messages" }),
      );
    } else
      fireEvent.change(screen.getByLabelText(field), {
        target: {
          value:
            field === "Base URL"
              ? "https://other.example.com/v1"
              : "another-key",
        },
      });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("Selected models (0/10)")).toBeTruthy();
  },
);
it("shows fetch errors and empty lists without falling back to static models", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ error: "Endpoint rejected key" }, { status: 422 }),
    )
    .mockResolvedValueOnce(Response.json({ data: [] }));
  vi.stubGlobal("fetch", request);
  setup();
  fillConnection();
  fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
  await screen.findByText("Endpoint rejected key");
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
  await screen.findByText("The endpoint returned no models for this API key.");
  expect(screen.queryByRole("checkbox")).toBeNull();
});
it("refreshes the list and removes selections no longer returned by the endpoint", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: [model] }))
    .mockResolvedValueOnce(
      Response.json({ data: [{ ...model, id: "model-b", name: "Model B" }] }),
    );
  vi.stubGlobal("fetch", request);
  setup();
  fillConnection();
  fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: /Private Model A/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await screen.findByRole("checkbox", { name: /Model B/ });
  expect(screen.getByText("Selected models (0/10)")).toBeTruthy();
});
it("uses stored credentials for discovery while editing", async () => {
  const request = vi.fn(async () => Response.json({ data: [model] }));
  vi.stubGlobal("fetch", request);
  setup([
    {
      id: "custom-one",
      name: "Gateway",
      api: "openai-completions",
      baseUrl: "https://models.example.com/v1",
      models: [model],
      hasApiKey: true,
      testedAt: new Date().toISOString(),
    },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Edit Gateway" }));
  expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
  await screen.findByRole("checkbox", { name: /Private Model A/ });
  expect(request).toHaveBeenCalledOnce();
});

it("adds an unknown model without a reasoning checkbox and only adopts a suggested reference after confirmation", async () => {
  const basic = {
    model: "gateway/alias", source: "default", control: "app",
    choices: [{ value: "off", label: "off" }, { value: "minimal", label: "minimal" }, { value: "low", label: "low" }, { value: "medium", label: "medium" }, { value: "high", label: "high" }],
    resolvedLevels: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" }, defaultLevel: "high",
    recommendations: [{ provider: "openai", modelId: "gpt-known", name: "Known model", reason: "Matches the model ID after a routing prefix" }],
  };
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/capability-references?")) return Response.json({ data: [{ provider: "openai", modelId: "gpt-known", name: "Known model", reasoning: true }], recommendations: basic.recommendations });
    if (url.endsWith("/thinking-options")) {
      const body = JSON.parse(String(init?.body));
      return Response.json(body.model.capabilityReference ? { ...basic, source: "manual", reference: body.model.capabilityReference, recommendations: [] } : basic);
    }
    if (url.endsWith("/test")) return Response.json({ verificationToken: "proof", testedAt: "2026-10-12T00:00:00Z" });
    if (init?.method === "POST") return Response.json({ id: "saved" });
    return Response.json({ data: [] });
  });
  vi.stubGlobal("fetch", request);
  setup();
  fillConnection();
  fireEvent.click(screen.getByText("Enter a model ID manually"));
  fireEvent.change(screen.getByLabelText("Custom model ID"), { target: { value: "gateway/alias" } });
  fireEvent.click(screen.getByRole("button", { name: "Add model" }));
  fireEvent.click(screen.getByText("Model settings"));
  expect(screen.queryByLabelText("Supports reasoning")).toBeNull();
  fireEvent.click(screen.getByText("高级思考设置"));
  await screen.findByText("基础档位 · 默认请求高");
  expect(screen.getByText("具体档位未确认；可选择同协议能力参照。")).toBeTruthy();
  expect(screen.getByText(/请求关闭（未确认）/)).toBeTruthy();
  const preview = request.mock.calls.find(([url]) => url.endsWith("/thinking-options"))!;
  expect(JSON.parse(String(preview[1]?.body)).model).toMatchObject({ reasoningSource: "default", capabilityVersion: 1 });
  expect(JSON.parse(String(preview[1]?.body)).model.reasoning).not.toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Test selected models" }));
  await screen.findByText(/All selected models responded/);
  let testBody = JSON.parse(String(request.mock.calls.filter(([url]) => url.endsWith("/test")).at(-1)![1]?.body));
  expect(testBody.models[0].capabilityReference).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "使用 Known model" }));
  await screen.findByText("手动参照 · 自动使用高");
  expect(screen.queryByText(/具体档位未确认/)).toBeNull();
  expect(screen.getByRole("button", { name: "Save provider" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Test selected models" }));
  await screen.findByText(/All selected models responded/);
  testBody = JSON.parse(String(request.mock.calls.filter(([url]) => url.endsWith("/test")).at(-1)![1]?.body));
  expect(testBody.models[0]).toMatchObject({ id: "gateway/alias", capabilityReference: { provider: "openai", modelId: "gpt-known" } });
  fireEvent.click(screen.getByRole("button", { name: "清除参照，恢复自动识别" }));
  await screen.findByText("基础档位 · 默认请求高");
  expect(screen.getByText(/具体档位未确认/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save provider" })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Search capability references for gateway/alias"), { target: { value: "Known" } });
  fireEvent.click(screen.getByLabelText("Capability reference"));
  fireEvent.click(screen.getByRole("button", { name: "Known model · openai/gpt-known" }));
  await screen.findByText("手动参照 · 自动使用高");
  fireEvent.click(screen.getByRole("button", { name: "Test selected models" }));
  await screen.findByText(/All selected models responded/);
  fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
  await waitFor(() => expect(request.mock.calls.some(([url, init]) => url.endsWith("/model-providers") && init?.method === "POST")).toBe(true));
  const saved = request.mock.calls.find(([url, init]) => url.endsWith("/model-providers") && init?.method === "POST")!;
  expect(JSON.parse(String(saved[1]?.body)).models[0]).toMatchObject({ id: "gateway/alias", capabilityReference: { provider: "openai", modelId: "gpt-known" } });
});

it.each([false, true])("reloads an invalid reference and lets the user clear and save it without replacing the model (legacy=%s)", async (legacy) => {
  const provider = { id: "custom-one", name: "Gateway", api: "openai-completions", baseUrl: "https://models.example.com/v1", hasApiKey: true,
    testedAt: "2026-10-12T00:00:00Z", models: [{ ...model, reasoningSource: "legacy", capabilityVersion: 1,
      ...(legacy ? { catalogProvider: "openai" } : { capabilityReference: { provider: "openai", modelId: "retired" } }) }] };
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/capability-references?")) return Response.json({ data: [], recommendations: [] });
    if (url.endsWith("/thinking-options")) {
      const body = JSON.parse(String(init?.body));
      return body.model.capabilityReference || body.model.catalogProvider ? Response.json({ error: "Capability reference is no longer available" }, { status: 422 }) : Response.json({
        model: model.id, source: "upstream", choices: [{ value: "off", label: "off" }], defaultLevel: "off",
        resolvedLevels: { off: "off", minimal: "off", low: "off", medium: "off", high: "off", xhigh: "off", max: "off" },
      });
    }
    if (url.endsWith("/test")) return Response.json({ verificationToken: "proof", testedAt: "2026-10-12T00:00:00Z" });
    if (init?.method === "POST") return Response.json(provider);
    return Response.json({ data: [provider] });
  });
  vi.stubGlobal("fetch", request);
  setup([provider]);
  fireEvent.click(screen.getByRole("button", { name: "Edit Gateway" }));
  fireEvent.click(screen.getByText("Model settings"));
  fireEvent.click(screen.getByText("高级思考设置"));
  await screen.findByText(/Capability reference is no longer available/);
  expect(screen.getByLabelText("Capability reference").textContent).toContain(legacy ? `openai/${model.id}` : "openai/retired");
  fireEvent.click(screen.getByRole("button", { name: "清除参照，恢复自动识别" }));
  await screen.findByText("接入服务声明 · 不支持思考");
  fireEvent.click(screen.getByRole("button", { name: "Test selected models" }));
  await screen.findByText(/All selected models responded/);
  fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
  await waitFor(() => expect(request.mock.calls.some(([url, init]) => url.endsWith("/model-providers") && init?.method === "POST")).toBe(true));
  const saved = request.mock.calls.find(([url, init]) => url.endsWith("/model-providers") && init?.method === "POST")!;
  const body = JSON.parse(String(saved[1]?.body));
  expect(body).toMatchObject({ id: "custom-one", apiKey: "", verificationToken: "proof", models: [{ id: model.id }] });
  expect(body.models[0].capabilityReference).toBeUndefined();
  expect(body.models[0].catalogProvider).toBeUndefined();
});

it("refreshes upstream capability declarations while keeping the selected manual reference", async () => {
  const reference = { provider: "openai", modelId: "known" };
  const provider = { id: "custom-one", name: "Gateway", api: "openai-completions", baseUrl: "https://models.example.com/v1", hasApiKey: true,
    testedAt: "2026-10-12T00:00:00Z", models: [{ ...model, name: "My display name", reasoning: true, reasoningSource: "default", capabilityReference: reference }] };
  const request = vi.fn(async (url: string) => url.endsWith("/discover") ? Response.json({ data: [{ ...model, reasoning: false, reasoningSource: "upstream", capabilityVersion: 1 }] }) : Response.json({ verificationToken: "proof", testedAt: "2026-10-12T00:00:00Z" }));
  vi.stubGlobal("fetch", request);
  setup([provider]);
  fireEvent.click(screen.getByRole("button", { name: "Edit Gateway" }));
  fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
  await screen.findByRole("checkbox", { name: /Private Model A/ });
  fireEvent.click(screen.getByRole("button", { name: "Test selected models" }));
  await screen.findByText(/All selected models responded/);
  const calls = request.mock.calls as unknown as [string, RequestInit][];
  const tested = calls.find(([url]) => url.endsWith("/test"))!;
  expect(JSON.parse(String(tested[1]?.body)).models[0]).toMatchObject({ name: "My display name", reasoning: false, reasoningSource: "upstream", capabilityVersion: 1, capabilityReference: reference });
});
