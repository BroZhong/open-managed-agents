import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import type { DelegationExecution } from "@oma-server/store";
import { InMemoryTurnStreamStore } from "@oma-server/redis";
import { createApp } from "../src/app.js";

const oldAuth = process.env.AUTH_DISABLED;
beforeEach(() => { process.env.AUTH_DISABLED = "true"; });
afterEach(() => { if (oldAuth === undefined) delete process.env.AUTH_DISABLED; else process.env.AUTH_DISABLED = oldAuth; });

async function fixture() {
  const stores = createMemoryStores();
  const agent = await stores.agentStore.create({ tenantId: "dev", name: "Agent", model: "mock", system: "", runtime: "mock" });
  const parent = await stores.sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: "workspace" });
  const unrelated = await stores.sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: "workspace" });
  const child = await stores.sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: "workspace", delegation: { parentSessionId: parent.id, parentTurnId: "parent-turn", parentToolUseId: "call-1", sandboxSessionId: parent.id } });
  const foreign = await stores.sessionStore.create({ tenantId: "other", agentId: agent.id, agent, workspaceId: "private" });
  const first: DelegationExecution = { id: "exec-1", childId: child.id, tenantId: "dev", callerSessionId: parent.id, callerTurnId: "parent-turn", callerToolUseId: "call-1", pendingEventId: "pending", prompt: "Initial task", mode: "async", status: "failed", turnId: "child-turn-1", maxSteps: 30, createdAt: "2026-09-16", updatedAt: "2026-09-16", ownerId: "host-private", apiKeyId: "billing-private", result: { status: "failed", reason: "Model error", output: "", trace: { sessionId: child.id, turnId: "child-turn-1" } } };
  const second: DelegationExecution = { ...first, id: "exec-2", turnId: "child-turn-2", callerTurnId: "resume-turn", callerToolUseId: "call-2", prompt: "Resume task", status: "completed" };
  const executions = [first, second];
  const delegationStore = {
    listCommands: async (executionId: string) => [{ id: "instruction-1", executionId, childId: child.id, kind: "steer" as const, message: "Also verify the report", status: "not_applied" as const, createdAt: "2026-09-16T00:00:00.000Z", tenantId: "dev", callerSessionId: parent.id, callerTurnId: "parent-turn", callerToolUseId: "steer-call", targetGeneration: 99 }],
    getChild: async (tenantId: string, id: string) => { const found = await stores.sessionStore.getById(id); return found?.tenantId === tenantId ? found : null; },
    getExecution: async (tenantId: string, id: string) => executions.find((execution) => execution.id === id && execution.tenantId === tenantId) || null,
    listExecutions: async (tenantId: string, opts: { callerSessionId?: string; callerTurnId?: string; callerToolUseId?: string; childId?: string; limit?: number; afterId?: string }) => executions.filter((e) => e.tenantId === tenantId && (!opts.callerSessionId || e.callerSessionId === opts.callerSessionId) && (!opts.callerTurnId || e.callerTurnId === opts.callerTurnId) && (!opts.callerToolUseId || e.callerToolUseId === opts.callerToolUseId) && (!opts.childId || e.childId === opts.childId) && (!opts.afterId || e.id > opts.afterId)).slice(0, opts.limit),
  };
  const turnStreamStore = new InMemoryTurnStreamStore();
  const app = createApp({ ...stores, delegationStore, turnStreamStore });
  return { ...stores, app, parent, child, unrelated, foreign, turnStreamStore };
}

