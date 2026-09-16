// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DelegationCard } from "@/components/delegation-card";
import { ExecutionTraceView, ExecutionSummary } from "@/components/execution-trace";
import type { DelegationExecution } from "@/lib/delegations";
import { useToolDelegation } from "@/lib/hooks/use-delegations";

const execution: DelegationExecution = { id: "exec-1", childId: "child", callerSessionId: "parent", callerTurnId: "parent-turn", callerToolUseId: "call-1", prompt: "Create output", mode: "async", status: "completed", maxSteps: 30, turnId: "child-turn", createdAt: "2026-09-16", updatedAt: "2026-09-16" };
const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 15, cache_hit_rate: 0 };
function mount(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={client}>{element}</QueryClientProvider></MemoryRouter>);
}
function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("opens the selected execution without nesting a trace or navigating away", async () => {
  const open = vi.fn();
  const fetcher = vi.fn(async (raw: string) => {
    const second = new URL(raw).searchParams.get("tool_use_id") === "call-2";
    return json({ data: [{ ...execution, id: second ? "exec-2" : "exec-1", callerToolUseId: second ? "call-2" : "call-1" }], has_more: false });
  });
  vi.stubGlobal("fetch", fetcher);
  mount(<><DelegationCard onOpenExecution={open} sessionId="parent" message={{ id: "1", role: "tool_use", text: "", name: "Agent", toolUseId: "call-1", turnId: "parent-turn" }} /><DelegationCard onOpenExecution={open} sessionId="parent" message={{ id: "2", role: "tool_use", text: "", name: "Agent", toolUseId: "call-2", turnId: "next-parent-turn" }} /></>);
  await screen.findAllByText(/Open session/);
  const buttons = screen.getAllByRole("button", { name: /Agent/ });
  fireEvent.click(buttons[0]);
  fireEvent.click(buttons[1]);
  expect(open.mock.calls.map(([value]) => value.id)).toEqual(["exec-1", "exec-2"]);
  expect(screen.queryByRole("region", { name: "Delegation execution trace" })).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("paginates only the selected execution and displays complete tool inputs/results while hiding thinking", async () => {
  const completeText = "Full result " + "long content ".repeat(1000);
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
    const url = new URL(raw); calls.push(url.search);
    const second = url.searchParams.get("after_seq") === "2";
    return json({ execution, workspaceId: "workspace", usage, data: second ? [{ seq: 3, type: "agent.tool_result", data: { toolUseId: "nested", turnId: "child-turn", content: completeText } }] : [
      { seq: 1, type: "agent.thinking", data: { text: "private reasoning" } },
      { seq: 2, type: "agent.tool_use", data: { toolUseId: "nested", turnId: "child-turn", name: "write", input: { path: "/home/user/workspace/output.txt", content: "file text" } } },
    ], deltas: [], has_more: !second, next_cursor: second ? 3 : 2 });
  }));
  mount(<ExecutionTraceView sessionId="parent" executionId="exec-1" />);
  const tool = await screen.findByRole("button", { name: /Edit file.*output.txt/ });
  expect(tool.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(tool);
  expect(screen.getByText(/file text/).closest("[hidden]")).toBeNull();
  expect(calls).toHaveLength(1);
  expect(screen.queryByText("private reasoning")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load more execution events" }));
  await waitFor(() => expect(screen.getByText(completeText.trim()).closest("[hidden]")).toBeNull());
  expect(calls[1]).toContain("after_seq=2");
  expect(screen.getByText(/file text/)).toBeTruthy();
});

it("provides explicit retry after failed history load", async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(json({ execution, workspaceId: "workspace", usage, data: [], deltas: [], has_more: false, next_cursor: 0 }));
  vi.stubGlobal("fetch", fetcher);
  mount(<ExecutionTraceView sessionId="parent" executionId="exec-1" />);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry trace" }));
  await screen.findByText("No output yet.");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps observing after a parent has ended and replaces a reconnected Delta with its Complete Event", async () => {
  let requests = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    requests++;
    const finished = requests > 1;
    const delta = { type: "agent.message_chunk", data: { text: "Child still working" }, turnId: "child-turn", blockIndex: 0, deltaId: "1-0", ts: "2026-09-16" };
    return json({ execution: { ...execution, status: finished ? "completed" : "running" }, workspaceId: "workspace", usage,
      data: finished ? [{ seq: 1, type: "agent.message", data: { turnId: "child-turn", blockIndex: 0, content: [{ type: "text", text: "Child finished" }] } }] : [],
      deltas: finished ? [delta] : [{ ...delta, type: "agent.message_stream_start", deltaId: "0-0", data: {} }, delta], has_more: false, next_cursor: finished ? 1 : 0 });
  }));
  mount(<ExecutionTraceView sessionId="parent-already-idle" executionId="exec-1" />);
  await screen.findByText("Child still working");
  await screen.findByText("Child finished", {}, { timeout: 4000 });
  expect(screen.queryByText("Child still working")).toBeNull();
  expect(screen.getAllByText("Child finished")).toHaveLength(1);
});

