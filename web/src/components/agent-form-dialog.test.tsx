// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentFormDialog } from "@/components/agent-form-dialog";
import type { Agent } from "@/lib/hooks/use-agents";
import { PI_MODELS } from "@/lib/agent-runtime";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

  queryClient.setQueryData(["model-providers"], []);
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
  queryClient.setQueryData(["model-providers"], []);
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
  queryClient.setQueryData(["model-providers"], [{ id: "custom-one", name: "Gateway", models: [{ id: "vendor/model", name: "Custom Model" }] }]);
  render(<QueryClientProvider client={queryClient}><AgentFormDialog open onOpenChange={() => {}} /></QueryClientProvider>);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Custom Agent" } });
  fireEvent.click(screen.getByLabelText("Model"));
  fireEvent.click(screen.getByRole("button", { name: "Custom Model · Gateway" }));
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(init.body)).model).toBe("custom-one/vendor/model");
});