describe("Delegation trace API", () => {
  it("returns persisted compaction outcomes and native records for parent and Child Sessions", async () => {
    const { app, parent, child, eventLogStore } = await fixture();
    for (const session of [parent, child]) {
      const data = { turnId: "child-turn-1", compactionId: "compact1", status: "completed", reason: "threshold", summary: "saved context", tokensBefore: 123, estimatedTokensAfter: 40, usage: { input: 10, output: 5 } };
      await eventLogStore.append(session.id, { type: "agent.compaction", data, sessionThreadId: "primary" });
      const response = await app.request(`/v1/sessions/${session.id}/events`, { headers: { Accept: "application/json" } });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.find((e: {type: string}) => e.type === "agent.compaction").data).toEqual(data);
    }
    const trace = await (await app.request(`/v1/sessions/${parent.id}/delegations/exec-1/events`)).json();
    expect(trace.data.find((e: {type: string}) => e.type === "agent.compaction").data.summary).toBe("saved context");
  });

  it("reads child-owned deltas through either parent or child trace URL when Turn IDs collide", async () => {
    const { app, parent, child, unrelated, turnStreamStore } = await fixture();
    const turnId = "child-turn-1";
    await Promise.all([parent, child, unrelated].map(async session => {
      await turnStreamStore.setActiveTurn(session.id, { turnId, status: "running" });
      await turnStreamStore.appendDelta(session.id, { turnId, blockIndex: 0, type: "agent.tool_use_input_chunk", data: { text: `${session.id}-private` } });
    }));
    for (const session of [parent, child]) {
      const response = await app.request(`/v1/sessions/${session.id}/delegations/exec-1/events`);
      expect(response.status).toBe(200);
      const trace = await response.json();
      expect(trace.deltas).toHaveLength(1);
      expect(trace.deltas[0].data.text).toBe(`${child.id}-private`);
    }
  });

  it("restores creation and each resume source independently and paginates persisted references", async () => {
    const { app, parent, child } = await fixture();
    const origin = await (await app.request(`/v1/sessions/${child.id}/delegation-origin?limit=1`)).json();
    expect(origin).toMatchObject({ origin: { parentSessionId: parent.id, parentTurnId: "parent-turn", parentToolUseId: "call-1" }, data: [{ id: "exec-1", status: "failed" }], has_more: true, next_cursor: "exec-1" });
    expect(origin.data[0]).not.toHaveProperty("ownerId");
    expect(origin.data[0]).not.toHaveProperty("apiKeyId");
    const selected = await (await app.request(`/v1/sessions/${parent.id}/delegations?tool_use_id=call-2&turn_id=resume-turn`)).json();
    expect(selected.data).toHaveLength(1);
    expect(selected.data[0]).toMatchObject({ id: "exec-2", childId: child.id, callerTurnId: "resume-turn" });
  });
  it("returns only the selected Turn's full events and usage across pages", async () => {
    const { app, parent, child, eventLogStore } = await fixture();
    for (const event of [
      { type: "agent.message", data: { turnId: "child-turn-1", content: [{ type: "text", text: "Initial output" }] } },
      { type: "agent.message", data: { turnId: "child-turn-2", content: [{ type: "text", text: "Other execution" }] } },
      { type: "span.model_request_end", data: { turnId: "child-turn-1", usage: { inputTokens: 21, outputTokens: 7 } } },
      { type: "span.model_request_end", data: { turnId: "child-turn-2", usage: { inputTokens: 900, outputTokens: 100 } } },
      { type: "agent.tool_result", data: { turnId: "child-turn-1", toolUseId: "tool", content: "x".repeat(12000) } },
    ]) await eventLogStore.append(child.id, { ...event, sessionThreadId: "primary" });
    const first = await (await app.request(`/v1/sessions/${parent.id}/delegations/exec-1/events?limit=1`)).json();
    expect(first.data).toHaveLength(1);
    expect(first.data[0].data.content[0].text).toBe("Initial output");
    expect(first).toMatchObject({ has_more: true, next_cursor: 1, usage: { input_tokens: 21, output_tokens: 7, total_tokens: 28 }, execution: { status: "failed", result: { reason: "Model error" } } });
    const second = await (await app.request(`/v1/sessions/${child.id}/delegations/exec-1/events?after_seq=1&limit=100`)).json();
    expect(second.data.map((e: { seq: number }) => e.seq)).toEqual([3, 5]);
    expect(second.data[1].data.content).toHaveLength(12000);
    expect(second.has_more).toBe(false);
    expect(second.execution.commands).toEqual([{ id: "instruction-1", executionId: "exec-1", kind: "steer", message: "Also verify the report", status: "not_applied", createdAt: "2026-09-16T00:00:00.000Z", callerSessionId: parent.id, callerTurnId: "parent-turn", callerToolUseId: "steer-call" }]);
  });
  it("enforces both Tenant and execution relationship and validates bounds", async () => {
    const { app, unrelated, foreign, parent } = await fixture();
    for (const id of [unrelated.id, foreign.id]) {
      expect((await app.request(`/v1/sessions/${id}/delegations/exec-1/events`)).status).toBe(404);
    }
    expect((await app.request(`/v1/sessions/${foreign.id}/delegation-origin`)).status).toBe(404);
    expect((await app.request(`/v1/sessions/${parent.id}/delegations/exec-1/events?limit=0`)).status).toBe(400);
    expect((await app.request(`/v1/sessions/${parent.id}/delegations?limit=1000`)).status).toBe(400);
  });
  it("counts each child request once separately from parent usage and unrelated children", async () => {
    const { app, parent, child, unrelated, eventLogStore } = await fixture();
    await eventLogStore.append(parent.id, { type: "span.model_request_end", sessionThreadId: "primary", data: { usage: { inputTokens: 10, outputTokens: 5 } } });
    const childRequest = { type: "span.model_request_end", sessionThreadId: "primary", idempotencyKey: "request-1", data: { callerSessionId: parent.id, executionId: "exec-1", turnId: "child-turn-1", usage: { inputTokens: 21, outputTokens: 7 } } };
    await eventLogStore.append(child.id, childRequest);
    await eventLogStore.append(child.id, childRequest);
    await eventLogStore.append(child.id, { ...childRequest, idempotencyKey: "unrelated-request", data: { ...childRequest.data, callerSessionId: unrelated.id } });
    const result = await (await app.request(`/v1/sessions/${parent.id}/delegation-usage`)).json();
    expect(result).toMatchObject({ self: { total_tokens: 15 }, delegated: { total_tokens: 28 }, total: { total_tokens: 43 } });
  });

});
