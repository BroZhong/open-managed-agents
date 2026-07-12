// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import AgentDetailPage from "@/pages/agent-detail";
import type { Agent } from "@/lib/hooks/use-agents";

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
        name: "rds-mcp",
        url: "https://campaign.welltop.tech/agent/mcp/rds",
        transport: "streamable-http",
        headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
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
  expect(
    screen.getByText("https://campaign.welltop.tech/agent/mcp/rds"),
  ).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
});
