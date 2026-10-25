// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentFormDialog } from "@/components/agent-form-dialog";
import type { Agent } from "@/lib/hooks/use-agents";
import { PI_MODELS } from "@/lib/agent-runtime";
import type { ThinkingOptions } from "@/lib/hooks/use-thinking-options";

const basicOptions: ThinkingOptions = {
  model: "gateway/unknown",
  choices: [{ value: "off", label: "off" }, { value: "minimal", label: "minimal" }, { value: "low", label: "low" }, { value: "medium", label: "medium" }, { value: "high", label: "high" }],
  resolvedLevels: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
  defaultLevel: "high",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("loads a new Agent's model capabilities, adapts its preference on model change, and preserves that preference", async () => {
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/model-thinking-options?")) {
      return Response.json(url.includes("unknown") ? basicOptions : {
        ...basicOptions, model: PI_MODELS[0].value,
        choices: [{ value: "low", label: "low" }, { value: "high", label: "high" }, { value: "max", label: "max" }],
        resolvedLevels: { off: "low", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
        defaultLevel: "max",
      });
    }
    if (init?.method === "POST") return Response.json({ id: "created" });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", request);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["model-providers"], [{ id: "gateway", name: "Gateway", models: [{ id: "unknown", name: "Unknown" }] }]);
  client.setQueryData(["environments"], []);
  render(<QueryClientProvider client={client}><AgentFormDialog open onOpenChange={() => {}} /></QueryClientProvider>);
  const slider = await screen.findByRole("slider", { name: "思考强度" });
  expect(slider.getAttribute("max")).toBe("2");
  expect(slider.getAttribute("aria-valuetext")).toBe("自动 · 模型最高 · 最大");
  fireEvent.change(slider, { target: { value: "0" } });
  fireEvent.change(slider, { target: { value: "2" } });
  fireEvent.click(screen.getByLabelText("Model"));
  fireEvent.click(screen.getByRole("button", { name: "Unknown · Gateway" }));
  await waitFor(() => expect(screen.getByRole("slider").getAttribute("max")).toBe("4"));
  expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("最大 → 高");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Capability Agent" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
  const saved = request.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(String(saved[1]?.body))).toMatchObject({ model: "gateway/unknown", thinking: "max" });
  expect(request.mock.calls.filter(([url]) => url.includes("/model-thinking-options?")).length).toBe(2);
});

it("retries capability failure without inventing choices, then disables unsupported thinking", async () => {
  const request = vi.fn()
    .mockResolvedValueOnce(Response.json({ error: "Capability reference is no longer available" }, { status: 422 }))
    .mockResolvedValueOnce(Response.json({
      ...basicOptions, choices: [{ value: "off", label: "off" }], defaultLevel: "off",
      resolvedLevels: { off: "off", minimal: "off", low: "off", medium: "off", high: "off", xhigh: "off", max: "off" },
    }));
  vi.stubGlobal("fetch", request);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["model-providers"], []);
  client.setQueryData(["environments"], []);
  render(<QueryClientProvider client={client}><AgentFormDialog open onOpenChange={() => {}} /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "档位读取失败，重试" }));
  expect(screen.queryByRole("slider")).toBeNull();
  expect(await screen.findByRole("slider")).toHaveProperty("disabled", true);
  expect(screen.getByText("不支持思考")).toBeTruthy();
});

