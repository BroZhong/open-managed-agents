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

it("preserves the Agent's sandbox image and environment when editing", async () => {
  const agent: Agent = {
    id: "agent_storyboard",
    tenantId: "tenant_1",
    name: "Storyboard Agent",
    model: "openai-codex/gpt-5.5",
    system: "Create storyboards",
    runtime: "pi-agent",
    sandbox: {
      enabled: true,
      image: "oma-sandbox-v2",
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
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <AgentFormDialog open onOpenChange={() => {}} agent={agent} />
    </QueryClientProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(init.body)).model).toBe("openai-codex/gpt-5.5");
  expect(JSON.parse(String(init.body)).sandbox).toEqual({
    enabled: true,
    image: "oma-sandbox-v2",
    env: {
      VFS_TOKEN: "vfs-token",
      RDS_MCP_APIKEY: "vfs-token",
    },
  });
});

it.each([
  "kimi-coding-plan/k3",
  "openai-codex/gpt-6-astra",
  "openai-codex/gpt-5.6-sol",
])("creates an Agent with %s and the auto-story sandbox", async (model) => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: "agent_auto_story" }),
  }) as Response);
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AgentFormDialog open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );

  expect(screen.getByLabelText("Model").textContent).toBe("GPT-5.6 Sol");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "auto-story" } });
  fireEvent.click(screen.getByLabelText("Model"));
  fireEvent.click(screen.getByRole("button", { name: PI_MODELS.find((choice) => choice.value === model)!.label }));
  fireEvent.click(screen.getByLabelText("Sandbox"));
  fireEvent.click(screen.getByRole("button", { name: "auto-story" }));
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(init.body))).toMatchObject({
    name: "auto-story",
    model,
    runtime: "pi-agent",
    sandbox: { enabled: true, image: "auto-story" },
  });
});
