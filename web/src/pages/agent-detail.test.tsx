// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import AgentDetailPage from "@/pages/agent-detail";
import type { Agent } from "@/lib/hooks/use-agents";
import type { McpCatalogEntry } from "@/lib/hooks/use-mcp-catalog";
import type { Session } from "@/lib/hooks/use-sessions";

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
  queryClient.setQueryData(["sessions", "byAgent", agent.id], {
    pages: [{ data: [], has_more: false }], pageParams: [undefined],
  });
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

it("loads Sessions beyond the first 50 from the Agent detail page", async () => {
  const agent: Agent = {
    id: "agent_many_sessions",
    tenantId: "tenant_1",
    name: "Many Sessions",
    model: "openai-codex/gpt-5.5",
    system: "Help with tasks",
    runtime: "pi-agent",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
  const sessions: Session[] = Array.from({ length: 51 }, (_, index) => ({
    id: `session_${index + 1}`,
    agentId: agent.id,
    agent,
    workspaceId: `workspace_${index + 1}`,
    status: index === 50 ? "running" : "idle",
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  }));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["agents", agent.id], agent);
  let resolveNextPage!: (response: Response) => void;
  const sessionRequests: URL[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/v1/sessions") return new Promise<Response>(() => undefined);
    sessionRequests.push(url);
    if (url.searchParams.has("cursor")) {
      return new Promise<Response>((resolve) => { resolveNextPage = resolve; });
    }
    return Promise.resolve(Response.json({ data: sessions.slice(0, 50), has_more: true, next_cursor: "session_50" }));
  }));

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/agents/${agent.id}`]}>
        <Routes>
          <Route path="/agents/:id" element={<AgentDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  const loadMore = await screen.findByRole("button", { name: "Load more" });
  expect(screen.getByRole("link", { name: /session_1 / })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /session_51 / })).toBeNull();
  expect(sessionRequests).toHaveLength(1);
  fireEvent.click(loadMore);
  expect(await screen.findByRole("button", { name: "Loading…" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("link", { name: /session_1 / })).toBeTruthy();

  await act(async () => { resolveNextPage(Response.json({ data: sessions.slice(50), has_more: false })); });
  expect((await screen.findByRole("link", { name: /session_51 / })).getAttribute("href")).toBe("/sessions/session_51");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
  const sessionLinks = screen.getAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("/sessions/"));
  expect(sessionLinks).toHaveLength(51);
  expect(sessionLinks[0].getAttribute("href")).toBe("/sessions/session_51");
  expect(sessionRequests.map((url) => Object.fromEntries(url.searchParams))).toEqual([
    { agent_id: agent.id, exclude_loop: "true", limit: "50" },
    { agent_id: agent.id, exclude_loop: "true", limit: "50", cursor: "session_50" },
  ]);
});
