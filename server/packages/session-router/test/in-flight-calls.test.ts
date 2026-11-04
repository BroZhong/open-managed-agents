import { describe, expect, it } from "vitest";
import { InFlightCalls } from "../src/in-flight-calls.js";

/** Native Pi entries as the Adapter commits them (ADR-0016). */
const native = (id: string, message: object, blocks: object[]) => ({ type: "agent.context_entry",
  data: { id: `pi_entry_${id}`, sdk: "pi@0.83.0", entry: { id, parentId: null, type: "message", message }, presentation: { version: 1, blocks } } });
const assistant = (id: string, calls: Array<{ id: string; name: string }>, stopReason = "toolUse") => native(id,
  { role: "assistant", content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} })), stopReason },
  calls.map((_, index) => ({ type: "agent.tool_use", index })));
const toolResult = (id: string, toolCallId: string) => native(id,
  { role: "toolResult", toolCallId, toolName: "x", content: [{ type: "text", text: "ok" }], isError: false }, [{ type: "agent.tool_result" }]);

function tracked() {
  const flips: boolean[] = [];
  const calls = new InFlightCalls((waitingOnly) => flips.push(waitingOnly));
  return { calls, flips };
}

describe("a Turn attempt's tool calls in flight (#330)", () => {
  it("only waits once every committed call without a result holds a delegation wait, until a result is committed", () => {
    const { calls, flips } = tracked();
    calls.committed(assistant("a1", [{ id: "call_agent", name: "Agent" }, { id: "call_other", name: "get_subagent_result" }]));
    calls.waits("call_agent");
    expect(calls.waitingOnly).toBe(false);
    calls.waits("call_other");
    expect(calls.waitingOnly).toBe(true);
    // Pi commits a batch's results together, once its last call ends.
    calls.committed(toolResult("r1", "call_agent"));
    expect(calls.waitingOnly).toBe(true);
    calls.committed(toolResult("r2", "call_other"));
    expect(calls.waitingOnly).toBe(false);
    expect(flips).toEqual([true, false]);
  });

  it("a wait beside a call without one, such as bash, is not only waiting, even once that call has returned", () => {
    const { calls, flips } = tracked();
    calls.committed(assistant("a1", [{ id: "call_agent", name: "Agent" }, { id: "call_bash", name: "bash" }]));
    calls.waits("call_agent");
    expect(calls.waitingOnly).toBe(false);
    expect(flips).toEqual([]);
  });

  it("a recovered wait counts before the Adapter commits anything, and display events of older histories count as native entries do", () => {
    const { calls } = tracked();
    calls.waits("call_recovered");
    expect(calls.waitingOnly).toBe(true);
    calls.committed({ type: "agent.tool_result", data: { toolUseId: "call_recovered", content: [], isError: false } });
    expect(calls.waitingOnly).toBe(false);
    calls.committed({ type: "agent.tool_use", data: { toolUseId: "call_legacy", name: "Agent", input: {} } });
    calls.waits("call_legacy");
    expect(calls.waitingOnly).toBe(true);
  });

  it("an aborted assistant entry's unexecuted call is made and answered at once", () => {
    const { calls } = tracked();
    calls.committed(native("a1", { role: "assistant", content: [{ type: "toolCall", id: "call_cut", name: "bash", arguments: {} }], stopReason: "aborted" },
      [{ type: "agent.tool_use", index: 0 }, { type: "agent.tool_result", index: 0, unexecuted: "aborted" }]));
    calls.committed(assistant("a2", [{ id: "call_agent", name: "Agent" }]));
    calls.waits("call_agent");
    expect(calls.waitingOnly).toBe(true);
  });
});
