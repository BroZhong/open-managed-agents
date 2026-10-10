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
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
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
  it("orders Workspace Sessions by modification time across loaded pages, regardless of creation time or status", () => {
    const agent = { id: "agent_recency", name: "Recency Agent" };
    const workspace = { id: "workspace_recency", name: "Project Recency" };
    const session = {
      agentId: agent.id, workspaceId: workspace.id, status: "idle",
      createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const newestCreated = { ...session, id: "session_new", title: "Newly created" };
    const running = {
      ...session, id: "session_running", title: "Older running", status: "running",
      createdAt: "2026-07-12T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z",
    };
    const recentlyModified = {
      ...session, id: "session_recent", title: "Recently modified",
      createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-15T00:00:00.000Z",
    };
    const sameTime = { ...recentlyModified, id: "session_tie", title: "Same modification time" };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false, staleTime: Infinity } },
    });
    const pages = [
      { data: [newestCreated, running], has_more: true, next_cursor: "cursor" },
      { data: [recentlyModified, sameTime], has_more: false },
    ];
    queryClient.setQueryData(["agents", agent.id], agent);
    queryClient.setQueryData(["workspaces", "byAgent", agent.id], [workspace]);
    queryClient.setQueryData(["loops", "byAgent", agent.id], []);
    queryClient.setQueryData(["sessions", "byAgent", agent.id, "workspace", workspace.id, "parents"], {
      pages, pageParams: [undefined, "cursor"],
    });
    queryClient.setQueryData(["sessions", "byAgent", agent.id, "loose", "parents"], {
      pages: [{ data: [], has_more: false }], pageParams: [undefined],
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={[`/agents/${agent.id}`]}>
            <Routes><Route path="/agents/:id" element={<Sidebar />} /></Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    const group = within(screen.getByRole("group", { name: `Workspace ${workspace.name}` }));
    fireEvent.click(group.getByRole("button", { name: workspace.name }));
    expect(group.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(
      [sameTime, recentlyModified, newestCreated, running].map((item) => `/sessions/${item.id}`),
    );
    expect(pages.flatMap((page) => page.data.map((item) => item.id))).toEqual(
      [newestCreated, running, recentlyModified, sameTime].map((item) => item.id),
    );
  });

  it("loads five Sessions initially and twenty more per Workspace independently from other Workspaces and chats", async () => {
    const agent = { id: "agent_pages", name: "Paginated Agent" };
    const workspaces = [
      { id: "workspace_alpha", name: "Project Alpha" },
      { id: "workspace_beta", name: "Project Beta" },
    ];
    const sessions = (group: string, workspaceId: string) => Array.from({ length: 25 }, (_, index) => ({
      id: `session_${group}_${index}`, agentId: agent.id, title: `${group} Session ${index + 1}`,
      status: "idle", workspaceId,
    }));
    const alpha = sessions("Alpha", workspaces[0].id);
    const beta = sessions("Beta", workspaces[1].id);
    const chats = sessions("Chat", "workspace_anonymous");
    const cursor = "session_older/+?=&";
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(["agents", agent.id], agent);
    queryClient.setQueryData(["workspaces", "byAgent", agent.id], workspaces);
    queryClient.setQueryData(["loops", "byAgent", agent.id], []);
    let resolveNextPage!: (response: Response) => void;
    const nextPage = new Promise<Response>((resolve) => { resolveNextPage = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const workspaceId = url.searchParams.get("workspace_id");
      if (workspaceId === workspaces[0].id && url.searchParams.has("cursor")) return nextPage;
      const groupSessions = workspaceId === workspaces[0].id ? alpha : workspaceId === workspaces[1].id ? beta : chats;
      return Promise.resolve({
        ok: true,
        text: async () => JSON.stringify({ data: groupSessions.slice(0, 5), has_more: true, next_cursor: cursor }),
      } as Response);
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

    const alphaGroup = within(screen.getByRole("group", { name: "Workspace Project Alpha" }));
    const betaGroup = within(screen.getByRole("group", { name: "Workspace Project Beta" }));
    const chatsGroup = within(screen.getByRole("group", { name: "Chats" }));
    await chatsGroup.findByRole("button", { name: "Show more" });
    expect(chatsGroup.getAllByRole("link")).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("exclude_named_workspaces")).toBe("true");

    fireEvent.click(alphaGroup.getByRole("button", { name: workspaces[0].name }));
    await alphaGroup.findByRole("button", { name: "Show more" });
    expect(alphaGroup.getAllByRole("link")).toHaveLength(5);
    expect(betaGroup.queryAllByRole("link")).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([input]) => new URL(String(input)).searchParams.get("workspace_id") !== workspaces[1].id)).toBe(true);

    fireEvent.click(betaGroup.getByRole("button", { name: workspaces[1].name }));
    await betaGroup.findByRole("button", { name: "Show more" });
    expect(betaGroup.getAllByRole("link")).toHaveLength(5);
    fireEvent.click(alphaGroup.getByRole("button", { name: "Show more" }));
    const loading = await alphaGroup.findByRole("button", { name: "Loading…" });
    expect((loading as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(loading);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(alphaGroup.getAllByRole("link")).toHaveLength(5);
    expect(betaGroup.getByRole("button", { name: "Show more" })).toBeTruthy();
    expect(chatsGroup.getByRole("button", { name: "Show more" })).toBeTruthy();
    for (const [input] of fetchMock.mock.calls) {
      const params = new URL(String(input)).searchParams;
      expect(params.get("agent_id")).toBe(agent.id);
      expect(params.get("limit")).toBe(params.has("cursor") ? "20" : "5");
      expect(params.get("exclude_loop")).toBe("true");
      expect(params.get("exclude_delegated")).toBe("true");
      expect(params.get("order")).toBe(params.has("workspace_id") ? "updated_at" : null);
    }
    expect(new URL(String(fetchMock.mock.calls[3][0])).searchParams.get("cursor")).toBe(cursor);
    expect(new URL(String(fetchMock.mock.calls[3][0])).searchParams.get("workspace_id")).toBe(workspaces[0].id);

    resolveNextPage({
      ok: true,
      text: async () => JSON.stringify({ data: alpha.slice(5), has_more: false }),
    } as Response);
    await alphaGroup.findByRole("link", { name: alpha[24].title });
    expect(alphaGroup.getAllByRole("link")).toHaveLength(25);
    expect(alphaGroup.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(alphaGroup.queryByRole("button", { name: "Loading…" })).toBeNull();
    expect(betaGroup.getAllByRole("link")).toHaveLength(5);
    expect(chatsGroup.getAllByRole("link")).toHaveLength(5);
    fireEvent.click(alphaGroup.getByRole("button", { name: workspaces[0].name }));
    fireEvent.click(alphaGroup.getByRole("button", { name: workspaces[0].name }));
    expect(alphaGroup.getAllByRole("link")).toHaveLength(25);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each(["workspace", "chats"])("keeps pagination failures and retries inside the %s group", async (group) => {
    const agent = { id: "agent_retry", name: "Retry Agent" };
    const workspace = { id: "workspace_retry", name: "Project Retry" };
    const current = {
      id: "session_current", agentId: agent.id, title: "Current Session",
      status: "idle", workspaceId: group === "workspace" ? workspace.id : "workspace_anonymous",
    };
    const other = { ...current, id: "session_other", title: "Other group Session" };
    const older = { ...current, id: "session_older", title: "Older Session" };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(["agents", agent.id], agent);
    queryClient.setQueryData(["workspaces", "byAgent", agent.id], [workspace]);
    queryClient.setQueryData(["loops", "byAgent", agent.id], []);
    let nextPageAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (!url.searchParams.has("cursor")) {
        const isCurrentGroup = (url.searchParams.has("workspace_id") ? "workspace" : "chats") === group;
        return {
          ok: true,
          text: async () => JSON.stringify({ data: [isCurrentGroup ? current : other], has_more: true, next_cursor: current.id }),
        } as Response;
      }
      if (++nextPageAttempts === 1) {
        return { ok: false, status: 503, json: async () => ({ message: "Try again" }) } as Response;
      }
      return {
        ok: true,
        text: async () => JSON.stringify({ data: [older], has_more: false }),
      } as Response;
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

    fireEvent.click(screen.getByRole("button", { name: workspace.name }));
    const currentGroup = within(screen.getByRole("group", { name: group === "workspace" ? "Workspace Project Retry" : "Chats" }));
    const otherGroup = within(screen.getByRole("group", { name: group === "workspace" ? "Chats" : "Workspace Project Retry" }));
    fireEvent.click(await currentGroup.findByRole("button", { name: "Show more" }));
    expect(await currentGroup.findByRole("alert")).toBeTruthy();
    expect(currentGroup.getByRole("link", { name: current.title })).toBeTruthy();
    expect(otherGroup.queryByRole("alert")).toBeNull();
    expect(otherGroup.getByRole("button", { name: "Show more" })).toBeTruthy();
    fireEvent.click(currentGroup.getByRole("button", { name: "Retry" }));
    expect(await currentGroup.findByRole("link", { name: older.title })).toBeTruthy();
    expect(currentGroup.getByRole("link", { name: current.title })).toBeTruthy();
    expect(currentGroup.queryByRole("alert")).toBeNull();
    expect(currentGroup.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(currentGroup.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(otherGroup.getAllByRole("link")).toHaveLength(1);
    expect(otherGroup.getByRole("button", { name: "Show more" })).toBeTruthy();
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("cursor")).filter(Boolean))
      .toEqual([current.id, current.id]);
  });

  it("leaves a deleted Workspace when the active Session is beyond its loaded page", async () => {
    const agent = { id: "agent_delete", name: "Delete Agent" };
    const workspace = { id: "workspace_delete", name: "Project Delete" };
    const active = {
      id: "session_beyond_first_page", agentId: agent.id, title: "Active older Session",
      status: "idle", workspaceId: workspace.id,
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(["agents", agent.id], agent);
    queryClient.setQueryData(["sessions", active.id], active);
    queryClient.setQueryData(["workspaces", "byAgent", agent.id], [workspace]);
    queryClient.setQueryData(["loops", "byAgent", agent.id], []);
    queryClient.setQueryData(["sessions", "byAgent", agent.id, "loose", "parents"], {
      pages: [{ data: [], has_more: false }], pageParams: [undefined],
    });
    queryClient.setQueryData(["sessions", "byAgent", agent.id, "workspace", workspace.id, "parents"], {
      pages: [{ data: [{ ...active, id: "session_first_page", title: "Recent Session" }], has_more: true, next_cursor: "session_first_page" }],
      pageParams: [undefined],
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      text: async () => JSON.stringify(init?.method === "DELETE"
        ? { type: "workspace", id: workspace.id }
        : String(input).endsWith(`/sessions/${active.id}`) ? active : { data: [], has_more: false }),
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={[`/sessions/${active.id}`]}>
            <Routes>
              <Route path="/sessions/:id" element={<SessionRoute />} />
              <Route path="/agents/:id" element={<SessionRoute />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    const project = within(screen.getByRole("group", { name: "Workspace Project Delete" }));
    fireEvent.click(project.getByRole("button", { name: workspace.name }));
    expect(project.getByRole("link", { name: "Recent Session" })).toBeTruthy();
    expect(project.queryByRole("link", { name: active.title })).toBeNull();
    fireEvent.click(project.getByRole("button", { name: "Workspace actions" }));
    fireEvent.click(project.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(screen.getByLabelText("Current path").textContent).toBe(`/agents/${agent.id}`));
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith(`/workspaces/${workspace.id}`) && init?.method === "DELETE")).toBe(true);
  });

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
    queryClient.setQueryData(["sessions", "byAgent", agent.id], {
      pages: [{ data: [child, parent], has_more: false }], pageParams: [undefined],
    });
    queryClient.setQueryData(["workspaces", "byAgent", agent.id], []);
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
    if (group === "workspace") queryClient.setQueryData(["sessions", "byAgent", agent.id, "loose", "parents"], {
      pages: [{ data: [], has_more: false }], pageParams: [undefined],
    });
    queryClient.setQueryData(["sessions", session.id], session);
    queryClient.setQueryData(["sessions", "byAgent", agent.id, ...(group === "workspace" ? ["workspace", session.workspaceId] : ["loose"]), "parents"], {
      pages: [{ data: [sibling, session], has_more: false }], pageParams: [undefined],
    });
    queryClient.setQueryData(["agents", agent.id], agent);
    queryClient.setQueryData(["agents", agent.id, "skills"], []);
    queryClient.setQueryData(["loops", "byAgent", agent.id], []);
    queryClient.setQueryData(["workspaces", "byAgent", agent.id], group === "workspace" ? [{
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
                `event: session.status_${status}\nid: 1\ndata: {"ts":"2026-07-14T01:00:00.000Z","data":{}}\n\n`,
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
    expect(queryClient.getQueryData<InfiniteData<{ data: Session[] }>>(["sessions", "byAgent", agent.id, ...(group === "workspace" ? ["workspace", session.workspaceId] : ["loose"]), "parents"])
      ?.pages.flatMap((page) => page.data.map((session) => session.id)))
      .toEqual([sibling.id, session.id]);

    streamController.enqueue(new TextEncoder().encode('event: session.status_idle\nid: 2\ndata: {"ts":"2026-07-14T02:00:00.000Z","data":{}}\n\n'));
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: `${session.title}Session running` })).toBeNull();
      const [first, second] = group === "workspace" ? [activeLink, siblingLink] : [siblingLink, activeLink];
      expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    queryClient.setQueryData(["workspaces", "byAgent", agent.id], []);

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
    queryClient.setQueryData(["sessions", "byAgent", agent.id, "loose", "parents"], {
      pages: [{ data: [scheduled, loose], has_more: false }], pageParams: [undefined],
    });
    queryClient.setQueryData(["sessions", "byLoop", loop.id, "parents"], {
      pages: [{
        data: [scheduled],
        has_more: true,
        next_cursor: scheduled.id,
      }],
      pageParams: [undefined],
    });
    queryClient.setQueryData(["loops", "byAgent", agent.id], [loop]);
    queryClient.setQueryData(["workspaces", "byAgent", agent.id], []);
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
      ["sessions", "byAgent", agent.id, "workspace", workspace.id, "parents"],
      { pages: [{ data: [sourceSession, targetSession], has_more: false }], pageParams: [undefined] },
    );
    queryClient.setQueryData(["workspaces", "byAgent", agent.id], [workspace]);
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
