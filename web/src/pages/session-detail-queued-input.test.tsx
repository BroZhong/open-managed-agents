// @vitest-environment jsdom

// Regression coverage for issue #114: the `queued` strip must reflect the Host's
// pending queue, not the console's own optimistic sends. Two failures motivated
// this — the strip went blank in the gap between an interrupted Turn ending and
// the next one starting, and it never came back after a reload.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import SessionDetailPage from "@/pages/session-detail";
import type { Session } from "@/lib/hooks/use-sessions";

const SESSION_ID = "sess_queued";
const OTHER_SESSION_ID = "sess_other";

const session: Session = {
  id: SESSION_ID,
  agentId: "agent_1",
  status: "running",
  workspaceId: "ws_1",
  agent: { id: "agent_1", name: "Storyboard", model: "gpt-5.5", runtime: "pi-agent" },
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
};

/** The Queued Input the fake Host currently reports for each Session. */
let queued: Record<string, Array<{ id: string; text: string }>> = {};
let otherSession: Session;
let holdSends = false;
let workspaceUnavailable = false;
let acceptSend: (() => void) | undefined;
let rejectSend: (() => void) | undefined;
/** Pushes SSE frames into the page's live stream. */
let emit: (frame: string) => void = () => undefined;

function sseFrame(type: string, seq: number, data: unknown): string {
  return `event: ${type}\nid: ${seq}\ndata: ${JSON.stringify(data)}\n\n`;
}

beforeEach(() => {
  otherSession = { ...session, id: OTHER_SESSION_ID, status: "idle" };
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const sessionId = url.match(/\/sessions\/([^/?]+)/)?.[1];
      const requestedSession = sessionId === OTHER_SESSION_ID ? otherSession : session;
      const json = (body: unknown, status = 200) =>
        Promise.resolve({
          ok: status < 400,
          status,
          text: async () => JSON.stringify(body),
          json: async () => body,
        } as Response);

      if (url.includes("/pending")) {
        const entries = queued[sessionId!] ?? [];
        return json({
          count: entries.length,
          has_more: false,
          data: entries.map((entry) => ({
            id: entry.id,
            type: "user.message",
            data: { content: [{ type: "text", text: entry.text }] },
            arrived_at: "2026-07-29T00:00:00.000Z",
          })),
        });
      }
      // useAgentSkills unwraps `.data`, so a bare array would resolve undefined.
      if (url.includes("/skills")) return json({ data: [] });
      if (url.includes("/workspace")) return workspaceUnavailable
        ? json({ error: "Workspace storage is unavailable", code: "workspace_storage_error" }, 503)
        : json({ data: [] });
      if (url.includes("/events")) {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string);
          return new Promise<Response>((resolve) => {
            acceptSend = () => {
              const entries = queued[sessionId!] ??= [];
              entries.push({
                id: `pending_${entries.length + 1}`,
                text: body.events[0].data.content[0].text,
              });
              resolve(json({}));
            };
            rejectSend = () => resolve(json({ message: "Host rejected input" }, 503));
            if (!holdSends) acceptSend();
          });
        }
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.Accept !== "text/event-stream") {
          return json({
            data: [{
              seq: 1,
              type: `session.status_${requestedSession.status}`,
              data: {},
              ts: requestedSession.updatedAt,
            }],
            has_more: false,
          });
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
      return json(requestedSession);
    }),
  );
});

afterEach(() => {
  cleanup();
  queued = {};
  holdSends = false;
  workspaceUnavailable = false;
  acceptSend = undefined;
  rejectSend = undefined;
  emit = () => undefined;
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(["sessions", SESSION_ID], session);
  queryClient.setQueryData(["sessions", OTHER_SESSION_ID], otherSession);
  const router = createMemoryRouter(
    [{ path: "/sessions/:id", element: <SessionDetailPage /> }],
    { initialEntries: [`/sessions/${SESSION_ID}`] },
  );
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    ...result,
    navigate: (sessionId: string) => router.navigate(`/sessions/${sessionId}`),
  };
}

