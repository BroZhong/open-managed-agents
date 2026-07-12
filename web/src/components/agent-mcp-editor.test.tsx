// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentMcpEditor } from "@/components/agent-mcp-editor";
import type { Agent } from "@/lib/hooks/use-agents";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const agent: Agent = {
  id: "agent_storyboard",
  tenantId: "tenant_1",
  name: "Storyboard Agent",
  model: "openai-codex/gpt-5.5",
  system: "Create storyboards",
  runtime: "pi-agent",
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
};

function renderEditor(value: Agent = agent) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AgentMcpEditor agent={value} />
    </QueryClientProvider>,
  );
}

const managedRdsServer = {
  name: "rds-mcp",
  url: "https://campaign.welltop.tech/agent/mcp/rds",
  transport: "streamable-http" as const,
  headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
};

describe("Agent MCP configuration", () => {
  it("enables and saves only the fixed managed RDS resource", async () => {
    localStorage.setItem("oma_api_key", "console-token");
    const fetchMock = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(agent),
      }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    renderEditor();

    fireEvent.click(
      screen.getByRole("button", { name: "Enable managed RDS MCP" }),
    );

    expect(screen.getByText("rds-mcp")).toBeTruthy();
    expect(screen.getByText(managedRdsServer.url)).toBeTruthy();
    expect(screen.getByText("Streamable HTTP")).toBeTruthy();
    expect(screen.getByText("Bearer ${RDS_MCP_APIKEY}")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add MCP server" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save MCP" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/agents/agent_storyboard");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      mcpServers: [managedRdsServer],
    });
  });

  it("removes the managed RDS resource and persists the empty configuration", async () => {
    const configuredAgent: Agent = {
      ...agent,
      mcpServers: [managedRdsServer],
    };
    const fetchMock = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ...configuredAgent, mcpServers: [] }),
      }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(configuredAgent);

    fireEvent.click(
      screen.getByRole("button", { name: "Remove managed RDS MCP" }),
    );
    expect(screen.getByText("Managed RDS MCP is not enabled for this Agent.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save MCP" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ mcpServers: [] });
  });

  it("does not expose or preserve unmanaged MCP configuration", async () => {
    const unmanagedAgent: Agent = {
      ...agent,
      mcpServers: [
        {
          name: "untrusted-server",
          url: "https://untrusted.example.com/mcp",
          transport: "streamable-http",
          headers: { Authorization: "Bearer ${UNTRUSTED_TOKEN}" },
        },
      ],
    };
    const fetchMock = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ...unmanagedAgent, mcpServers: [] }),
      }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(unmanagedAgent);

    expect(screen.queryByText("untrusted-server")).toBeNull();
    expect(screen.queryByText("https://untrusted.example.com/mcp")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Enable managed RDS MCP" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save MCP" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ mcpServers: [] });
  });
});
