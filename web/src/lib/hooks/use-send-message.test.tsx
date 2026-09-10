// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useQueuedInput } from "@/lib/hooks/use-queued-input";
import { useSendMessage } from "@/lib/hooks/use-send-message";

const clients: QueryClient[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function setupQueryClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, wrapper };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function queuedResponse(...ids: string[]) {
  return jsonResponse({
    count: ids.length,
    has_more: false,
    data: ids.map((id) => ({
      id,
      type: "user.message",
      data: { content: [{ type: "text", text: `Host input ${id}` }] },
      arrived_at: "2026-09-10T00:00:00.000Z",
    })),
  });
}

it("refreshes all of the Session's queue lifecycle keys only after the Host accepts input", async () => {
  const accepted = deferred<Response>();
  let hostAccepted = false;
  let queueReads = 0;
  vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return accepted.promise;
    queueReads++;
    return Promise.resolve(queuedResponse(...(hostAccepted ? ["existing", "accepted"] : ["existing"])));
  }));
  const { client, wrapper } = setupQueryClient();
  // Even an inactive lifecycle key must become stale so revisiting it cannot
  // treat the pre-acceptance queue as current.
  const inactiveKey = ["sessions", "sess_1", "pending", 12];
  client.setQueryData(inactiveKey, { entries: [], hasMore: false });
  const { result } = renderHook(() => ({
    sender: useSendMessage("sess_1"),
    first: useQueuedInput("sess_1", 0),
    later: useQueuedInput("sess_1", 7),
  }), { wrapper });
  await waitFor(() => expect(result.current.later.entries.map((entry) => entry.id)).toEqual(["existing"]));
  expect(queueReads).toBe(2);

  let sending!: Promise<void>;
  act(() => { sending = result.current.sender.send("new input"); });
  expect(result.current.sender.isPending).toBe(true);
  expect(queueReads).toBe(2);
  expect(result.current.first.entries.map((entry) => entry.id)).toEqual(["existing"]);
  expect(client.getQueryState(inactiveKey)?.isInvalidated).toBe(false);

  await act(async () => {
    hostAccepted = true;
    accepted.resolve(jsonResponse({}, 202));
    await sending;
  });
  await waitFor(() => {
    expect(result.current.first.entries.map((entry) => entry.id)).toEqual(["existing", "accepted"]);
    expect(result.current.later.entries.map((entry) => entry.id)).toEqual(["existing", "accepted"]);
  });
  expect(queueReads).toBe(4);
  expect(client.getQueryState(inactiveKey)?.isInvalidated).toBe(true);
  expect(result.current.sender.isPending).toBe(false);
});

it("keeps the queue empty when accepted input is already claimed by a Turn", async () => {
  let queueReads = 0;
  vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return Promise.resolve(jsonResponse({}, 202));
    queueReads++;
    return Promise.resolve(queuedResponse());
  }));
  const { wrapper } = setupQueryClient();
  const { result } = renderHook(() => ({
    sender: useSendMessage("sess_1"),
    queue: useQueuedInput("sess_1", 0),
  }), { wrapper });
  await waitFor(() => expect(queueReads).toBe(1));

  await act(async () => { await result.current.sender.send("already executing"); });

  await waitFor(() => expect(queueReads).toBe(2));
  expect(result.current.queue).toEqual({ entries: [], hasMore: false });
});

it("does not refresh or fabricate Queued Input when the Host rejects a send", async () => {
  let queueReads = 0;
  vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve(jsonResponse({ error: "Session is terminated" }, 410));
    }
    queueReads++;
    return Promise.resolve(queuedResponse("existing"));
  }));
  const { wrapper } = setupQueryClient();
  const { result } = renderHook(() => ({
    sender: useSendMessage("sess_1"),
    queue: useQueuedInput("sess_1", 0),
  }), { wrapper });
  await waitFor(() => expect(result.current.queue.entries).toHaveLength(1));

  await act(async () => {
    await expect(result.current.sender.send("rejected input")).rejects.toThrow("Session is terminated");
  });

  expect(queueReads).toBe(1);
  expect(result.current.queue.entries.map((entry) => entry.id)).toEqual(["existing"]);
  expect(result.current.sender.isPending).toBe(false);
});

it("refreshes only the original Session when its send is accepted after navigation", async () => {
  const accepted = deferred<Response>();
  let hostAccepted = false;
  const queueReads: Record<string, number> = {};
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return accepted.promise;
    const sessionId = String(input).match(/\/sessions\/([^/]+)\//)![1];
    queueReads[sessionId] = (queueReads[sessionId] ?? 0) + 1;
    return Promise.resolve(queuedResponse(...(sessionId === "sess_1" && hostAccepted ? ["accepted"] : [])));
  });
  vi.stubGlobal("fetch", fetchMock);
  const { wrapper } = setupQueryClient();
  const { result, rerender } = renderHook(({ sessionId }) => ({
    sender: useSendMessage(sessionId),
    first: useQueuedInput("sess_1", 0),
    second: useQueuedInput("sess_2", 0),
  }), { wrapper, initialProps: { sessionId: "sess_1" } });
  await waitFor(() => expect(queueReads).toEqual({ sess_1: 1, sess_2: 1 }));

  let sending!: Promise<void>;
  act(() => { sending = result.current.sender.send("only for the first Session"); });
  rerender({ sessionId: "sess_2" });
  await act(async () => {
    hostAccepted = true;
    accepted.resolve(jsonResponse({}, 202));
    await sending;
  });

  await waitFor(() => expect(result.current.first.entries.map((entry) => entry.id)).toEqual(["accepted"]));
  expect(queueReads).toEqual({ sess_1: 2, sess_2: 1 });
  expect(result.current.second).toEqual({ entries: [], hasMore: false });
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
  expect(String(post?.[0])).toContain("/sessions/sess_1/events");
});

it("replaces a queue read begun before acceptance and ignores its late stale response", async () => {
  const staleRead = deferred<Response>();
  let staleSignal: AbortSignal | null | undefined;
  let queueReads = 0;
  vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return Promise.resolve(jsonResponse({}, 202));
    queueReads++;
    if (queueReads === 1) {
      staleSignal = init?.signal;
      // Deliberately ignore abort at the transport seam: query cancellation
      // must discard this response even if it finishes after the replacement.
      return staleRead.promise;
    }
    return Promise.resolve(queuedResponse("accepted"));
  }));
  const { wrapper } = setupQueryClient();
  const { result } = renderHook(() => ({
    sender: useSendMessage("sess_1"),
    queue: useQueuedInput("sess_1", 0),
  }), { wrapper });
  await waitFor(() => expect(queueReads).toBe(1));
  expect(result.current.queue.entries).toEqual([]);

  await act(async () => { await result.current.sender.send("accepted input"); });

  await waitFor(() => expect(result.current.queue.entries.map((entry) => entry.id)).toEqual(["accepted"]));
  expect(queueReads).toBe(2);
  expect(staleSignal?.aborted).toBe(true);
  await act(async () => { staleRead.resolve(queuedResponse()); });
  expect(result.current.queue.entries.map((entry) => entry.id)).toEqual(["accepted"]);
});
