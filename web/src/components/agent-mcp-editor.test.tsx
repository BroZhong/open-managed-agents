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

const catalog = [
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
    requiredEnv: ["ALIYUN_ACCESS_KEY_ID", "ALIYUN_ACCESS_KEY_SECRET", "ALIYUN_REGION"],
  },
] as const;

function renderEditor(
  value: Agent = agent,
  availableCatalog: readonly (typeof catalog)[number][] = catalog,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(["mcp-catalog"], availableCatalog);
  render(
    <QueryClientProvider client={queryClient}>
      <AgentMcpEditor agent={value} />
    </QueryClientProvider>,
  );
}

describe("Agent MCP configuration", () => {
  it("configures the managed Supabase MCP name and description", async () => {
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
      screen.getByRole("button", { name: "Enable aliyun-rds-supabase" }),
    );
    fireEvent.change(screen.getByLabelText("aliyun-rds-supabase MCP name"), {
      target: { value: "session-data" },
    });
    fireEvent.change(screen.getByLabelText("aliyun-rds-supabase MCP description"), {
      target: { value: "Read recent Session data" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save MCP" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      mcpServers: [{
        catalogId: "aliyun-rds-supabase",
        name: "session-data",
        description: "Read recent Session data",
      }],
    });
  });

  it("enables a catalog entry and persists only its configurable reference", async () => {
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
      screen.getByRole("button", { name: "Enable rds-mcp" }),
    );

    expect(screen.getByText("rds-mcp")).toBeTruthy();
    expect(screen.getByText("Managed streamable-http")).toBeTruthy();
    expect(screen.getByText(/RDS_MCP_APIKEY/)).toBeTruthy();
    expect(screen.getByLabelText("rds-mcp MCP name")).toBeTruthy();
    expect(screen.getByLabelText("rds-mcp MCP description")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save MCP" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/agents/agent_storyboard");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      mcpServers: [{
        catalogId: "rds-mcp",
        name: "rds-mcp",
        description: "Managed RDS gateway",
      }],
    });
  });

  it("removes an existing managed RDS connection", async () => {
    const configuredAgent: Agent = {
      ...agent,
      mcpServers: [{ catalogId: "rds-mcp", name: "rds-mcp" }],
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
      screen.getByRole("button", { name: "Remove rds-mcp" }),
    );
    expect(screen.getByRole("button", { name: "Enable rds-mcp" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save MCP" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ mcpServers: [] });
  });

  it("disables saving when an existing managed reference is missing from the catalog", () => {
    const configuredAgent: Agent = {
      ...agent,
      mcpServers: [{
        catalogId: "aliyun-rds-supabase",
        name: "session-data",
        description: "Read recent Sessions",
      }],
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderEditor(configuredAgent, [catalog[0]]);

    expect(
      (screen.getByRole("button", { name: "Save MCP" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/Managed MCP Connection is unavailable/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save MCP" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
