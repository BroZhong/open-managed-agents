import type { DelegationExecution, DelegationStore, EventLogStore, SessionStore } from "@oma-server/store";
import { presentEventPage } from "@oma-server/store";
import type { TurnStreamStore } from "@oma-server/redis";
import type { TenantContext } from "../types.js";
import { createContractRouter, registerContractRoute } from "../openapi/router.js";
import { getOpenApiRoute } from "../openapi/routes.js";
import { EMPTY_TOKEN_USAGE, tokenUsageToWire } from "../lib/token-usage.js";

type Env = { Variables: { tenant: TenantContext } };
export interface DelegationRouteDeps {
  delegationStore: Pick<DelegationStore, "getChild" | "getExecution" | "listExecutions" | "listCommands">;
  sessionStore: SessionStore;
  eventLogStore: EventLogStore;
  turnStreamStore?: TurnStreamStore;
}

/** Coordination leases, billing credentials and execution checkpoints are Host-private. */
function publicExecution(execution: DelegationExecution) {
  const config = execution.effectiveConfig;
  return {
    id: execution.id, childId: execution.childId,
    callerSessionId: execution.callerSessionId, callerTurnId: execution.callerTurnId,
    callerToolUseId: execution.callerToolUseId,
    prompt: execution.prompt, mode: execution.mode, status: execution.status,
    turnId: execution.turnId, model: execution.model, thinking: execution.thinking,
    maxSteps: execution.maxSteps,
    effectiveConfig: config ? Object.fromEntries(["model", "thinking", "maxSteps", "modelSource", "thinkingSource"].filter((key) => config[key] !== undefined).map((key) => [key, config[key]])) : undefined,
    result: execution.result,
    notificationStatus: execution.notificationStatus ?? (execution.consumedAt ? "processed" : execution.notificationPendingEventId ? "pending" : execution.notificationEventSeq !== undefined ? "received" : undefined),
    createdAt: execution.createdAt, updatedAt: execution.updatedAt,
  };
}

export function delegationRoutes(deps: DelegationRouteDeps) {
  const router = createContractRouter<Env>();
  for (const origin of [false, true]) {
    registerContractRoute(router, getOpenApiRoute(origin ? "getDelegationOrigin" : "listDelegations"), async (c) => {
      const id = c.req.param("id")!;
      const tenantId = c.get("tenant").tenantId;
      const session = await deps.sessionStore.getById(id);
      if (!session || session.tenantId !== tenantId) return c.json({ error: "Session not found" }, 404);
      const limit = Math.min(Number(c.req.query("limit") || 20), 100);
      const executions = await deps.delegationStore.listExecutions(tenantId, {
        ...(origin ? { childId: id } : { callerSessionId: id, callerToolUseId: c.req.query("tool_use_id"), callerTurnId: c.req.query("turn_id") }),
        afterId: c.req.query("after_id"), limit: limit + 1,
      });
      const page = executions.slice(0, limit);
      const source = session.delegation;
      return c.json({
        data: page.map(publicExecution), has_more: executions.length > limit,
        next_cursor: executions.length > limit ? page.at(-1)?.id : undefined,
        ...(origin && source ? { origin: { parentSessionId: source.parentSessionId, parentTurnId: source.parentTurnId, parentToolUseId: source.parentToolUseId } } : {}),
      });
    });
  }
  registerContractRoute(router, getOpenApiRoute("getDelegationUsage"), async (c) => {
    const id = c.req.param("id")!;
    const session = await deps.sessionStore.getById(id);
    if (!session || session.tenantId !== c.get("tenant").tenantId) return c.json({ error: "Session not found" }, 404);
    const [self, delegated] = await Promise.all([deps.eventLogStore.getUsage({ sessionId: id }), deps.eventLogStore.getUsage({ callerSessionId: id })]);
    const total = { ...self, inputTokens: self.inputTokens + delegated.inputTokens, outputTokens: self.outputTokens + delegated.outputTokens, cacheReadTokens: self.cacheReadTokens + delegated.cacheReadTokens, cacheWriteTokens: self.cacheWriteTokens + delegated.cacheWriteTokens, totalTokens: self.totalTokens + delegated.totalTokens, cacheHitRate: null as number | null };
    total.cacheHitRate = total.inputTokens ? total.cacheReadTokens / total.inputTokens : null;
    return c.json({ self: tokenUsageToWire(self), delegated: tokenUsageToWire(delegated), total: tokenUsageToWire(total), scope: "Session model requests plus directly delegated execution model requests; each durable request counted once" });
  });
  registerContractRoute(router, getOpenApiRoute("getDelegationTrace"), async (c) => {
    const id = c.req.param("id")!;
    const tenantId = c.get("tenant").tenantId;
    const session = await deps.sessionStore.getById(id);
    if (!session || session.tenantId !== tenantId) return c.json({ error: "Session not found" }, 404);
    const execution = await deps.delegationStore.getExecution(tenantId, c.req.param("executionId")!);
    if (!execution || (execution.childId !== id && execution.callerSessionId !== id)) return c.json({ error: "Execution not found" }, 404);
    const child = await deps.delegationStore.getChild(tenantId, execution.childId);
    if (!child || child.tenantId !== tenantId) return c.json({ error: "Execution not found" }, 404);
    const afterSeq = Number(c.req.query("after_seq") || 0);
    const limit = Math.min(Number(c.req.query("limit") || 50), 100);
    // Read the transient snapshot first. Any Complete Event committed concurrently
    // is then present in the durable page and replaces its matching Delta block.
    const active = execution.turnId && deps.turnStreamStore ? await deps.turnStreamStore.getActiveTurn(execution.childId) : undefined;
    const deltas = active?.turnId === execution.turnId && active?.status === "running" && deps.turnStreamStore
      ? await deps.turnStreamStore.readDeltas(execution.childId, active.turnId) : [];
    const page = presentEventPage(execution.turnId ? await deps.eventLogStore.getEvents(execution.childId, { turnId: execution.turnId, afterSeq, limit, payload: "reference" }) : { data: [], hasMore: false }, afterSeq, limit);
    const [usage, commands] = await Promise.all([
      execution.turnId ? deps.eventLogStore.getUsage({ sessionId: execution.childId, turnId: execution.turnId }) : Promise.resolve(EMPTY_TOKEN_USAGE),
      deps.delegationStore.listCommands(execution.id),
    ]);
    return c.json({
      execution: { ...publicExecution(execution), commands: commands.map((command) => ({
        id: command.id, executionId: command.executionId, kind: command.kind,
        message: command.message, status: command.status, createdAt: command.createdAt,
        appliedEventSeq: command.appliedEventSeq, callerSessionId: command.callerSessionId,
        callerTurnId: command.callerTurnId, callerToolUseId: command.callerToolUseId,
      })) }, workspaceId: child.workspaceId,
      data: page.data, has_more: page.hasMore, next_cursor: page.data.at(-1)?.seq ?? afterSeq,
      deltas: page.hasMore ? [] : deltas.map((delta) => ({ type: delta.type, data: delta.data, turnId: delta.turnId, blockIndex: delta.blockIndex, deltaId: delta.id, ts: new Date().toISOString() })),
      usage: tokenUsageToWire(usage),
    });
  });
  return router;
}
