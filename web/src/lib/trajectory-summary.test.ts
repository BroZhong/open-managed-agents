import { expect, it } from "vitest";
import { summarizeTrajectory } from "./trajectory-summary";
import type { SessionEvent } from "./types";

function event(seq: number, type: string, data: unknown = {}): SessionEvent {
  return { seq, type, data, ts: "2026-11-27T00:00:00Z" };
}

it("counts saved actions once, excluding results, native copies, streaming fragments and lifecycle events", () => {
  const call = event(3, "agent.tool_use", { name: "read", toolUseId: "call-1" });
  const summary = summarizeTrajectory([
    event(1, "user.message"),
    event(2, "agent.thinking", { text: "Plan" }),
    call,
    event(4, "agent.tool_result", { toolUseId: "call-1", payloadRef: { bytes: 1000000 } }),
    event(5, "agent.message", { content: [{ type: "text", text: "One" }, { type: "text", text: "block" }] }),
    event(6, "agent.context_entry", { entry: { message: { role: "assistant" } } }),
    event(7, "agent.message_chunk", { text: "Partial" }),
    event(8, "agent.thinking_chunk", { text: "Partial" }),
    event(9, "agent.tool_use_input_stream_start", { name: "bash" }),
    event(10, "span.model_request_end"),
    event(11, "session.turn_completed"),
    event(12, "agent.compaction"),
    event(13, "subagent.result"),
    call,
  ]);
  expect(summary).toMatchObject({ totalActions: 3, toolCalls: 1, thinking: 1, output: 1 });
  expect(summary.tools).toEqual([{ id: expect.any(String), name: "read", count: 1 }]);
});

it("distinguishes MCP servers and native tools, and counts repeated calls across Turns", () => {
  const events = [
    event(1, "agent.tool_use", { name: "read", toolUseId: "reused", turnId: "turn-1" }),
    event(2, "agent.tool_use", { name: "read", toolUseId: "reused", turnId: "turn-2" }),
    event(3, "agent.mcp_tool_use", { name: "read", serverName: "docs" }),
    event(4, "agent.mcp_tool_use", { name: "read", serverName: "files" }),
    event(5, "agent.mcp_tool_result", { isError: true }),
    event(6, "agent.tool_use", { name: "bash" }),
    event(7, "agent.tool_result", { isError: true }),
  ];
  const summary = summarizeTrajectory(events);
  expect(summary).toMatchObject({ totalActions: 5, toolCalls: 5, thinking: 0, output: 0 });
  expect(summary.tools.map(({ name, count }) => ({ name, count }))).toEqual([
    { name: "read", count: 2 },
    { name: "MCP · docs / read", count: 1 },
    { name: "MCP · files / read", count: 1 },
    { name: "bash", count: 1 },
  ]);
  expect(new Set(summary.tools.map(({ id }) => id)).size).toBe(4);
  expect(summarizeTrajectory([...events].reverse())).toEqual(summary);
});

it("counts saved interrupted output and pending tool calls, without requiring successful results", () => {
  expect(summarizeTrajectory([
    event(1, "agent.message", { stopReason: "aborted", content: [{ type: "text", text: "Partial answer" }] }),
    event(2, "agent.tool_use", { name: "bash" }),
    event(3, "session.turn_aborted"),
  ])).toMatchObject({ totalActions: 2, output: 1, toolCalls: 1 });
});

it("handles empty histories and retains calls without name metadata", () => {
  expect(summarizeTrajectory([])).toEqual({ totalActions: 0, toolCalls: 0, thinking: 0, output: 0, tools: [] });
  expect(summarizeTrajectory([
    event(1, "agent.tool_use", null),
    event(2, "agent.tool_use", { name: "" }),
    event(3, "agent.mcp_tool_use", { name: "search" }),
  ])).toMatchObject({ totalActions: 3, tools: [
    { name: "Unknown tool", count: 2 },
    { name: "MCP · search", count: 1 },
  ] });
});
