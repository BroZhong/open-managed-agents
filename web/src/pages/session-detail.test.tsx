// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import SessionDetailPage from "@/pages/session-detail";
import type { Session } from "@/lib/hooks/use-sessions";

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
