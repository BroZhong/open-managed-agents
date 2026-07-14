// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import AgentDetailPage from "@/pages/agent-detail";
import type { Agent } from "@/lib/hooks/use-agents";
import type { McpCatalogEntry } from "@/lib/hooks/use-mcp-catalog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows the Agent-owned MCP editor on the Agent detail page", () => {
  const agent: Agent = {
    id: "agent_storyboard",
    tenantId: "tenant_1",
    name: "Storyboard Agent",
    model: "openai-codex/gpt-5.5",
    system: "Create storyboards",
    runtime: "pi-agent",
    mcpServers: [
      {
        catalogId: "aliyun-rds-supabase",
        name: "session-data",
        description: "Read recent Session data",
      },
    ],
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["agents", agent.id], agent);
  queryClient.setQueryData(["sessions", "byAgent", agent.id], []);
  const catalog: McpCatalogEntry[] = [
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
  queryClient.setQueryData(["mcp-catalog"], catalog);
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/agents/${agent.id}#mcp`]}>
        <Routes>
          <Route path="/agents/:id" element={<AgentDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(screen.getByRole("heading", { name: "Managed MCP" })).toBeTruthy();
  expect(screen.getByText("aliyun-rds-supabase")).toBeTruthy();
  expect(screen.getByText("Managed stdio")).toBeTruthy();
  expect(screen.getByLabelText("aliyun-rds-supabase MCP name")).toHaveProperty(
    "value",
    "session-data",
  );
  expect(
    screen.getByLabelText("aliyun-rds-supabase MCP description"),
  ).toHaveProperty("value", "Read recent Session data");
  expect(screen.queryByText("supabase-mcp")).toBeNull();
});
