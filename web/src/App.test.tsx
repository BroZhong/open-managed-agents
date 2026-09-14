// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AuthProvider } from "@/lib/auth";
import App from "@/App";
import type { Agent } from "@/lib/hooks/use-agents";
import type { McpCatalogEntry } from "@/lib/hooks/use-mcp-catalog";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const mcpCatalog: McpCatalogEntry[] = [
  {
    id: "rds-mcp",
    defaultName: "rds-mcp",
    defaultDescription: "Managed RDS gateway",
    transport: "streamable-http",
    configurable: ["name", "description"],
    requiredEnv: ["RDS_MCP_APIKEY"],
  },
  {
    id: "aliyun-rds-supabase",
    defaultName: "aliyun-rds-supabase",
    defaultDescription: "Inspect Supabase on Alibaba Cloud RDS",
    transport: "stdio",
    configurable: ["name", "description"],
    requiredEnv: [
      "ALIYUN_ACCESS_KEY_ID",
      "ALIYUN_ACCESS_KEY_SECRET",
      "ALIYUN_REGION",
    ],
  },
];

function renderApp(path: string, agents?: Agent[]) {
  localStorage.setItem("oma_api_key", "test-token");
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (agents) queryClient.setQueryData(["agents"], agents);
  queryClient.setQueryData(["mcp-catalog"], mcpCatalog);

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
        { catalogId: "rds-mcp", name: "rds-mcp" },
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
  expect(screen.getByText("aliyun-rds-supabase")).toBeTruthy();
  expect(screen.getByText("stdio")).toBeTruthy();
  expect(screen.getByText("Inspect Supabase on Alibaba Cloud RDS")).toBeTruthy();
  expect(screen.getByText(/connect it from an Agent's detail page/i)).toBeTruthy();
  expect(screen.queryByText("Storyboard Agent")).toBeNull();
  expect(screen.queryByText("Empty Agent")).toBeNull();
  expect(
    vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/v1/agents")),
  ).toBe(false);
});
