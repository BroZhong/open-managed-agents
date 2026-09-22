// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConversationView } from "./conversation-view";
import { TimelineView } from "./timeline-view";
import type { EventDataLoader } from "./event-data";
import type { SessionEvent } from "@/lib/types";

const events: SessionEvent[] = [
  { seq: 1, type: "agent.tool_use", ts: "2026-09-21T00:00:00Z", data: { toolUseId: "read1", name: "read", input: { path: "/image.png" } } },
  { seq: 2, type: "agent.tool_result", ts: "2026-09-21T00:00:01Z", data: { toolUseId: "read1", isError: true, payloadRef: { version: 1, sha256: "a".repeat(64), bytes: 1000000 } } },
];
beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("does not load a big result, even a failed one, until its own tool is expanded; renders the full image without base64 text", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { content: [
    { type: "text", text: "Original tool result" },
    { type: "image", source: { type: "base64", mediaType: "image/png", data: "aGVsbG8=" } },
  ] } }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  render(<ConversationView sessionId="s1" events={events} sessionStatus="idle" />);
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Read file/ }));
  expect(await screen.findByText("Original tool result")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toContain("/v1/sessions/s1/events/2/data");
  expect(screen.getByAltText("Tool result").getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
  expect(document.body.textContent).not.toContain("aGVsbG8=");
});

it("uses the share loader without owner fetch and aborts on collapse", async () => {
  const ownerFetch = vi.fn(); vi.stubGlobal("fetch", ownerFetch);
  const load = vi.fn<EventDataLoader>(() => new Promise(() => {}));
  render(<ConversationView sessionId="shared" events={events} sessionStatus="idle" resources={{ shared: true, agentId: "", skills: [], loadEventData: load }} />);
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Read file/ }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  expect(load.mock.calls[0][0]).toBe(2);
  expect(ownerFetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Read file/ }));
  expect(load.mock.calls[0][1].aborted).toBe(true);
});

it("allows retry after a failed lazy read", async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue({ content: "recovered" });
  render(<ConversationView sessionId="s1" events={events} sessionStatus="idle" resources={{ agentId: "", skills: [], loadEventData: load }} />);
  fireEvent.click(screen.getByRole("button", { name: /Read file/ }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("recovered")).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
});

it("also loads an unpaired MCP result and a trajectory event only on expansion", async () => {
  const load = vi.fn().mockResolvedValue({ content: "full MCP result" });
  const orphan = { ...events[1], type: "agent.mcp_tool_result" };
  const view = render(<ConversationView sessionId="s1" events={[orphan]} sessionStatus="idle" resources={{ agentId: "", skills: [], loadEventData: load }} />);
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Tool Result/ }));
  expect(await screen.findByText("full MCP result")).toBeTruthy();
  view.unmount(); load.mockClear();
  render(<TimelineView sessionId="s1" events={[orphan]} loadEventData={load} />);
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /agent.mcp_tool_result/ }));
  await waitFor(() => expect(load).toHaveBeenCalledWith(2, expect.any(AbortSignal)));
});
