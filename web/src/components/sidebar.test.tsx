// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { AuthProvider } from "@/lib/auth";
import { Sidebar } from "@/components/sidebar";
import type { Agent } from "@/lib/hooks/use-agents";
import type { Session } from "@/lib/hooks/use-sessions";
import type { Workspace } from "@/lib/hooks/use-workspaces";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function SessionRoute() {
  const location = useLocation();
  return (
    <>
      <output aria-label="Current path">{location.pathname}</output>
      <Sidebar />
    </>
  );
}

function renderGlobalSidebar(path = "/") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <Sidebar />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("Sidebar global navigation", () => {
  it("groups the console entry points by platform, resources, and configuration", () => {
    renderGlobalSidebar();

    expect(screen.getByText("Agent Platform")).toBeTruthy();
    expect(screen.getByText("Resources")).toBeTruthy();
    expect(screen.getByText("Configuration")).toBeTruthy();

    expect(screen.getByRole("link", { name: "Dashboard" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Agent" }).getAttribute("href")).toBe("/agents");
    expect(screen.getByRole("link", { name: "Skill" }).getAttribute("href")).toBe("/skills");
    expect(screen.getByRole("link", { name: "MCP" }).getAttribute("href")).toBe("/mcp");
    expect(screen.getByRole("link", { name: "API-Key" }).getAttribute("href")).toBe("/api-keys");
  });
});

describe("Sidebar Session navigation", () => {
  it("keeps the Agent context while linked and newly created Sessions load", async () => {
    const agent: Agent = {
      id: "agent_1",
      tenantId: "tenant_1",
      name: "Test Agent",
      model: "test/model",
      system: "test",
      runtime: "pi-agent",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    };
    const workspace: Workspace = {
      id: "workspace_1",
      tenantId: "tenant_1",
      name: "Project Alpha",
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    const sessionAgent = {
      id: agent.id,
      name: agent.name,
      model: agent.model,
      runtime: agent.runtime,
    };
    const sourceSession: Session = {
      id: "session_source",
      agentId: agent.id,
      status: "idle",
      title: "Source Session",
      workspaceId: workspace.id,
      agent: sessionAgent,
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    };
    const targetSession: Session = {
      ...sourceSession,
      id: "session_target",
      title: "Target Session",
    };
    const createdSession: Session = {
      ...sourceSession,
      id: "session_created",
      title: undefined,
      workspaceId: "workspace_created",
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
      },
    });
    queryClient.setQueryData(["sessions", sourceSession.id], sourceSession);
    queryClient.setQueryData(
      ["sessions", "byAgent", agent.id],
      [sourceSession, targetSession],
    );
    queryClient.setQueryData(["workspaces"], [workspace]);
    queryClient.setQueryData(["agents", agent.id], agent);

    // Session GETs deliberately never resolve. This makes each navigation's
    // pending state deterministic instead of timing-dependent.
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: async () => JSON.stringify(createdSession),
          } as Response);
        }
        return new Promise<Response>(() => undefined);
      }),
    );

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={[`/sessions/${sourceSession.id}`]}>
            <Routes>
              <Route path="/sessions/:id" element={<SessionRoute />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: workspace.name }));
    fireEvent.click(
      screen.getByRole("link", { name: `${targetSession.title}idle` }),
    );

    expect(screen.getByLabelText("Current path").textContent).toBe(
      `/sessions/${targetSession.id}`,
    );
    expect(screen.getByRole("link", { name: agent.name })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: `${targetSession.title}idle` }),
    ).toBeTruthy();

    fireEvent.click(within(screen.getByTitle("New chat")).getByRole("button"));

    await waitFor(() =>
      expect(screen.getByLabelText("Current path").textContent).toBe(
        `/sessions/${createdSession.id}`,
      ),
    );
    expect(screen.getByRole("link", { name: agent.name })).toBeTruthy();
  });
});
