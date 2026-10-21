import { describe, expect, it } from "vitest";
import { INTERRUPTED, OUTCOME_UNKNOWN, repairResult, type DanglingCallResolver } from "../src/dangling-call-results.js";

const scope = { sessionId: "sess", turnId: "turn_1_a1", pendingEventId: "pevt" };
const bash = { type: "agent.tool_use" as const, toolUseId: "call_bash", name: "bash" };
const agent = { type: "agent.tool_use" as const, toolUseId: "call_agent", name: "Agent" };
/** A tool whose durable state answers its calls, as the delegation tools' records will (#251). */
const recorded: DanglingCallResolver = async (call) => call.toolUseId === "call_agent"
  ? { content: [{ type: "text", text: "child sess_child, execution exec_1" }], isError: false } : undefined;

describe("the result a repair gives a dangling call", () => {
  it("a call no resolver answers is reported as of unknown outcome, as an error", async () => {
    expect(await repairResult(bash, "unknown", { Agent: recorded }, scope))
      .toEqual({ content: [{ type: "text", text: OUTCOME_UNKNOWN }], isError: true });
  });

  it("a tool's resolver answers its call from durable state", async () => {
    expect(await repairResult(agent, "unknown", { Agent: recorded }, scope))
      .toEqual({ content: [{ type: "text", text: "child sess_child, execution exec_1" }], isError: false });
  });

  it("a resolver that finds no record leaves the call of unknown outcome", async () => {
    expect(await repairResult({ ...agent, toolUseId: "call_unrecorded" }, "unknown", { Agent: recorded }, scope))
      .toEqual({ content: [{ type: "text", text: OUTCOME_UNKNOWN }], isError: true });
  });

  it("a call an Interrupt stopped is reported as interrupted, whatever its tool records", async () => {
    expect(await repairResult(agent, "interrupted", { Agent: recorded }, scope))
      .toEqual({ content: [{ type: "text", text: INTERRUPTED }], isError: true });
  });

  it("the outcome-unknown text tells the Agent to inspect before it retries", () => {
    expect(OUTCOME_UNKNOWN).toBe("The agent runtime restarted while this tool call was in progress, so its outcome is unknown. " +
      "It may not have run, may have partially completed, or may have finished, and a process it started may still be running. " +
      "Inspect the current state before deciding whether to retry. Do not assume it succeeded.");
  });
});