it.each([
  ["oma-sandbox-v2", "oma-sandbox-v2"],
  ["auto-story", undefined],
])("preserves sandbox environment and resolves %s to the supported template when editing", async (image, expectedImage) => {
  const agent: Agent = {
    id: "agent_storyboard",
    tenantId: "tenant_1",
    name: "Storyboard Agent",
    model: "openai-codex/gpt-5.5",
    system: "Create storyboards",
    runtime: "pi-agent",
    sandbox: {
      enabled: true,
      image,
      env: {
        VFS_TOKEN: "vfs-token",
        RDS_MCP_APIKEY: "vfs-token",
      },
    },
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
  const fetchMock = vi.fn(async () =>
    ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(agent),
    }) as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });

  for (const model of [...PI_MODELS.map(choice => choice.value), "openai-codex/gpt-5.5", "custom-one/vendor/model"]) {
    queryClient.setQueryData(["model-thinking-options", model], { ...basicOptions, model });
  }
  queryClient.setQueryData(["model-providers"], []);
  queryClient.setQueryData(["environments"], []);
  render(
    <QueryClientProvider client={queryClient}>
      <AgentFormDialog open onOpenChange={() => {}} agent={agent} />
    </QueryClientProvider>,
  );

  expect(screen.queryByLabelText("Sandbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(init.body)).model).toBe("openai-codex/gpt-5.5");
  expect(JSON.parse(String(init.body)).sandbox).toEqual({
    enabled: true,
    ...(expectedImage ? { image: expectedImage } : {}),
    env: {
      VFS_TOKEN: "vfs-token",
      RDS_MCP_APIKEY: "vfs-token",
    },
  });
});

it.each(PI_MODELS.map((choice) => choice.value))("creates an Agent with %s and the default sandbox", async (model) => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: "agent_default_sandbox" }),
  }) as Response);
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  for (const model of [...PI_MODELS.map(choice => choice.value), "openai-codex/gpt-5.5", "custom-one/vendor/model"]) {
    queryClient.setQueryData(["model-thinking-options", model], { ...basicOptions, model });
  }
  queryClient.setQueryData(["model-providers"], []);
  queryClient.setQueryData(["environments"], []);
  render(
    <QueryClientProvider client={queryClient}>
      <AgentFormDialog open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );

  expect(screen.getByLabelText("Model").textContent).toBe("GPT-5.6 Sol");
  expect(screen.queryByLabelText("Sandbox")).toBeNull();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My Agent" } });
  fireEvent.click(screen.getByLabelText("Model"));
  fireEvent.click(screen.getByRole("button", { name: PI_MODELS.find((choice) => choice.value === model)!.label }));
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(init.body))).toMatchObject({
    name: "My Agent",
    model,
    runtime: "pi-agent",
  });
  expect(JSON.parse(String(init.body)).sandbox).toEqual({ enabled: true });
});

it("selects a tested custom model when creating an Agent", async () => {
  const fetchMock = vi.fn(async () => Response.json({ id: "agent_custom" }));
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const model of [...PI_MODELS.map(choice => choice.value), "openai-codex/gpt-5.5", "custom-one/vendor/model"]) {
    queryClient.setQueryData(["model-thinking-options", model], { ...basicOptions, model });
  }
  queryClient.setQueryData(["model-providers"], [{ id: "custom-one", name: "Gateway", models: [{ id: "vendor/model", name: "Custom Model" }] }]);
  queryClient.setQueryData(["environments"], []);
  render(<QueryClientProvider client={queryClient}><AgentFormDialog open onOpenChange={() => {}} /></QueryClientProvider>);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Custom Agent" } });
  fireEvent.click(screen.getByLabelText("Model"));
  fireEvent.click(screen.getByRole("button", { name: "Custom Model · Gateway" }));
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(init.body)).model).toBe("custom-one/vendor/model");
});

it.each([false, true])("persists slider preference and supports resetting it (reset=%s)", async (reset) => {
  const fetchMock = vi.fn(async () => Response.json({ id: "a" }));
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const model of [...PI_MODELS.map(choice => choice.value), "openai-codex/gpt-5.5", "custom-one/vendor/model"]) {
    queryClient.setQueryData(["model-thinking-options", model], { ...basicOptions, model });
  }
  queryClient.setQueryData(["model-providers"], []);
  queryClient.setQueryData(["environments"], []);
  const agent: Agent = { id: "a", tenantId: "t", name: "Test", model: "bigmodel/glm-5.3", thinking: "low", system: "test", runtime: "pi-agent", createdAt: "", updatedAt: "" };
  render(<QueryClientProvider client={queryClient}><AgentFormDialog open onOpenChange={() => {}} agent={agent} /></QueryClientProvider>);
  const slider = screen.getByRole("slider", { name: "思考强度" }) as HTMLInputElement;
  expect(slider.value).toBe("2");
  fireEvent.change(slider, { target: { value: "3" } });
  expect(slider.getAttribute("aria-valuetext")).toBe("中");
  if (reset) fireEvent.click(screen.getByRole("button", { name: "重置思考强度" }));
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(init.body)).thinking).toBe(reset ? null : "medium");
});

