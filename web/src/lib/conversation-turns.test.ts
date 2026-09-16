import { expect, it } from "vitest";
import { processEventsToMessages } from "./conversation-projection";
import { groupMessagesIntoTurns } from "./conversation-turns";
import type { SessionEvent } from "./types";

const start = Date.parse("2026-09-16T00:00:00Z");
const event = (seq: number, seconds: number, type: string, data: unknown = {}): SessionEvent => ({ seq, type, data, ts: new Date(start + seconds * 1000).toISOString() });
const answer = (seq: number, seconds: number, turnId: string) => event(seq, seconds, "agent.message", { turnId, content: [{ type: "text", text: `Answer ${seq}` }] });
const turns = (events: SessionEvent[], status: "running" | "idle" | "waiting" = "idle") => groupMessagesIntoTurns(processEventsToMessages(events).messages, events, status);

it("measures the whole Turn across commentary and parallel tools, excluding prior idle time", () => {
  const result = turns([
    event(1, 0, "user.message", { content: [] }),
    event(2, 30, "session.status_running"),
    answer(3, 40, "first"),
    event(4, 45, "agent.tool_use", { turnId: "first", toolUseId: "a", name: "read" }),
    event(5, 45, "agent.tool_use", { turnId: "first", toolUseId: "b", name: "read" }),
    event(6, 60, "agent.tool_result", { turnId: "first", toolUseId: "a", content: "Done" }),
    event(7, 65, "agent.tool_result", { turnId: "first", toolUseId: "b", content: "Done" }),
    answer(8, 70, "first"),
    event(9, 75, "session.status_idle"),
    event(10, 76, "session.turn_completed", { turnId: "first" }),
    event(11, 300, "user.message", { content: [] }),
    event(12, 310, "session.status_running"),
    answer(13, 320, "second"),
  ], "running");
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({ completed: true, running: false, timing: { startedAt: start + 30000, endedAt: start + 76000 } });
  expect(result[1]).toMatchObject({ completed: false, running: true });
});

it("shows arrival immediately, then displays the result once in its consuming Turn", () => {
  const first = [event(1, 0, "user.message", { content: [] }), answer(2, 5, "parent")];
  const result = { source: "subagent_result", executionId: "execution", result: { status: "completed", output: "**Child output**" } };
  const arrived = [...first, event(3, 10, "subagent.result", result)];
  expect(turns(arrived, "running")[0].responses.at(-1)?.text).toBe("**Child output**");
  const claimed = turns([...arrived, answer(4, 20, "parent"), event(5, 21, "session.turn_completed", { turnId: "parent" }),
    event(6, 50, "subagent.result_claimed", { ...result, notificationSeq: 3 }), event(7, 51, "session.status_running"),
    answer(8, 60, "consumer"), event(9, 61, "session.turn_completed", { turnId: "consumer" })]);
  expect(claimed).toHaveLength(2);
  expect(claimed[0].responses.map((message) => message.role)).toEqual(["assistant", "assistant"]);
  expect(claimed[1].responses.map((message) => message.role)).toEqual(["notification", "assistant"]);
  expect(claimed[1].userMessage).toBeNull();
  expect(claimed[1].timing).toEqual({ startedAt: start + 51000, endedAt: start + 61000 });
});

it("does not reopen or extend a completed Turn when an unclaimed result arrives", () => {
  const result = turns([answer(1, 1, "done"), event(2, 2, "session.turn_completed", { turnId: "done" }),
    event(3, 100, "subagent.result", { result: { output: "Arrived", status: "completed" } })], "waiting");
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({ completed: true, running: false, timing: { endedAt: start + 2000 } });
  expect(result[1].responses[0].role).toBe("notification");
});

it.each(["session.turn_aborted", "session.error"])("does not treat %s as successful completion", (type) => {
  const result = turns([answer(1, 1, "stopped"), event(2, 2, type, { turnId: "stopped", error: { message: "Failed" } }),
    event(3, 3, "session.status_idle"), event(4, 4, "session.turn_completed", { turnId: "stopped" })]);
  expect(result[0].completed).toBe(false);
});

it("keeps an instruction inside its current Turn and tolerates missing timestamps", () => {
  const result = turns([
    { seq: 1, type: "delegation.input", ts: "", data: { prompt: "Task" } },
    { seq: 2, type: "subagent.instruction", ts: "", data: { text: "Adjust" } },
    { ...answer(3, 10, "child"), ts: "" },
  ]);
  expect(result).toHaveLength(1);
  expect(result[0].timing).toBeUndefined();
  expect(result[0].responses.map((message) => message.role)).toEqual(["instruction", "assistant"]);
});
