// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useQueuedInput } from "@/lib/hooks/use-queued-input";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function stubQueuedInputResponses(
  bodies: Array<{
    count: number;
    has_more?: boolean;
    data: Array<{ id: string; type: string; data: unknown; arrived_at: string }>;
  }>,
) {
  const fetchMock = vi.fn(() => {
    const body = bodies.length > 1 ? bodies.shift()! : bodies[0];
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function queuedEntry(id: string, text: string) {
  return {
    id,
    type: "user.message",
    data: { content: [{ type: "text", text }] },
    arrived_at: "2026-07-29T00:00:00.000Z",
  };
}

it("reads the Session's queued input from the Host", async () => {
  stubQueuedInputResponses([
    {
      count: 2,
      has_more: false,
      data: [queuedEntry("pending_1", "first"), queuedEntry("pending_2", "second")],
    },
  ]);

  const { result } = renderHook(() => useQueuedInput("sess_1", 0), { wrapper });

  await waitFor(() => expect(result.current.entries.length).toBe(2));
  expect(result.current.entries.map((p) => p.id)).toEqual(["pending_1", "pending_2"]);
  expect(result.current.entries[0].arrivedAt).toBe("2026-07-29T00:00:00.000Z");
  expect(result.current.hasMore).toBe(false);
});

it("re-reads the queue when a Turn lifecycle transition occurs", async () => {
  // The gap the Interrupt bug lived in: status flips to idle, the queue is
  // still non-empty, and the console must notice without a reload.
  const fetchMock = stubQueuedInputResponses([
    { count: 1, has_more: false, data: [queuedEntry("pending_1", "queued")] },
    { count: 0, has_more: false, data: [] },
  ]);

  const { result, rerender } = renderHook(
    ({ nonce }: { nonce: number }) => useQueuedInput("sess_1", nonce),
    { wrapper, initialProps: { nonce: 0 } },
  );

  await waitFor(() => expect(result.current.entries.length).toBe(1));
  expect(fetchMock).toHaveBeenCalledTimes(1);

  // A Turn started and consumed the entry.
  rerender({ nonce: 1 });
  await waitFor(() => expect(result.current.entries.length).toBe(0));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("keeps the last known queue visible while a re-read is in flight", async () => {
  // A blank frame between reads is exactly the flicker this feature exists to
  // remove, so the previous queue must survive the refetch.
  let resolveSecond: ((value: Response) => void) | undefined;
  const fetchMock = vi.fn(() => {
    if (fetchMock.mock.calls.length === 1) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            count: 1,
            has_more: false,
            data: [queuedEntry("pending_1", "queued")],
          }),
      } as Response);
    }
    return new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  const { result, rerender } = renderHook(
    ({ nonce }: { nonce: number }) => useQueuedInput("sess_1", nonce),
    { wrapper, initialProps: { nonce: 0 } },
  );
  await waitFor(() => expect(result.current.entries.length).toBe(1));

  rerender({ nonce: 1 });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  // Second read has not resolved: the strip still shows the known queue.
  expect(result.current.entries.map((p) => p.id)).toEqual(["pending_1"]);

  resolveSecond!({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ count: 0, has_more: false, data: [] }),
  } as Response);
  await waitFor(() => expect(result.current.entries.length).toBe(0));
});

it("reports an empty queue rather than throwing before the first read lands", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

  const { result } = renderHook(() => useQueuedInput("sess_1", 0), { wrapper });

  expect(result.current.entries).toEqual([]);
  expect(result.current.entries.length).toBe(0);
  expect(result.current.hasMore).toBe(false);
});

it("does not query without a Session id", () => {
  const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
  vi.stubGlobal("fetch", fetchMock);

  renderHook(() => useQueuedInput("", 0), { wrapper });

  expect(fetchMock).not.toHaveBeenCalled();
});
