// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { useAgentSessions, useLoopSessions, useSessions } from "./use-sessions";

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
    expect(client.getQueryData(["sessions", "byAgent", "agent_1", "parents"])).toEqual([{ id: "parent" }]);
    expect(fetchMock).toHaveBeenCalledWith("/v1/sessions?agent_id=agent_1&exclude_loop=true&exclude_delegated=true", expect.anything());
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
    expect(client.getQueryData(["sessions", "byAgent", "agent_1"])).toEqual([]);
    expect(client.getQueryData(["sessions", "byLoop", "loop_1"])).toBeDefined();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/v1/sessions?agent_id=agent_1&exclude_loop=true", "/v1/sessions?loop_id=loop_1&limit=50",
    ]);
  });
});