it("keeps the completed answer and idle state when the Workspace check and list fail", async () => {
  renderPage();
  await screen.findByRole("button", { name: "Stop generating" });
  expect(screen.getByRole("region", { name: "Workspace panel" })).toBeTruthy();
  workspaceUnavailable = true;
  await act(async () => {
    emit(sseFrame("agent.message", 2, { content: [{ type: "text", text: "The completed answer stays here." }] }));
    emit(sseFrame("session.error", 3, { error: { code: "workspace_storage_error", message: "File save status is unconfirmed. The answer is retained." } }));
    emit(sseFrame("session.status_idle", 4, {}));
    emit(sseFrame("session.turn_completed", 5, { turnId: "turn_1", pendingEventId: "input_1" }));
  });
  expect(await screen.findByText("The completed answer stays here.")).toBeTruthy();
  expect(await screen.findByText("File save status is unconfirmed. The answer is retained.")).toBeTruthy();
  await screen.findAllByRole("alert");
  expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull();
  expect(screen.queryByText(/No files yet/)).toBeNull();
  workspaceUnavailable = false;
  fireEvent.click(screen.getAllByTitle("Refresh")[0]);
  await waitFor(() => expect(screen.queryByText(/Could not refresh files/)).toBeNull());
  expect(screen.getByText("The completed answer stays here.")).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});

it("keeps the queued strip visible across an interrupted Turn's idle gap (issue #114)", async () => {
  // A Turn is running with one message queued behind it.
  queued[SESSION_ID] = [{ id: "pending_1", text: "run this next" }];
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
  queued[SESSION_ID] = [];
  await act(async () => {
    emit(sseFrame("session.status_running", 11, {}));
  });

  await waitFor(() => expect(screen.queryByText("run this next")).toBeNull());
  expect(screen.queryByText("queued")).toBeNull();
});

it("restores the queued strip from the Host after a reload", async () => {
  // A fresh mount is what a reload looks like: no optimistic state exists, so
  // only a server read can show that input is still waiting.
  queued[SESSION_ID] = [{ id: "pending_1", text: "survives reload" }];
  renderPage();

  await waitFor(() => expect(screen.getByText("survives reload")).toBeTruthy());
  expect(screen.getByText("queued")).toBeTruthy();
});

it("keeps two identical queued messages as two rows", async () => {
  // Two identical messages are two distinct Queued Inputs. Bridging optimistic
  // sends by text would collapse them into one row and undercount the queue.
  queued[SESSION_ID] = [
    { id: "pending_1", text: "same text" },
    { id: "pending_2", text: "same text" },
  ];
  renderPage();

  await waitFor(() => expect(screen.getAllByText("same text")).toHaveLength(2));
  expect(screen.getAllByText("queued")).toHaveLength(2);
});

it("shows nothing queued when the Host reports an empty queue", async () => {
  queued[SESSION_ID] = [];
  renderPage();

  await waitFor(() => expect(screen.getByPlaceholderText("Send a message...")).toBeTruthy());
  expect(screen.queryByText("queued")).toBeNull();
  expect(screen.queryByLabelText("Queued input")).toBeNull();
});

it("shows Sending until acceptance, then reads Queued Input without a Turn lifecycle event", async () => {
  holdSends = true;
  renderPage();
  await screen.findByRole("button", { name: "Stop generating" });

  const composer = screen.getByPlaceholderText("Send a message...");
  fireEvent.change(composer, { target: { value: "waiting for Host acceptance" } });
  fireEvent.keyDown(composer, { key: "Enter" });

  expect(screen.getByRole("status").textContent).toBe("Sending...");
  expect(screen.queryByLabelText("Queued input")).toBeNull();
  expect(screen.queryByText("waiting for Host acceptance", { selector: ":not(textarea)" })).toBeNull();
  expect(screen.getByText("Send a message to start the conversation.")).toBeTruthy();

  // The current Turn continues running throughout: acceptance must refresh the
  // Host's queue without waiting for a lifecycle event or the polling interval.
  await act(async () => acceptSend!());
  await screen.findByText("waiting for Host acceptance", { selector: ":not(textarea)" });
  expect(screen.queryByText("Sending...")).toBeNull();
  expect(screen.getByLabelText("Queued input")).toBeTruthy();
  expect(screen.getByText("Send a message to start the conversation.")).toBeTruthy();
});