it("preserves the plugin summary when no persisted child relation exists", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ data: [], has_more: false })));
  mount(<DelegationCard onOpenExecution={() => {}} sessionId="legacy" message={{ id: "old", role: "tool_use", name: "Agent", text: "", toolUseId: "old-call", input: { prompt: "Old task" }, result: { content: "Original plugin result", isError: false } }} />);
  await screen.findByText(/No persisted execution/);
  const summary = screen.getByRole("button", { name: /^Agent.*Completed$/ });
  fireEvent.click(summary);
  expect(screen.getByText("Original plugin result").closest("[hidden]")).toBeNull();
  expect(screen.queryByRole("link", { name: "Open child Session execution" })).toBeNull();
});

it("refreshes a terminal execution's pending notification in both card metadata and its open trace", async () => {
  const requests: Record<string, string[]> = { metadata: [], trace: [] };
  vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
    const url = new URL(raw);
    const kind = url.pathname.endsWith("events") ? "trace" : "metadata";
    requests[kind].push(url.search);
    const result = { ...execution, notificationStatus: requests[kind].length === 1 ? "pending" : "processed" };
    return json(kind === "metadata" ? { data: [result], has_more: false } : {
      execution: result, workspaceId: "workspace", usage,
      data: requests.trace.length === 1 ? [{ seq: 7, type: "agent.message", data: { content: [{ type: "text", text: "Final child output" }] } }] : [],
      deltas: [], has_more: false, next_cursor: 7,
    });
  }));
  function MetadataObserver() {
    const query = useToolDelegation("parent", "call-1", "parent-turn", true);
    return <span>Card notification: {query.data?.data[0]?.notificationStatus}</span>;
  }
  mount(<><MetadataObserver /><ExecutionTraceView sessionId="parent" executionId="exec-1" /></>);
  await screen.findByText("Card notification: pending");
  await screen.findByText("Notification: pending");
  await screen.findByText("Notification: processed", {}, { timeout: 4000 });
  await screen.findByText("Card notification: processed");
  expect(screen.getAllByText("Final child output")).toHaveLength(1);
  expect(requests.trace[1]).toContain("after_seq=7");
});

it("rechecks an initially absent execution when the Agent result arrives", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ data: [], has_more: false }))
    .mockResolvedValueOnce(json({ data: [{ ...execution, status: "running" }], has_more: false }));
  vi.stubGlobal("fetch", fetcher);
  const open = vi.fn();
  function LiveCall() {
    const [finished, setFinished] = useState(false);
    return <><button onClick={() => setFinished(true)}>Receive Agent result</button><DelegationCard onOpenExecution={open} sessionId="parent" message={{
      id: "live", role: "tool_use", name: "Agent", text: "", toolUseId: "call-1", turnId: "parent-turn",
      result: finished ? { content: "Child accepted", isError: false } : undefined,
    }} /></>;
  }
  mount(<LiveCall />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Receive Agent result" }));
  await screen.findByText(/async · running/);
  fireEvent.click(screen.getByRole("button", { name: /Agent.*Open session/ }));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "exec-1" }));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("shows a queued instruction that was never applied without claiming delivery", () => {
  mount(<ExecutionSummary execution={{ ...execution, commands: [{ id: "steer-1", executionId: "exec-1", kind: "steer", message: "Check the appendix too", status: "not_applied", createdAt: "2026-09-16" }] }} />);
  expect(screen.getByText("steer · not_applied")).toBeTruthy();
  expect(screen.getByText("Check the appendix too")).toBeTruthy();
  expect(screen.getByText("The execution ended before this instruction could be applied.")).toBeTruthy();
});
