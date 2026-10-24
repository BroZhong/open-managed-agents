import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { DefaultSandboxManager, DefaultTurnSandboxes, FakeSandboxClient } from "@oma-server/sandbox";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import type { PendingEventFence } from "@oma-server/store";
import type { Adapter, AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter } from "../src/session-router.js";
import { OUTCOME_UNKNOWN } from "../src/dangling-call-results.js";

const event = (type: string, data: object = {}) => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;
type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };

/**
 * A Turn whose Runner was lost while the delegation tool calls of its last
 * message ran (#251). What each call left in the delegation records is built
 * directly, so the child's state is known exactly: the child is still running
 * on a Runner that is alive, which no takeover of the parent touches.
 */
async function lostWhileDelegating(calls: (child: { childId: string; executionId: string }) => ToolCall[]) {
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test",
    runtime: "pi-agent", sandbox: { enabled: true } });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const parent = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const pending = await stores.pendingEventStore.enqueue(parent.id, {
    type: "user.message", data: { content: [{ type: "text", text: "triage the issues" }] }, sessionThreadId: "sthr_primary",
  });
  const claim = (await stores.pendingEventStore.claim(parent.id, "lost-runner", 30_000))!;
  const fence: PendingEventFence = { eventId: pending.id, ownerId: claim.ownerId, generation: claim.generation };
  const promoted = await stores.eventLogStore.append(parent.id, { type: pending.type, data: pending.data,
    sessionThreadId: "sthr_primary", idempotencyKey: `pending:${pending.id}`, pendingFence: fence });
  const turnId = `turn_${promoted.seq}_a${claim.generation}`;
  const caller = (callerToolUseId: string) => ({ tenantId: "tenant", callerSessionId: parent.id, callerTurnId: turnId, callerToolUseId });

  // A background delegation its Agent call made, running on a live Runner.
  const execution = await stores.delegationStore.accept({ ...caller("call_agent"), prompt: CHILD_TASK, mode: "async",
    parentModel: "test", maxSteps: 30, sandboxSessionId: parent.id }, fence);
  const childClaim = (await stores.pendingEventStore.claim(execution.childId, "live-runner", 600_000))!;
  const running = (await stores.delegationStore.startExecution(execution.id,
    { eventId: execution.pendingEventId, ownerId: childClaim.ownerId, generation: childClaim.generation }, "child-turn", {}, 4))!;
  const child = { childId: execution.childId, executionId: execution.id };

  // Pi commits the message requesting the calls before it runs them.
  const requested = calls(child);
  for (const committed of [
    event("agent.context_start", { sdk: "pi@0.83.0" }),
    event("agent.context_entry", { sdk: "pi@0.83.0", entry: { id: "entry_user", parentId: null, type: "message",
      message: { role: "user", content: [{ type: "text", text: "triage the issues" }] } }, presentation: { version: 1, blocks: [] } }),
    event("agent.context_entry", { sdk: "pi@0.83.0", entry: { id: "entry_calls", parentId: "entry_user", type: "message",
      message: { role: "assistant", content: requested.map((call) => ({ type: "toolCall", ...call })), stopReason: "toolUse" } },
      presentation: { version: 1, blocks: requested.map((_call, index) => ({ type: "agent.tool_use", index })) } }),
  ]) {
    await stores.eventLogStore.append(parent.id, { type: committed.type, data: { ...committed, turnId },
      sessionThreadId: "sthr_primary", idempotencyKey: `pending:${pending.id}:event:${committed.id}`, pendingFence: fence });
  }

  const resumed: AdapterInput[] = [];
  const adapter: Adapter = { async run(input) {
    resumed.push(input);
    await journalWriter(input)(event("agent.message", { content: [{ type: "text", text: "followed up" }], stopReason: "stop" }));
    return "finished";
  } };
  const errors: unknown[] = [];
  const takeOver = async () => {
    // The lost Runner's lease lapses; the next Runner's pending scan takes the Turn over.
    const state = stores.pendingEventStore.snapshotState();
    for (const held of state.claims.values()) if (held.ownerId === "lost-runner") held.expiresAtMs = 0;
    stores.pendingEventStore.restoreState(state);
    const router = new SessionRouter({ ...stores, eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => adapter,
      sandboxes: new DefaultTurnSandboxes({ manager: new DefaultSandboxManager({ sandboxClient: new FakeSandboxClient() }),
        bindings: stores.delegationStore, sessions: stores.sessionStore,
        workspaceMount: { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" },
        onError: ({ error }) => errors.push(error) }),
      pendingClaimOwnerId: "takeover-runner", onDrainError: ({ error }) => errors.push(error) });
    await router.recoverPendingEvents();
    expect(await router.waitForIdle(4000)).toBe(true);
    expect(errors).toEqual([]);
    const [input] = resumed;
    const results = new Map(input.history.filter((item) => item.type === "agent.tool_result")
      .map((item) => [(item as { toolUseId: string }).toolUseId, item as unknown as { isError: boolean; content: Array<{ text: string }> }]));
    return { input, results, log: (await stores.eventLogStore.getEvents(parent.id, { limit: 1000 })).data };
  };
  return { stores, parent, pending, fence, caller, turnId, running, child, resumed, takeOver };
}

