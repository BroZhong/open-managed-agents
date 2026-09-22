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
import SessionDetailPage from "@/pages/session-detail";
import type { Agent } from "@/lib/hooks/use-agents";
import type { Session } from "@/lib/hooks/use-sessions";
import type { Workspace } from "@/lib/hooks/use-workspaces";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
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
  it("requests parent Sessions without reusing a cached list containing children", async () => {
    const agent = { id: "agent_parents", name: "Parent list Agent" };
    const parent = {
      id: "parent_session", agentId: agent.id, title: "Main task",
      status: "terminated", workspaceId: "workspace_parents",
    };
    const child = {
      ...parent, id: "child_session", title: "Delegated task",
      delegation: { parentSessionId: parent.id },
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(["agents", agent.id], agent);
    queryClient.setQueryData(["sessions", "byAgent", agent.id], [child, parent]);
    queryClient.setQueryData(["workspaces"], []);
    queryClient.setQueryData(["loops", "byAgent", agent.id], []);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const data = url.searchParams.get("exclude_delegated") === "true" ? [parent] : [child, parent];
      return { ok: true, text: async () => JSON.stringify({ data, has_more: false }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={[`/agents/${agent.id}`]}>
            <Routes><Route path="/agents/:id" element={<Sidebar />} /></Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("link", { name: "Main task" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Delegated task" })).toBeNull();
    expect(screen.queryByText("terminated")).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).searchParams.get("exclude_delegated") === "true")).toBe(true);
  });

  it.each([
    ["chats", "running"],
    ["workspace", "waiting"],
  ] as const)("moves a live %s Session to the top when it becomes %s", async (group, status) => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const agent: Agent = {
      id: "agent_live",
      tenantId: "tenant_1",
      name: "Live Agent",
      model: "test/model",
      system: "test",
      runtime: "pi-agent",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const session: Session = {
      id: "session_live",
      agentId: agent.id,
      status: "idle",
      title: "Current chat",
      workspaceId: "workspace_live",
      agent: {
        id: agent.id,
        name: agent.name,
        model: agent.model,
        runtime: agent.runtime,
      },
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
      },
    });
    const sibling: Session = { ...session, id: "session_sibling", title: "Previous chat" };
    queryClient.setQueryData(["sessions", session.id], session);
    queryClient.setQueryData(["sessions", "byAgent", agent.id, "parents"], [sibling, session]);
    queryClient.setQueryData(["agents", agent.id], agent);
    queryClient.setQueryData(["agents", agent.id, "skills"], []);
    queryClient.setQueryData(["loops", "byAgent", agent.id], []);
    queryClient.setQueryData(["workspaces"], group === "workspace" ? [{
      id: session.workspaceId, name: "Live workspace", tenantId: "tenant_1", createdAt: session.createdAt,
    }] : []);

    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.Accept === "application/json") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ data: [] }),
          } as Response);
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (String(_input).includes(`/sessions/${session.id}/events`)) {
              streamController = controller;
            }
            controller.enqueue(
              new TextEncoder().encode(
                `event: session.status_${status}\nid: 1\ndata: {}\n\n`,
              ),
            );
            init?.signal?.addEventListener(
              "abort",
              () => controller.close(),
              { once: true },
            );
          },
        });
        return Promise.resolve({ ok: true, body } as Response);
      }),
    );

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={[`/sessions/${session.id}`]}>
            <Routes>
              <Route
                path="/sessions/:id"
                element={
                  <>
                    <Sidebar />
                    <SessionDetailPage />
                  </>
                }
              />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    if (group === "workspace") {
      fireEvent.click(within(screen.getByRole("complementary", { name: "Console sidebar" }))
        .getByRole("button", { name: "Live workspace" }));
    }
    const activeLink = await screen.findByRole("link", { name: `${session.title}Session running` });
    const siblingLink = screen.getByRole("link", { name: sibling.title });
    expect(activeLink.compareDocumentPosition(siblingLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(queryClient.getQueryData<Session[]>(["sessions", "byAgent", agent.id, "parents"])?.map((s) => s.id))
      .toEqual([sibling.id, session.id]);

    streamController.enqueue(new TextEncoder().encode("event: session.status_idle\nid: 2\ndata: {}\n\n"));
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: `${session.title}Session running` })).toBeNull();
      expect(siblingLink.compareDocumentPosition(activeLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it("does not let an older in-flight Session list overwrite live status", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const agent: Agent = {
      id: "agent_race",
      tenantId: "tenant_1",
      name: "Race Agent",
      model: "test/model",
      system: "test",
      runtime: "pi-agent",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const idleSession: Session = {
      id: "session_race",
      agentId: agent.id,
      status: "idle",
      title: "Racing chat",
      workspaceId: "workspace_race",
      agent: {
        id: agent.id,
        name: agent.name,
        model: agent.model,
        runtime: agent.runtime,
      },
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
      },
    });
    queryClient.setQueryData(["sessions", idleSession.id], idleSession);
    queryClient.setQueryData(["agents", agent.id], agent);
    queryClient.setQueryData(["agents", agent.id, "skills"], []);
    queryClient.setQueryData(["loops", "byAgent", agent.id], []);
    queryClient.setQueryData(["workspaces"], []);

    let resolveOlderList!: (response: Response) => void;
    const olderList = new Promise<Response>((resolve) => {
      resolveOlderList = resolve;
    });
    let listRequests = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      if (url.includes(`/v1/sessions?agent_id=${agent.id}`)) {
        listRequests++;
        if (listRequests === 1) return olderList;
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            data: [{ ...idleSession, status: "running" }],
          }),
        } as Response);
      }
      if (headers?.Accept === "application/json") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: [] }),
        } as Response);
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            "event: session.status_running\nid: 1\ndata: {}\n\n",
          ));
          init?.signal?.addEventListener(
            "abort",
            () => controller.close(),
            { once: true },
          );
        },
      });
      return Promise.resolve({ ok: true, body } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={[`/sessions/${idleSession.id}`]}>
            <Routes>
              <Route
                path="/sessions/:id"
                element={
                  <>
                    <Sidebar />
                    <SessionDetailPage />
                  </>
                }
              />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(listRequests).toBe(1));
    expect((await screen.findAllByRole("img", { name: "Session running" })).length).toBeGreaterThan(0);
    resolveOlderList({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [idleSession] }),
    } as Response);

    expect(await screen.findByRole("link", {
      name: `${idleSession.title}Session running`,
    })).toBeTruthy();
    expect(listRequests).toBeGreaterThanOrEqual(2);
  });

  it("nests and paginates Loop-created Sessions under their Loop instead of loose Sessions", async () => {
    const agent: Agent = {
      id: "agent_loop",
      tenantId: "tenant_1",
      name: "Session Analyst",
      model: "test/model",
      system: "test",
      runtime: "pi-agent",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const loop = {
      id: "loop_weekly",
      tenantId: "tenant_1",
      agentId: agent.id,
      name: "Weekly Session Review",
      prompt: "Analyze Sessions",
      intervalMinutes: 5,
      enabled: true,
      nextRunAt: "2026-07-14T00:05:00.000Z",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const sessionAgent = {
      id: agent.id,
      name: agent.name,
      model: agent.model,
      runtime: agent.runtime,
    };
    const scheduled: Session = {
      id: "session_scheduled",
      agentId: agent.id,
      loopId: loop.id,
      status: "idle",
      title: "Scheduled Review",
      workspaceId: "workspace_scheduled",
      agent: sessionAgent,
      createdAt: "2026-07-14T00:05:00.000Z",
      updatedAt: "2026-07-14T00:05:00.000Z",
    };
    const loose: Session = {
      ...scheduled,
      id: "session_loose",
      loopId: undefined,
      title: "Loose Session",
      workspaceId: "workspace_loose",
    };
    const olderScheduled: Session = {
      ...scheduled,
      id: "session_scheduled_older",
      status: "running",
      title: "Older Scheduled Review",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
      },
    });
    queryClient.setQueryData(["agents", agent.id], agent);
    queryClient.setQueryData(["sessions", "byAgent", agent.id, "parents"], [scheduled, loose]);
    queryClient.setQueryData(["sessions", "byLoop", loop.id, "parents"], {
      pages: [{
        data: [scheduled],
        has_more: true,
        next_cursor: scheduled.id,
      }],
      pageParams: [undefined],
    });
    queryClient.setQueryData(["loops", "byAgent", agent.id], [loop]);
    queryClient.setQueryData(["workspaces"], []);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/v1/loops/${loop.id}`) && init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ...loop, enabled: false }),
        } as Response;
      }
      if (url.endsWith(`/v1/loops/${loop.id}/run`) && init?.method === "POST") {
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify(olderScheduled),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [olderScheduled],
          has_more: false,
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={[`/agents/${agent.id}`]}>
            <Routes>
              <Route path="/agents/:id" element={<Sidebar />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    const agentLink = screen.getByRole("link", { name: agent.name });
    const loopsToggle = screen.getByRole("button", { name: "loops" });
    expect(
      agentLink.compareDocumentPosition(loopsToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Scheduled Review" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: loop.name }));
    expect(screen.getAllByRole("link", { name: "Scheduled Review" })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Loose Session" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Load older Sessions" }));
    expect(
      await screen.findByRole("link", { name: "Older Scheduled ReviewSession running" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Older Scheduled ReviewSession running" })
      .compareDocumentPosition(screen.getByRole("link", { name: "Scheduled Review" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole("button", {
      name: `Loop actions for ${loop.name}`,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Pause Loop" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).endsWith(`/v1/loops/${loop.id}`)
      && init?.method === "POST"
      && String(init.body) === JSON.stringify({ enabled: false })
    )).toBe(true));
    expect(await screen.findByText("paused")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", {
      name: `Loop actions for ${loop.name}`,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Start now" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).endsWith(`/v1/loops/${loop.id}/run`)
      && init?.method === "POST"
    )).toBe(true));
  });

  it.each(["chats", "workspace"])("keeps the Agent context when creating a Session from the %s shortcut", async (group) => {
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
      workspaceId: group === "workspace" ? workspace.id : "workspace_created",
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
      },
    });
    queryClient.setQueryData(["sessions", sourceSession.id], sourceSession);
    queryClient.setQueryData(
      ["sessions", "byAgent", agent.id, "parents"],
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
      screen.getByRole("link", { name: `${targetSession.title}` }),
    );

    expect(screen.getByLabelText("Current path").textContent).toBe(
      `/sessions/${targetSession.id}`,
    );
    expect(screen.getByRole("link", { name: agent.name })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: `${targetSession.title}` }),
    ).toBeTruthy();

    if (group === "workspace") {
      fireEvent.click(screen.getByRole("button", { name: workspace.name }));
      expect(screen.queryByRole("link", { name: targetSession.title })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: `New session in ${workspace.name}` }));
      expect(screen.getByRole("link", { name: targetSession.title })).toBeTruthy();
      await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) =>
        String(input).endsWith("/v1/sessions") && init?.method === "POST"
        && init.body === JSON.stringify({ agent: agent.id, workspace_id: workspace.id }),
      )).toBe(true));
    } else {
      fireEvent.click(within(screen.getByTitle("New chat")).getByRole("button"));
    }

    await waitFor(() =>
      expect(screen.getByLabelText("Current path").textContent).toBe(
        `/sessions/${createdSession.id}`,
      ),
    );
    expect(screen.getByRole("link", { name: agent.name })).toBeTruthy();
  });
});
