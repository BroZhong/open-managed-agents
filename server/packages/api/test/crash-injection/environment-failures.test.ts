import { describe, expect, it } from "vitest";
import { SandboxUnavailable } from "@oma-server/sandbox";
import type { StoredEvent } from "@oma-server/store";
import { bash, execute, expectResumed, sweep, text, usePiSettings, type Outcome, type Scenario } from "./harness.js";

await usePiSettings();

/**
 * Environment failures are tool errors (ADR-0023, #287): a session.error is
 * written only at a Turn's end, so a Runner lost after an environment
 * failure, at any write, leaves a Turn its takeover continues rather than
 * ends. The failed call's native result carries `details.code`.
 */

/**
 * The first call meets an environment failure; the model calls again, and
 * that call runs. A Runner lost before the retry's preparation leaves no
 * sign the environment became ready again: that Turn ends with
 * sandbox_unavailable, as every Turn whose environment failed and never
 * became ready again does.
 */
const recovered: Scenario = {
  inputs: ["list the files"],
  model: (request) => request.results.has("call_retry") ? { blocks: [text("listed")], stop: "end_turn" }
    : request.results.has("call_ls") ? { blocks: [bash("call_retry", "ls")], stop: "tool_use" }
    : { blocks: [bash("call_ls", "ls")], stop: "tool_use" },
  environment: (call) => call.id === "call_ls" ? new SandboxUnavailable("unreachable") : undefined,
  errors: ["sandbox_unavailable"],
};

/** Every call meets an environment failure; the model calls once more, then answers. */
const unavailable: Scenario = {
  ...recovered,
  model: (request) => request.results.has("call_retry") ? { blocks: [text("the Sandbox is unavailable")], stop: "end_turn" }
    : request.results.has("call_ls") ? { blocks: [bash("call_retry", "ls")], stop: "tool_use" }
    : { blocks: [bash("call_ls", "ls")], stop: "tool_use" },
  environment: () => new SandboxUnavailable("unreachable"),
  errors: ["sandbox_unavailable"],
};

/** Whether the Turn's last preparation that decided anything failed. */
const leftUnavailable = (log: StoredEvent[]) => log.filter((event) => event.type === "span.sandbox_prepare_end")
  .map((event) => (event.data as { outcome: string }).outcome).filter((outcome) => outcome === "failed" || outcome === "ready").at(-1) === "failed";
const errors = (outcome: Outcome) => outcome.log.filter((event) => event.type === "session.error")
  .map((event) => (event.data as { error: { code: string } }).error.code);
/** The details of each call's native result, by call. */
const details = (log: StoredEvent[]) => new Map(log.flatMap((event) => {
  const message = event.type === "agent.context_entry"
    ? (event.data as { entry: { message?: { role?: string; toolCallId?: string; details?: Record<string, unknown> } } }).entry.message : undefined;
  return message?.role === "toolResult" ? [[message.toolCallId!, message.details ?? {}] as const] : [];
}));

describe("crash injection: a tool call that meets an environment failure, then one that runs", async () => {
  it("records no error and gives the failed call's result its code when no Runner is lost", async () => {
    const outcome = await execute(recovered);
    expectResumed(recovered, outcome);
    expect(errors(outcome)).toEqual([]);
    expect(details(outcome.log).get("call_ls")).toEqual({ code: "sandbox_unavailable", reason: "unreachable" });
    expect(outcome.toolCalls.map((call) => call.id)).toEqual(["call_retry"]);
  });
  await sweep(recovered, (outcome) => {
    // Recovered within the Turn: no error, whichever Runner ran the retry,
    // unless the loss hid that the environment became ready again.
    expect(outcome.toolCalls.map((call) => call.id).filter((id) => id !== "call_retry")).toEqual([]);
    expect(errors(outcome)).toEqual(leftUnavailable(outcome.log) ? ["sandbox_unavailable"] : []);
    // A call the lost Runner left dangling gets the takeover's result instead.
    const failed = details(outcome.log).get("call_ls");
    if (failed) expect(failed).toEqual({ code: "sandbox_unavailable", reason: "unreachable" });
  });
});

describe("crash injection: tool calls whose environment never becomes available", async () => {
  await sweep(unavailable, (outcome) => {
    expect(errors(outcome)).toEqual(["sandbox_unavailable"]);
    // Written once, at the Turn's end: after its answer, before its completion.
    const types = outcome.log.map((event) => event.type);
    expect(types.indexOf("session.error")).toBeGreaterThan(types.lastIndexOf("agent.context_entry"));
    expect(types.indexOf("session.error")).toBeLessThan(types.indexOf("session.turn_completed"));
    for (const call of ["call_ls", "call_retry"]) {
      const result = details(outcome.log).get(call);
      if (result) expect(result).toEqual({ code: "sandbox_unavailable", reason: "unreachable" });
    }
    expect(outcome.toolCalls).toEqual([]);
  });
});