const CHILD_TASK = "list the open issues";
/** The value a resolved result carries, as the tool returns it. */
const valueOf = (result: { isError: boolean; content: Array<{ text: string }> } | undefined) =>
  JSON.parse(result!.content[0].text) as Record<string, unknown>;
const OUTCOME_UNKNOWN_RESULT = { isError: true, content: [expect.objectContaining({ text: OUTCOME_UNKNOWN })] };

describe("a takeover answers a dangling delegation call from the record the call left (#251)", () => {
  it("C4 a background Agent call accepted before the loss: its Child Session and running execution, as Agent returns them", async () => {
    const lost = await lostWhileDelegating(() => [{ id: "call_agent", name: "Agent", arguments: { prompt: CHILD_TASK, run_in_background: true } }]);
    const { results, log } = await lost.takeOver();
    expect(results.get("call_agent")?.isError).toBe(false);
    expect(valueOf(results.get("call_agent"))).toEqual({ childId: lost.child.childId, executionId: lost.child.executionId,
      mode: "async", runInBackground: true, status: "running", turnId: "child-turn", budget: { maxModelSteps: 30 },
      trace: { sessionId: lost.child.childId, turnId: "child-turn" }, commands: [] });
    // Nothing delegated again: one execution, and the parent Turn completed.
    expect(await lost.stores.delegationStore.list("tenant", lost.parent.id)).toHaveLength(1);
    expect(log.filter((stored) => stored.type === "session.turn_completed")).toHaveLength(1);
  });

  it("C3 an Agent call that left no record: outcome unknown", async () => {
    const lost = await lostWhileDelegating(() => [{ id: "call_unaccepted", name: "Agent", arguments: { prompt: "another task" } }]);
    const { results } = await lost.takeOver();
    expect(results.get("call_unaccepted")).toMatchObject(OUTCOME_UNKNOWN_RESULT);
    expect(await lost.stores.delegationStore.list("tenant", lost.parent.id)).toHaveLength(1);
  });

  it.each([false, true])("C5 get_subagent_result(wait=%s) that recorded no wait: the execution's current status, and no wait is recorded for it", async (wait) => {
    const lost = await lostWhileDelegating((child) => [{ id: "call_peek", name: "get_subagent_result", arguments: { ...child, wait } }]);
    const { results } = await lost.takeOver();
    expect(results.get("call_peek")?.isError).toBe(false);
    expect(valueOf(results.get("call_peek"))).toMatchObject({ executionId: lost.child.executionId, status: "running" });
    expect(await lost.stores.delegationStore.listWaits(lost.parent.id, lost.pending.id)).toEqual([]);
  });

  it("C5 get_subagent_result naming no execution: the child's latest execution", async () => {
    const lost = await lostWhileDelegating((child) => [{ id: "call_peek", name: "get_subagent_result", arguments: { childId: child.childId } }]);
    const { results } = await lost.takeOver();
    expect(valueOf(results.get("call_peek"))).toMatchObject({ executionId: lost.child.executionId, status: "running" });
  });

  it("C5 get_subagent_result naming a child that is not this Session's: outcome unknown", async () => {
    const lost = await lostWhileDelegating(() => [{ id: "call_peek", name: "get_subagent_result", arguments: { childId: "sess_elsewhere" } }]);
    const { results } = await lost.takeOver();
    expect(results.get("call_peek")).toMatchObject(OUTCOME_UNKNOWN_RESULT);
  });

  it("C6 a steer_subagent call accepted before the loss: the command, accepted and not yet applied", async () => {
    const lost = await lostWhileDelegating((child) => [{ id: "call_steer", name: "steer_subagent", arguments: { ...child, message: "also the closed ones" } }]);
    const command = await lost.stores.delegationStore.command({ ...lost.caller("call_steer"), ...lost.child,
      kind: "steer", message: "also the closed ones" }, lost.fence);
    const { results } = await lost.takeOver();
    expect(results.get("call_steer")?.isError).toBe(false);
    expect(valueOf(results.get("call_steer"))).toMatchObject({ id: command.id, executionId: lost.child.executionId,
      kind: "steer", message: "also the closed ones", status: "accepted" });
  });

  it("C6 a steer_subagent call that left no command: outcome unknown, even beside another call's command to the same child", async () => {
    const lost = await lostWhileDelegating((child) => [{ id: "call_steer", name: "steer_subagent", arguments: { childId: child.childId, message: "again" } }]);
    await lost.stores.delegationStore.command({ ...lost.caller("call_earlier_steer"), ...lost.child, kind: "steer", message: "first" }, lost.fence);
    const { results } = await lost.takeOver();
    expect(results.get("call_steer")).toMatchObject(OUTCOME_UNKNOWN_RESULT);
  });

  it("answers every dangling call of one message once, each from its own record, and marks the takeover with all of them", async () => {
    const lost = await lostWhileDelegating((child) => [
      { id: "call_agent", name: "Agent", arguments: { prompt: CHILD_TASK, run_in_background: true } },
      { id: "call_peek", name: "get_subagent_result", arguments: { ...child } },
      { id: "call_steer", name: "steer_subagent", arguments: { ...child, message: "also the closed ones" } },
      { id: "call_bash", name: "bash", arguments: { command: "ls" } },
    ]);
    await lost.stores.delegationStore.command({ ...lost.caller("call_steer"), ...lost.child, kind: "steer", message: "also the closed ones" }, lost.fence);
    const { results, log } = await lost.takeOver();
    expect([...results.keys()]).toEqual(["call_agent", "call_peek", "call_steer", "call_bash"]);
    expect(log.filter((stored) => stored.type === "agent.tool_result")).toHaveLength(4);
    expect(valueOf(results.get("call_agent"))).toMatchObject({ executionId: lost.child.executionId,
      commands: [expect.objectContaining({ kind: "steer", status: "accepted" })] });
    expect(valueOf(results.get("call_steer"))).toMatchObject({ status: "accepted" });
    expect(results.get("call_bash")).toMatchObject(OUTCOME_UNKNOWN_RESULT);
    expect(log.filter((stored) => stored.type === "session.turn_resumed").map((stored) => stored.data)).toEqual([{
      turnId: lost.turnId, generation: 2, reason: "expired", danglingToolUseIds: ["call_agent", "call_peek", "call_steer", "call_bash"] }]);
  });
});
