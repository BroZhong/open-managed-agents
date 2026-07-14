// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import SessionDetailPage from "@/pages/session-detail";
import type { Session } from "@/lib/hooks/use-sessions";
import type { SessionEvent } from "@/lib/types";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function modelUsageEvent(
  seq: number,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
): SessionEvent {
  return {
    seq,
    type: "span.model_request_end",
    data: { usage },
    ts: "2026-07-14T00:00:00.000Z",
  };
}

function metricValue(label: string): string | null | undefined {
  const metrics = screen.getByLabelText("Token usage");
  return within(metrics)
    .getByText(label)
    .parentElement?.querySelector("dd")
    ?.textContent;
}

describe("SessionDetailPage status", () => {
  it("keeps a terminated Session terminal when old running history loads first", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const session: Session = {
      id: "session_terminated",
      agentId: "agent_1",
      status: "terminated",
      title: "Terminated Session",
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
    const sessionResponse = deferred<Response>();
    const runningEvents = [
      {
        seq: 1,
        type: "user.message",
        data: { content: [{ type: "text", text: "Old turn" }] },
        ts: "2026-07-14T00:00:00.000Z",
      },
      {
        seq: 2,
        type: "session.status_running",
        data: {},
        ts: "2026-07-14T00:00:01.000Z",
      },
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Accept === "application/json") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: runningEvents }),
        } as Response);
      }
      if (headers?.Accept === "text/event-stream") {
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
      }
      if (url.endsWith(`/v1/sessions/${session.id}`)) {
        return sessionResponse.promise;
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [] }),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/sessions/${session.id}`]}>
          <Routes>
            <Route path="/sessions/:id" element={<SessionDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) =>
      (init?.headers as Record<string, string> | undefined)?.Accept
        === "text/event-stream"
    )).toBe(true));
    sessionResponse.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(session),
    } as Response);

    expect(await screen.findByText("terminated")).toBeTruthy();
    expect(screen.queryByText("running")).toBeNull();
    expect(document.querySelector(".animate-bounce")).toBeNull();
  });
});

it("renders current Session token usage and updates its cache hit rate from SSE", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });

  const session: Session = {
    id: "session_usage",
    agentId: "agent_1",
    status: "idle",
    title: "Usage Session",
    workspaceId: "workspace_1",
    agent: {
      id: "agent_1",
      name: "Usage Agent",
      model: "test/model",
      runtime: "pi-agent",
    },
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
  const history = [
    modelUsageEvent(1, {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
    }),
  ];
  let sseController: ReadableStreamDefaultController<Uint8Array> | undefined;

  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Accept === "application/json") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: history, has_more: false }),
        } as Response);
      }

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          sseController = controller;
          init?.signal?.addEventListener("abort", () => controller.close(), {
            once: true,
          });
        },
      });
      return Promise.resolve({ ok: true, body } as Response);
    }),
  );

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
    },
  });
  queryClient.setQueryData(["sessions", session.id], session);
  queryClient.setQueryData(["agents", session.agentId, "skills"], []);

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/sessions/${session.id}`]}>
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  await waitFor(() => expect(metricValue("Input")).toBe("100"));
  expect(metricValue("Output")).toBe("20");
  expect(metricValue("Cache read")).toBe("20");
  expect(metricValue("Cache write")).toBe("10");
  expect(metricValue("Total")).toBe("120");
  expect(metricValue("Cache hit")).toBe("20.0%");

  await waitFor(() => expect(sseController).toBeDefined());
  await act(async () => {
    sseController!.enqueue(
      new TextEncoder().encode(
        "event: span.model_request_end\n" +
          "id: 2\n" +
          '{"usage":{"inputTokens":100,"outputTokens":30,"cacheReadTokens":80,"cacheWriteTokens":0}}\n\n',
      ),
    );
  });

  await waitFor(() => expect(metricValue("Cache hit")).toBe("50.0%"));
  expect(metricValue("Input")).toBe("200");
  expect(metricValue("Output")).toBe("50");
  expect(metricValue("Cache read")).toBe("100");
  expect(metricValue("Cache write")).toBe("10");
  expect(metricValue("Total")).toBe("250");
});