describe("the Agent's Environment (ADR-0024)", () => {
  const environment = (id: string, name: string, status: "pending" | "building" | "failed" | "ready", ownerType: "platform" | "tenant" = "tenant") =>
    ({ id, name, status, ownerType, description: "", baseImage: "oma-base" as const, image: null, lastBuild: null, createdAt: "", updatedAt: "" });
  // As GET /v1/environments lists them: built-ins first.
  const listed = [
    environment("env_video_production", "video-production", "ready", "platform"),
    environment("env_old_platform", "old-platform", "building", "platform"),
    environment("env_tools", "tools", "ready"),
    environment("env_unbuilt", "unbuilt", "pending"),
    environment("env_broken", "broken", "failed"),
  ];
  function renderDialog(agent?: Agent) {
    const fetchMock = vi.fn(async () => Response.json({ id: agent?.id ?? "created" }));
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    for (const model of [...PI_MODELS.map(choice => choice.value), "openai-codex/gpt-5.5"]) {
      queryClient.setQueryData(["model-thinking-options", model], { ...basicOptions, model });
    }
    queryClient.setQueryData(["model-providers"], []);
    queryClient.setQueryData(["environments"], listed);
    render(<QueryClientProvider client={queryClient}><AgentFormDialog open onOpenChange={() => {}} agent={agent} /></QueryClientProvider>);
    const saved = async () => {
      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      return JSON.parse(String(init.body));
    };
    return { saved };
  }
  /** Open the Environment picker: the labels it offers, in order. */
  const options = () => {
    const trigger = screen.getByLabelText("Environment");
    fireEvent.click(trigger);
    return [...trigger.nextElementSibling!.querySelectorAll("button")].map((button) => button.textContent);
  };
  const agent: Agent = { id: "agent_bound", tenantId: "t", name: "Bound", model: "openai-codex/gpt-5.5", system: "s", runtime: "pi-agent",
    sandbox: { enabled: true }, environmentId: "env_tools", createdAt: "", updatedAt: "" };

  it("offers only ready Environments, built-ins first, and binds the chosen one to a new Agent", async () => {
    const { saved } = renderDialog();
    expect(screen.getByLabelText("Environment").textContent).toBe("None (the Host's default image)");
    expect(options()).toEqual([
      "None (the Host's default image)", "video-production · 平台内置", "tools",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "video-production · 平台内置" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Video" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    expect(await saved()).toMatchObject({ name: "Video", environmentId: "env_video_production" });
  });

  it("creates an Agent without an Environment by sending none", async () => {
    const { saved } = renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Plain" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    expect(await saved()).not.toHaveProperty("environmentId");
  });

  it("keeps an edited Agent's Environment, and unbinds it with None", async () => {
    const kept = renderDialog(agent);
    expect(screen.getByLabelText("Environment").textContent).toBe("tools");
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(await kept.saved()).toMatchObject({ environmentId: "env_tools" });
    cleanup();
    const cleared = renderDialog(agent);
    options();
    fireEvent.click(screen.getByRole("button", { name: "None (the Host's default image)" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect((await cleared.saved()).environmentId).toBeNull();
  });

  it("keeps showing an Agent's Environment that is rebuilding, without offering others that are not ready", async () => {
    const { saved } = renderDialog({ ...agent, environmentId: "env_unbuilt" });
    expect(screen.getByLabelText("Environment").textContent).toBe("unbuilt (current, 待构建)");
    expect(options()).not.toContain("broken");
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(await saved()).toMatchObject({ environmentId: "env_unbuilt" });
  });
});
