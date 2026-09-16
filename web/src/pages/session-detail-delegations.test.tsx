// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { SessionEvent } from "@/lib/types";
import SessionDetailPage from "@/pages/session-detail";

vi.mock("@/components/workspace-panel", () => ({ WorkspacePanel: () => <aside>Files stay here</aside> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView; });

it("reuses a full child Session tab across resumes and preserves parent state while closing independent SSE observers", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  const subscriptions: string[] = [];
  const aborted: string[] = [];
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const message = (seq: number, type: string, text: string) => ({ seq, type, data: { content: [{ type: "text", text }] }, ts: "2026-09-16" });
  const executions = [1, 2, 3].map((number) => ({ id: `exec-${number}`, childId: number === 3 ? "different-child" : "same-child", callerSessionId: "parent", callerTurnId: "turn", callerToolUseId: `call-${number}`, prompt: ["First child task", "Resumed child task", "Other child task"][number - 1], mode: "async", status: "completed", maxSteps: 30, createdAt: "", updatedAt: "" }));
  const usageEvent = (seq: number, inputTokens: number, outputTokens: number, cacheReadTokens: number) => ({
    seq, type: "span.model_request_end", ts: "2026-09-16", data: { usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0 } },
  });
  const parentEvents: SessionEvent[] = [message(1, "user.message", "Parent task"), ...executions.map((execution, index) => ({ seq: index + 2, ts: "2026-09-16", type: "agent.tool_use", data: { turnId: "turn", toolUseId: execution.callerToolUseId, name: "Agent", input: { prompt: execution.prompt } } }))];
  const childEvents: SessionEvent[] = [message(1, "delegation.input", "Original delegated task"), message(2, "agent.message", "First Turn output"), message(3, "delegation.input", "Resume this child"), message(4, "agent.message", "Resumed Turn output"), message(5, "user.message", "Direct user input"), message(6, "agent.message", "Direct input answer")];
  parentEvents.push(usageEvent(5, 1000, 100, 500));
  childEvents.push(usageEvent(7, 2000, 200, 1500), usageEvent(8, 1000, 300, 750));
  vi.stubGlobal("fetch", vi.fn(async (raw: string, options?: RequestInit) => {
    const url = new URL(raw);
    const sessionId = url.pathname.match(/\/sessions\/([^/]+)/)?.[1] ?? "";
    const headers = options?.headers as Record<string, string> | undefined;
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (url.pathname.endsWith("/delegations")) return json({ data: executions.filter((execution) => execution.callerToolUseId === url.searchParams.get("tool_use_id")), has_more: false });
    if (url.pathname.endsWith("/pending")) return json({ data: [], has_more: false });
    if (url.pathname.endsWith("/skills")) return json({ data: [] });
    if (url.pathname.endsWith("/workspaces")) return json({ data: [] });
    if (url.pathname.endsWith("/events")) {
      if (headers?.Accept !== "text/event-stream") return json({ data: sessionId === "parent" ? parentEvents : sessionId === "same-child" ? childEvents : [message(1, "agent.message", "Other child output")], has_more: false });
      subscriptions.push(sessionId);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        streams.set(sessionId, controller);
        options?.signal?.addEventListener("abort", () => { aborted.push(sessionId); controller.close(); }, { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    return json({ id: sessionId, agentId: "agent", workspaceId: "workspace", status: "idle", createdAt: "", updatedAt: "" });
  }));
  const router = createMemoryRouter([{ path: "/sessions/:id", element: <SessionDetailPage /> }], { initialEntries: ["/sessions/parent"] });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>);
  const process = await screen.findByRole("button", { name: /Incomplete · 3 tool calls/ });
  expect(process.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(process);
  await screen.findByRole("button", { name: /Agent.*First child task/ });
  const draft = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(draft, { target: { value: "Unsent parent draft" } });
  const scroll = document.querySelector(".conversation-scroll")!;
  scroll.scrollTop = 120;
  fireEvent.scroll(scroll);
  const parentUsage = screen.getByRole("contentinfo", { name: "Session usage" });
  expect(within(parentUsage).getByText("1,100")).toBeTruthy();
  expect(within(parentUsage).getByText("50.0%")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Delegated executions" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Child Session origin" })).toBeNull();
  expect(screen.getByRole("region", { name: "Workspace panel" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Agent.*First child task/ }));
  await screen.findByText("First Turn output");
  expect(screen.getByText("Resumed Turn output")).toBeTruthy();
  expect(screen.getByText("Direct user input")).toBeTruthy();
  expect(screen.getByText("Direct input answer")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  const childUsage = screen.getByRole("contentinfo", { name: "Session usage" });
  expect(within(childUsage).getByText("3,500")).toBeTruthy();
  expect(within(childUsage).getByText("75.0%")).toBeTruthy();
  expect(childUsage).not.toBe(parentUsage);
  expect(parentUsage.closest("[hidden]")).not.toBeNull();
  expect(router.state.location.pathname).toBe("/sessions/parent");
  expect(draft.isConnected).toBe(true);
  expect(document.querySelector(".conversation-scroll")).toBe(scroll);
  expect(scroll.scrollTop).toBe(120);
  await waitFor(() => expect(streams.has("same-child")).toBe(true));
  await act(async () => {
    // Session-scoped subscribers can receive identical Turn, block and Delta IDs.
    for (const [id, text] of [["parent", "Parent partial"], ["same-child", "Child partial"]]) {
      streams.get(id)!.enqueue(new TextEncoder().encode(`event: agent.message_chunk\ndata: ${JSON.stringify({ turnId: "turn_1_a1", blockIndex: 0, deltaId: "1-0", text })}\n\n`));
    }
    streams.get("same-child")!.enqueue(new TextEncoder().encode('event: session.status_running\nid: 9\ndata: {}\n\n'));
  });
  const childPane = screen.getByLabelText("Agent 1 conversation");
  expect(await within(childPane).findByText("Child partial")).toBeTruthy();
  expect(within(childPane).queryByText("Parent partial")).toBeNull();
  expect(screen.getByText("Parent partial").closest("[hidden]")).not.toBeNull();
  await act(async () => {
    streams.get("same-child")!.enqueue(new TextEncoder().encode('event: agent.message\nid: 10\ndata: {"turnId":"turn_1_a1","blockIndex":0,"content":[{"type":"text","text":"Live child update"}]}\n\n'));
  });
  expect(await screen.findByText("Live child update")).toBeTruthy();
  expect(screen.queryByText("Child partial")).toBeNull();
  expect(screen.getByText("Parent partial")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Session running" })).toBeTruthy();
  await act(async () => {
    streams.get("same-child")!.enqueue(new TextEncoder().encode('event: session.status_idle\nid: 11\ndata: {}\n\n'));
  });
  expect(screen.queryByRole("img", { name: "Session running" })).toBeNull();
  expect(screen.queryByText("idle")).toBeNull();
  await act(async () => {
    // Replayed spans count once, and identical sequence numbers in another
    // Session must update only that Session's own footer.
    for (const [id, event] of [["parent", usageEvent(12, 100, 10, 0)], ["same-child", usageEvent(12, 4000, 100, 2000)]] as const) {
      const frame = new TextEncoder().encode(`event: span.model_request_end\nid: ${event.seq}\ndata: ${JSON.stringify(event.data)}\n\n`);
      streams.get(id)!.enqueue(frame);
      streams.get(id)!.enqueue(frame);
    }
  });
  expect(within(childUsage).getByText("7,600")).toBeTruthy();
  expect(within(childUsage).getByText("60.7%")).toBeTruthy();
  expect(within(parentUsage).getByText("1,210")).toBeTruthy();
  expect(within(parentUsage).getByText("45.5%")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
  expect(screen.getByRole("textbox", { name: "Message" })).toBe(draft);
  expect((draft as HTMLTextAreaElement).value).toBe("Unsent parent draft");
  fireEvent.click(screen.getByRole("button", { name: /Agent.*Resumed child task/ }));
  expect(screen.getAllByRole("button", { name: "Agent 1" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Agent 2" })).toBeNull();
  expect(subscriptions.filter((id) => id === "same-child")).toHaveLength(1);
  expect(screen.getByText("Live child update").closest("[hidden]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
  fireEvent.click(screen.getByRole("button", { name: /Agent.*Other child task/ }));
  await screen.findByText("Other child output");
  await waitFor(() => expect(streams.has("different-child")).toBe(true));
  expect(screen.getByRole("button", { name: "Agent 2" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close Agent 1" }));
  expect(screen.queryByRole("button", { name: "Agent 1" })).toBeNull();
  expect(screen.getByText("Other child output").closest("[hidden]")).toBeNull();
  await waitFor(() => expect(aborted).toContain("same-child"));
  fireEvent.click(screen.getByRole("button", { name: "Close Agent 2" }));
  expect(screen.getByRole("textbox", { name: "Message" })).toBe(draft);
  expect(aborted).toContain("different-child");
  expect(aborted).not.toContain("parent");
});