it("moves identical Queued Inputs into canonical history one claim at a time", async () => {
  renderPage();
  await screen.findByRole("button", { name: "Stop generating" });
  const composer = screen.getByPlaceholderText("Send a message...");

  for (let count = 1; count <= 2; count += 1) {
    fireEvent.change(composer, { target: { value: "same text" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => {
      expect(within(screen.getByLabelText("Queued input")).getAllByText("same text")).toHaveLength(count);
      expect((composer as HTMLTextAreaElement).disabled).toBe(false);
    });
  }
  expect(screen.getAllByText("same text")).toHaveLength(2);
  expect(screen.getByText("Send a message to start the conversation.")).toBeTruthy();

  queued[SESSION_ID] = queued[SESSION_ID].slice(1);
  await act(async () => {
    emit(sseFrame("user.message", 10, { content: [{ type: "text", text: "same text" }] }));
    emit(sseFrame("session.status_running", 11, {}));
  });
  await waitFor(() => {
    expect(within(screen.getByLabelText("Queued input")).getAllByText("same text")).toHaveLength(1);
  });
  // One row is still queued and exactly one is now a durable user message.
  expect(screen.getAllByText("same text")).toHaveLength(2);
  expect(screen.queryByText("Send a message to start the conversation.")).toBeNull();

  queued[SESSION_ID] = [];
  await act(async () => {
    emit(sseFrame("user.message", 12, { content: [{ type: "text", text: "same text" }] }));
    emit(sseFrame("session.status_running", 13, {}));
  });
  await waitFor(() => expect(screen.queryByLabelText("Queued input")).toBeNull());
  expect(screen.getAllByText("same text")).toHaveLength(2);
});

it("does not create Queued Input or conversation history for a rejected send", async () => {
  holdSends = true;
  renderPage();
  await screen.findByRole("button", { name: "Stop generating" });
  const composer = screen.getByPlaceholderText("Send a message...");
  fireEvent.change(composer, { target: { value: "the Host will reject this" } });
  fireEvent.keyDown(composer, { key: "Enter" });

  expect(screen.getByRole("status").textContent).toBe("Sending...");
  await act(async () => rejectSend!());
  await waitFor(() => expect((composer as HTMLTextAreaElement).disabled).toBe(false));
  expect(screen.queryByText("Sending...")).toBeNull();
  expect(screen.queryByLabelText("Queued input")).toBeNull();
  expect(screen.queryByText("the Host will reject this", { selector: ":not(textarea)" })).toBeNull();
  expect(screen.getByText("Send a message to start the conversation.")).toBeTruthy();
});

it.each([
  { sendCompleted: false, destinationStatus: "running" as const },
  { sendCompleted: false, destinationStatus: "idle" as const },
  { sendCompleted: true, destinationStatus: "running" as const },
  { sendCompleted: true, destinationStatus: "idle" as const },
])(
  "isolates Queued Input when navigating to a $destinationStatus Session (send completed: $sendCompleted)",
  async ({ sendCompleted, destinationStatus }) => {
    holdSends = true;
    otherSession.status = destinationStatus;
    const page = renderPage();
    await screen.findByRole("button", { name: "Stop generating" });

    const composer = screen.getByPlaceholderText("Send a message...");
    fireEvent.change(composer, { target: { value: "only for the first Session" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(acceptSend).toBeTypeOf("function"));
    expect(screen.getByRole("status").textContent).toBe("Sending...");
    expect(screen.queryByLabelText("Queued input")).toBeNull();
    expect(screen.queryByText("only for the first Session", { selector: ":not(textarea)" })).toBeNull();

    if (sendCompleted) {
      await act(async () => acceptSend!());
      await screen.findByText("only for the first Session", { selector: ":not(textarea)" });
      await waitFor(() => expect((composer as HTMLTextAreaElement).disabled).toBe(false));
    }

    // Keep the app mounted and change only the route parameter: this is the
    // navigation that previously carried the first Session's local input over.
    await act(async () => page.navigate(OTHER_SESSION_ID));
    await screen.findByRole("button", {
      name: destinationStatus === "running" ? "Stop generating" : "Send message",
    });
    expect(screen.queryByLabelText("Queued input")).toBeNull();
    // An idle destination used to show the leaked input in its conversation too.
    expect(screen.queryByText("only for the first Session")).toBeNull();
    expect(screen.queryByText("Sending...")).toBeNull();
    expect((screen.getByPlaceholderText("Send a message...") as HTMLTextAreaElement).disabled).toBe(false);

    if (!sendCompleted) {
      await act(async () => acceptSend!());
      expect(screen.queryByText("only for the first Session")).toBeNull();
    }

    // Acceptance belongs to the original Session even when its POST finishes
    // after navigation. Its durable Queued Input must be restored on return.
    await act(async () => page.navigate(SESSION_ID));
    await waitFor(() => expect(screen.getByText("only for the first Session")).toBeTruthy());
    expect(screen.getByLabelText("Queued input")).toBeTruthy();
    expect(queued[OTHER_SESSION_ID] ?? []).toEqual([]);
  },
);
