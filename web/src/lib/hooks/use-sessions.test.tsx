// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { useAgentSessions, useLoopSessions, useLooseSessions, useSessions, useWorkspaceSessions } from "./use-sessions";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
const fetchMock = vi.mocked(apiFetch);
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe("Session list filters", () => {
  it("keeps Workspace and loose Session pagination independent and loads a Workspace only when expanded", async () => {
    fetchMock.mockImplementation(async (path) => {
      const url = new URL(path, "http://localhost");
      const group = url.searchParams.get("workspace_id") ?? "loose";
      const next = url.searchParams.has("cursor");
      return { data: [{ id: `${group}_${next ? 2 : 1}` }], has_more: !next, next_cursor: next ? undefined : `${group}_1` };
    });
    const { wrapper } = setup();
    const { result, rerender } = renderHook(({ expanded }) => ({
      a: useWorkspaceSessions("agent_1", "workspace_a", expanded),
      b: useWorkspaceSessions("agent_1", "workspace_b", true),
      loose: useLooseSessions("agent_1"),
    }), { wrapper, initialProps: { expanded: false } });
    await waitFor(() => expect(result.current.loose.isSuccess).toBe(true));
    expect(result.current.a.data).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    rerender({ expanded: true });
    await waitFor(() => expect(result.current.a.isSuccess).toBe(true));
    await act(async () => { await result.current.a.fetchNextPage(); });
    await waitFor(() => expect(result.current.a.data).toEqual([{ id: "workspace_a_1" }, { id: "workspace_a_2" }]));
    expect(result.current.b.data).toEqual([{ id: "workspace_b_1" }]);
    expect(result.current.loose.data).toEqual([{ id: "loose_1" }]);
    expect(result.current.a.hasNextPage).toBe(false);
    expect(result.current.b.hasNextPage).toBe(true);
    expect(result.current.loose.hasNextPage).toBe(true);
    await act(async () => { await result.current.loose.fetchNextPage(); });
    await waitFor(() => expect(result.current.loose.data).toEqual([{ id: "loose_1" }, { id: "loose_2" }]));
    expect(fetchMock.mock.calls.map(([url]) => Object.fromEntries(new URL(url, "http://localhost").searchParams))).toEqual([
      { agent_id: "agent_1", workspace_id: "workspace_b", order: "updated_at", exclude_loop: "true", exclude_delegated: "true", limit: "5" },
      { agent_id: "agent_1", order: "updated_at", exclude_loop: "true", exclude_delegated: "true", exclude_named_workspaces: "true", limit: "5" },
      { agent_id: "agent_1", workspace_id: "workspace_a", order: "updated_at", exclude_loop: "true", exclude_delegated: "true", limit: "5" },
      { agent_id: "agent_1", workspace_id: "workspace_a", order: "updated_at", exclude_loop: "true", exclude_delegated: "true", limit: "20", cursor: "workspace_a_1" },
      { agent_id: "agent_1", order: "updated_at", exclude_loop: "true", exclude_delegated: "true", exclude_named_workspaces: "true", limit: "20", cursor: "loose_1" },
    ]);
  });

  it.each([false, true])("loads every Agent page on demand with excludeDelegated=%s", async (excludeDelegated) => {
    fetchMock.mockResolvedValueOnce({ data: [{ id: "first" }], has_more: true, next_cursor: "first / cursor" });
    fetchMock.mockResolvedValueOnce({ data: [{ id: "second" }], has_more: true, next_cursor: "second" });
    fetchMock.mockResolvedValueOnce({ data: [{ id: "last" }], has_more: false });
    const { wrapper } = setup();
    const { result } = renderHook(() => useAgentSessions("agent_1", { excludeDelegated }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ id: "first" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => { await result.current.fetchNextPage(); });
    await waitFor(() => expect(result.current.data).toEqual([{ id: "first" }, { id: "second" }]));
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => { await result.current.fetchNextPage(); });
    await waitFor(() => expect(result.current.data).toEqual([{ id: "first" }, { id: "second" }, { id: "last" }]));
    expect(result.current.hasNextPage).toBe(false);
    const filter = excludeDelegated ? "&exclude_delegated=true" : "";
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/v1/sessions?agent_id=agent_1&exclude_loop=true&limit=50${filter}`,
      `/v1/sessions?agent_id=agent_1&exclude_loop=true&limit=50&cursor=first%20%2F%20cursor${filter}`,
      `/v1/sessions?agent_id=agent_1&exclude_loop=true&limit=50&cursor=second${filter}`,
    ]);
  });

  it("keeps loaded Agent Sessions after a page failure and retries the same cursor", async () => {
    fetchMock.mockResolvedValueOnce({ data: [{ id: "first" }], has_more: true, next_cursor: "first" });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    fetchMock.mockResolvedValueOnce({ data: [{ id: "last" }], has_more: false });
    const { wrapper } = setup();
    const { result } = renderHook(() => useAgentSessions("agent_1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => { await result.current.fetchNextPage(); });
    await waitFor(() => expect(result.current.isFetchNextPageError).toBe(true));
    expect(result.current.data).toEqual([{ id: "first" }]);
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => { await result.current.fetchNextPage(); });
    await waitFor(() => expect(result.current.data).toEqual([{ id: "first" }, { id: "last" }]));
    expect(result.current.hasNextPage).toBe(false);
    expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[2][0]);
  });

  it("keeps parent-only and unfiltered lists in separate caches", async () => {
    fetchMock.mockImplementation(async (url) => ({
      data: [{ id: url.includes("exclude_delegated=true") ? "parent" : "child" }], has_more: false,
    }));
    const { wrapper, client } = setup();
    const { result } = renderHook(() => ({
      all: useSessions(),
      parents: useSessions(undefined, { excludeDelegated: true }),
      agent: useAgentSessions("agent_1", { excludeDelegated: true }),
    }), { wrapper });
    await waitFor(() => expect(result.current.agent.isSuccess).toBe(true));
    expect(result.current.all.data).toEqual([{ id: "child" }]);
    expect(result.current.parents.data).toEqual([{ id: "parent" }]);
    expect(client.getQueryData(["sessions", "all"])).toEqual([{ id: "child" }]);
    expect(client.getQueryData(["sessions", "all", "parents"])).toEqual([{ id: "parent" }]);
    expect(client.getQueryData(["sessions", "byAgent", "agent_1", "parents"])).toEqual({
      pages: [{ data: [{ id: "parent" }], has_more: false }], pageParams: [undefined],
    });
    expect(fetchMock).toHaveBeenCalledWith("/v1/sessions?agent_id=agent_1&exclude_loop=true&limit=50&exclude_delegated=true", expect.anything());
  });

  it("preserves the filter on every Loop page", async () => {
    fetchMock.mockResolvedValueOnce({ data: [{ id: "parent_1" }], has_more: true, next_cursor: "parent_1" });
    fetchMock.mockResolvedValueOnce({ data: [{ id: "parent_2" }], has_more: false });
    const { wrapper, client } = setup();
    const { result } = renderHook(() => useLoopSessions("loop_1", true, { excludeDelegated: true }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => { await result.current.fetchNextPage(); });
    await waitFor(() => expect(result.current.data).toEqual([{ id: "parent_1" }, { id: "parent_2" }]));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/v1/sessions?loop_id=loop_1&limit=50&exclude_delegated=true",
      "/v1/sessions?loop_id=loop_1&limit=50&cursor=parent_1&exclude_delegated=true",
    ]);
    expect(client.getQueryData(["sessions", "byLoop", "loop_1", "parents"])).toBeDefined();
  });

  it("retains default Agent and Loop query keys and requests", async () => {
    fetchMock.mockResolvedValue({ data: [], has_more: false });
    const { wrapper, client } = setup();
    const { result } = renderHook(() => ({ agent: useAgentSessions("agent_1"), loop: useLoopSessions("loop_1") }), { wrapper });
    await waitFor(() => expect(result.current.loop.isSuccess).toBe(true));
    expect(client.getQueryData(["sessions", "byAgent", "agent_1"])).toEqual({
      pages: [{ data: [], has_more: false }], pageParams: [undefined],
    });
    expect(client.getQueryData(["sessions", "byLoop", "loop_1"])).toBeDefined();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/v1/sessions?agent_id=agent_1&exclude_loop=true&limit=50", "/v1/sessions?loop_id=loop_1&limit=50",
    ]);
  });
});
