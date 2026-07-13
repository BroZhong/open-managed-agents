// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { useSessionEvents } from "@/lib/hooks/use-session-events";
import type { SessionEvent } from "@/lib/types";
import type { Session } from "@/lib/hooks/use-sessions";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function historicalEvent(seq: number): SessionEvent {
  return {
    seq,
    type: "user.message",
    data: { content: [{ type: "text", text: `message ${seq}` }] },
    ts: "2026-07-12T00:00:00.000Z",
  };
}

function queryWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  };
}

function sessionFixture(
  id: string,
  status: Session["status"] = "idle",
): Session {
  return {
    id,
    agentId: "agent_1",
    status,
    title: "Replayed Session",
    workspaceId: "workspace_1",
    agent: {
      id: "agent_1",
      name: "Test Agent",
      model: "test/model",
      runtime: "pi-agent",
    },
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

function stubHistoryOnly(history: SessionEvent[], hasMore = false) {
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Accept === "application/json") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: history, has_more: hasMore }),
        } as Response);
      }

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
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
}

describe("useSessionEvents history replay", () => {
  it("loads every history page then merges replay without gaps or duplicates", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      historicalEvent(index + 1),
    );
    const secondPage = Array.from({ length: 25 }, (_, index) =>
      historicalEvent(index + 51),
    );
    const replayFrames =
      "event: user.message\n" +
      "id: 75\n" +
      'data: {"content":[{"type":"text","text":"message 75"}]}\n\n' +
      "event: workspace.file_change\n" +
      "id: 76\n" +
      'data: {"workspaceId":"workspace_1","changed":["image.png"],"deleted":[]}\n\n';

    const historyUrls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.Accept === "application/json") {
          const url = String(input);
          historyUrls.push(url);
          const isSecondPage = url.includes("after_seq=50");
          return Promise.resolve({
            ok: true,
            json: async () =>
              isSecondPage
                ? { data: secondPage, has_more: false }
                : { data: firstPage, has_more: true },
          } as Response);
        }

        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(replayFrames));
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

    const { result } = renderHook(() => useSessionEvents("session_1"), {
      wrapper: queryWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.fileChange.nonce).toBe(1));
    expect(result.current.events.map((event) => event.seq)).toEqual(
      Array.from({ length: 76 }, (_, index) => index + 1),
    );
    expect(historyUrls).toHaveLength(2);
    expect(historyUrls[0]).toContain("limit=1000");
    expect(historyUrls[1]).toContain("after_seq=50");
  });

  it("clears the previous Session projection and resume anchor on switch", async () => {
    const sseConnections: Array<{ url: string; lastEventId: string }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.Accept === "application/json") {
          const seq = url.includes("session_1") ? 100 : 1;
          return Promise.resolve({
            ok: true,
            json: async () => ({ data: [historicalEvent(seq)], has_more: false }),
          } as Response);
        }

        sseConnections.push({
          url,
          lastEventId: headers?.["Last-Event-ID"] ?? "missing",
        });
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
        });
        return Promise.resolve({ ok: true, body } as Response);
      }),
    );

    const { result, rerender } = renderHook(
      ({ sessionId }) => useSessionEvents(sessionId),
      { initialProps: { sessionId: "session_1" } },
    );
    await waitFor(() => expect(result.current.events[0]?.seq).toBe(100));

    rerender({ sessionId: "session_2" });
    expect(result.current.events).toEqual([]);
    expect(result.current.status).toBe("idle");
    expect(result.current.isConnected).toBe(false);

    await waitFor(() => expect(result.current.events[0]?.seq).toBe(1));
    await waitFor(() => expect(sseConnections).toHaveLength(2));
    expect(sseConnections).toEqual([
      expect.objectContaining({ url: expect.stringContaining("session_1"), lastEventId: "100" }),
      expect.objectContaining({ url: expect.stringContaining("session_2"), lastEventId: "1" }),
    ]);
  });

  it("rejects an old Session frame before passive abort cleanup can fence it", async () => {
    let resolveOldRead:
      | ((value: { done: false; value: Uint8Array }) => void)
      | undefined;
    const never = new Promise<Response>(() => {});
    const staleFrame = new TextEncoder().encode(
      "event: user.message\n" +
        "id: 101\n" +
        'data: {"content":[{"type":"text","text":"stale"}]}\n\n',
    );

    // Model the small commit-to-passive-cleanup window by keeping the old
    // signal readable even after React invokes cleanup. A Session generation
    // fence, rather than AbortSignal timing, must reject the stale frame.
    vi.stubGlobal(
      "AbortController",
      class LaggingAbortController {
        readonly signal = {
          aborted: false,
          addEventListener: vi.fn(),
        } as unknown as AbortSignal;

        abort() {}
      },
    );

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.Accept === "application/json") {
          if (url.includes("session_2")) return never;
          return Promise.resolve({
            ok: true,
            json: async () => ({ data: [historicalEvent(100)], has_more: false }),
          } as Response);
        }

        return Promise.resolve({
          ok: true,
          body: {
            getReader: () => ({
              read: () =>
                new Promise<{ done: false; value: Uint8Array }>((resolve) => {
                  resolveOldRead = resolve;
                }),
            }),
          },
        } as unknown as Response);
      }),
    );

    const { result, rerender } = renderHook(
      ({ sessionId }) => useSessionEvents(sessionId),
      {
      initialProps: { sessionId: "session_1" },
      },
    );
    await waitFor(() => expect(result.current.events[0]?.seq).toBe(100));
    await waitFor(() => expect(resolveOldRead).toBeTypeOf("function"));

    rerender({ sessionId: "session_2" });

    expect(result.current.events).toEqual([]);
    resolveOldRead?.({ done: false, value: staleFrame });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.events).toEqual([]);
  });

  it("projects the latest status from complete history into Session caches", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const session = {
      ...sessionFixture("session_replayed"),
      loopId: "loop_1",
    };
    queryClient.setQueryData(["sessions", session.id], session);
    queryClient.setQueryData(["sessions", "all"], [session]);
    queryClient.setQueryData(["sessions", "byAgent", session.agentId], [session]);
    queryClient.setQueryData(["sessions", "byLoop", session.loopId], {
      pages: [{ data: [session], has_more: false }],
      pageParams: [undefined],
    });

    const runningEvent: SessionEvent = {
      seq: 1,
      type: "session.status_running",
      data: {},
      ts: "2026-07-14T00:00:01.000Z",
    };
    stubHistoryOnly([runningEvent]);

    const { result } = renderHook(
      () => useSessionEvents(session.id),
      { wrapper: queryWrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.status).toBe("running"));
    expect(
      queryClient.getQueryData<Session[]>(["sessions", "all"])?.[0].status,
    ).toBe("running");
    expect(
      queryClient.getQueryData<Session[]>([
        "sessions",
        "byAgent",
        session.agentId,
      ])?.[0].status,
    ).toBe("running");
    expect(
      queryClient.getQueryData<{
        pages: Array<{ data: Session[] }>;
      }>(["sessions", "byLoop", session.loopId])?.pages[0].data[0].status,
    ).toBe("running");
  });

  it("does not let partial history overwrite authoritative Session caches", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const session = sessionFixture("session_partial");
    queryClient.setQueryData(["sessions", session.id], session);
    queryClient.setQueryData(["sessions", "byAgent", session.agentId], [session]);
    stubHistoryOnly([{
      seq: 50,
      type: "session.status_running",
      data: {},
      ts: "2026-07-14T00:00:01.000Z",
    }], true);

    const { result } = renderHook(() => useSessionEvents(session.id), {
      wrapper: queryWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(result.current.status).toBe("idle");
    expect(
      queryClient.getQueryData<Session[]>([
        "sessions",
        "byAgent",
        session.agentId,
      ])?.[0].status,
    ).toBe("idle");
  });

  it("does not revive a terminated Session from older status history", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const session = sessionFixture("session_terminated", "terminated");
    queryClient.setQueryData(["sessions", session.id], session);
    queryClient.setQueryData(["sessions", "byAgent", session.agentId], [session]);
    stubHistoryOnly([{
      seq: 1,
      type: "session.status_idle",
      data: {},
      ts: "2026-07-14T00:00:01.000Z",
    }]);

    const { result } = renderHook(() => useSessionEvents(session.id), {
      wrapper: queryWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(
      queryClient.getQueryData<Session>(["sessions", session.id])?.status,
    ).toBe("terminated");
    expect(
      queryClient.getQueryData<Session[]>([
        "sessions",
        "byAgent",
        session.agentId,
      ])?.[0].status,
    ).toBe("terminated");
  });

  it("does not cancel an explicit next-page load when status arrives", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const session = {
      ...sessionFixture("session_paging"),
      loopId: "loop_paging",
    };
    type SessionPage = {
      data: Session[];
      has_more: boolean;
      next_cursor?: string;
    };
    let resolveNextPage!: (page: SessionPage) => void;
    let nextPageAborted = false;
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: ["sessions", "byLoop", session.loopId],
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam, signal }) => {
        if (pageParam === undefined) {
          return Promise.resolve<SessionPage>({
            data: [session],
            has_more: true,
            next_cursor: "older",
          });
        }
        return new Promise<SessionPage>((resolve, reject) => {
          resolveNextPage = resolve;
          signal.addEventListener("abort", () => {
            nextPageAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      },
      getNextPageParam: (lastPage) =>
        lastPage.has_more ? lastPage.next_cursor : undefined,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await observer.refetch();
    const nextPage = observer.fetchNextPage();
    await waitFor(() =>
      expect(observer.getCurrentResult().isFetchingNextPage).toBe(true),
    );

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
      }),
    );
    const hook = renderHook(() => useSessionEvents(session.id), {
      wrapper: queryWrapper(queryClient),
    });

    try {
      await waitFor(() => expect(hook.result.current.status).toBe("running"));
      expect(nextPageAborted).toBe(false);
      resolveNextPage({ data: [], has_more: false });
      await nextPage;
      expect(observer.getCurrentResult().data?.pages).toHaveLength(2);
      expect(
        observer.getCurrentResult().data?.pages[0].data[0].status,
      ).toBe("running");
    } finally {
      hook.unmount();
      unsubscribe();
    }
  });
});
