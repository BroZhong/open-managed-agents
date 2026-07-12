// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AuthProvider } from "@/lib/auth";
import App from "@/App";
import type { Agent } from "@/lib/hooks/use-agents";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function renderApp(path: string, agents?: Agent[]) {
  localStorage.setItem("oma_api_key", "test-token");
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (agents) queryClient.setQueryData(["agents"], agents);

  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

it("shows Dashboard as the console home", () => {
  renderApp("/");

  expect(screen.getByRole("heading", { name: "Dashboard" })).toBeTruthy();
});

it("keeps /dashboard as a compatible link to the console home", () => {
  renderApp("/dashboard");

  expect(screen.getByRole("heading", { name: "Dashboard" })).toBeTruthy();
});

it("keeps /overview as a legacy link to the console home", () => {
  renderApp("/overview");

  expect(screen.getByRole("heading", { name: "Dashboard" })).toBeTruthy();
});

it("shows the integratable MCP catalog without listing Agents", () => {
  const agents: Agent[] = [
    {
      id: "agent_storyboard",
      tenantId: "tenant_1",
      name: "Storyboard Agent",
      model: "openai-codex/gpt-5.5",
      system: "Create storyboards",
      runtime: "pi-agent",
      mcpServers: [
        {
          name: "rds-mcp",
          url: "https://campaign.welltop.tech/agent/mcp/rds",
          transport: "streamable-http",
          headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
        },
        { name: "search", url: "https://example.com/mcp" },
      ],
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    },
    {
      id: "agent_empty",
      tenantId: "tenant_1",
      name: "Empty Agent",
      model: "openai-codex/gpt-5.5",
      system: "No MCP yet",
      runtime: "pi-agent",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    },
  ];

  renderApp("/mcp", agents);

  expect(screen.getByRole("heading", { name: "MCP" })).toBeTruthy();
  expect(screen.getByText("rds-mcp")).toBeTruthy();
  expect(screen.getByText("streamable-http")).toBeTruthy();
  expect(screen.getByText("https://campaign.welltop.tech/agent/mcp/rds")).toBeTruthy();
  expect(screen.getByText(/connect it from an Agent's detail page/i)).toBeTruthy();
  expect(screen.queryByText("Storyboard Agent")).toBeNull();
  expect(screen.queryByText("Empty Agent")).toBeNull();
  expect(
    vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/v1/agents")),
  ).toBe(false);
});
