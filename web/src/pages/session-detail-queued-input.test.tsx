// @vitest-environment jsdom

// Regression coverage for issue #114: the `queued` strip must reflect the Host's
// pending queue, not the console's own optimistic sends. Two failures motivated
// this — the strip went blank in the gap between an interrupted Turn ending and
// the next one starting, and it never came back after a reload.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import SessionDetailPage from "@/pages/session-detail";
import type { Session } from "@/lib/hooks/use-sessions";

const SESSION_ID = "sess_queued";

const session: Session = {
  id: SESSION_ID,
  agentId: "agent_1",
  status: "running",
  workspaceId: "ws_1",
  agent: { id: "agent_1", name: "Storyboard", model: "gpt-5.5", runtime: "pi-agent" },
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
};

/** The queue the fake Host currently reports. Mutated mid-test. */
let queued: Array<{ id: string; text: string }> = [];
/** Pushes SSE frames into the page's live stream. */
let emit: (frame: string) => void = () => undefined;

function sseFrame(type: string, seq: number, data: unknown): string {
  return `event: ${type}\nid: ${seq}\ndata: ${JSON.stringify(data)}\n\n`;
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown) =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(body),
          json: async () => body,
        } as Response);

      if (url.includes("/pending")) {
        return json({
          count: queued.length,
          has_more: false,
          data: queued.map((entry) => ({
            id: entry.id,
            type: "user.message",
            data: { content: [{ type: "text", text: entry.text }] },
            arrived_at: "2026-07-29T00:00:00.000Z",
          })),
        });
      }
      // useAgentSkills unwraps `.data`, so a bare array would resolve undefined.
      if (url.includes("/skills")) return json({ data: [] });
      if (url.includes("/workspace")) return json({ data: [] });
      if (url.includes("/events")) {
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.Accept !== "text/event-stream") {
          return json({ data: [], has_more: false });
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            emit = (frame) => controller.enqueue(encoder.encode(frame));
            init?.signal?.addEventListener("abort", () => {
              try {
                controller.close();
              } catch {
                // already closed
              }
            }, { once: true });
          },
        });
        return Promise.resolve({ ok: true, status: 200, body } as Response);
      }
      return json(session);
    }),
  );
});

afterEach(() => {
  cleanup();
  queued = [];
  emit = () => undefined;
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(["sessions", SESSION_ID], session);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/sessions/${SESSION_ID}`]}>
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it("keeps the queued strip visible across an interrupted Turn's idle gap (issue #114)", async () => {
  // A Turn is running with one message queued behind it.
  queued = [{ id: "pending_1", text: "run this next" }];
  renderPage();

  await waitFor(() => expect(screen.getByText("run this next")).toBeTruthy());
  expect(screen.getByText("queued")).toBeTruthy();

  // Stop is pressed: the Host reports the Turn ended. The queue is untouched —
  // an Interrupt targets one Turn only, so the strip must stay put. Before the
  // fix this went blank because the strip was gated on status === "running".
  await act(async () => {
    emit(sseFrame("session.status_idle", 10, {}));
  });

  await waitFor(() => {
    expect(screen.getByText("run this next")).toBeTruthy();
  });
  expect(screen.getByText("queued")).toBeTruthy();

  // The next Turn starts and consumes the entry — now the strip clears.
  queued = [];
  await act(async () => {
    emit(sseFrame("session.status_running", 11, {}));
  });

  await waitFor(() => expect(screen.queryByText("run this next")).toBeNull());
  expect(screen.queryByText("queued")).toBeNull();
});

it("restores the queued strip from the Host after a reload", async () => {
  // A fresh mount is what a reload looks like: no optimistic state exists, so
  // only a server read can show that input is still waiting.
  queued = [{ id: "pending_1", text: "survives reload" }];
  renderPage();

  await waitFor(() => expect(screen.getByText("survives reload")).toBeTruthy());
  expect(screen.getByText("queued")).toBeTruthy();
});

it("keeps two identical queued messages as two rows", async () => {
  // Two identical messages are two distinct Queued Inputs. Bridging optimistic
  // sends by text would collapse them into one row and undercount the queue.
  queued = [
    { id: "pending_1", text: "same text" },
    { id: "pending_2", text: "same text" },
  ];
  renderPage();

  await waitFor(() => expect(screen.getAllByText("same text")).toHaveLength(2));
  expect(screen.getAllByText("queued")).toHaveLength(2);
});

it("shows nothing queued when the Host reports an empty queue", async () => {
  queued = [];
  renderPage();

  await waitFor(() => expect(screen.getByPlaceholderText("Send a message...")).toBeTruthy());
  expect(screen.queryByText("queued")).toBeNull();
  expect(screen.queryByLabelText("Queued input")).toBeNull();
});
