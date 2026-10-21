/**
 * The SQL statements each store method issues in its PostgreSQL implementation
 * (server/packages/store/src/postgres/*.ts at 85f2a69), so a call counted on
 * the in-memory stores converts into the statements, round trips and scans the
 * shared RDS would see. Every round trip counts, BEGIN and COMMIT included:
 * each one occupies a pooled connection and an RDS backend.
 *
 * `access` says how the statement finds its rows:
 *  - "pk"/"index": a unique or B-tree lookup;
 *  - "seq": a sequential scan because no index matches the predicate. Most are
 *    JSONB predicates on the delegation tables (`record->>'x' = $1`), whose
 *    tables grow with every delegation ever made and are never pruned;
 *  - "full": a deliberate whole-table read of a small table (pending_events).
 * Data-dependent loops (one statement per sibling, command or wait) use the
 * common case of zero or one row; each such place is commented.
 */
export type Access = "pk" | "index" | "seq" | "full" | "none";

export interface Statement {
  verb: string;
  table?: string;
  access: Access;
}

/** What the metering proxy observed about a call, for result-dependent costs. */
export interface CallFacts {
  args: unknown[];
  result: unknown;
  failed: boolean;
  /** claim: whether the head was taken, owned by a live claim, or absent. */
  claimOutcome?: "claimed" | "contended" | "empty";
  /** append: whether the call inserted a row or returned an idempotent hit. */
  appendedNewRow?: boolean;
}

const st = (verb: string, table?: string, access: Access = "none"): Statement => ({ verb, table, access });
const pk = (verb: string, table: string) => st(verb, table, "pk");
const ix = (verb: string, table: string) => st(verb, table, "index");
const seq = (verb: string, table: string) => st(verb, table, "seq");
const BEGIN = st("BEGIN");
const COMMIT = st("COMMIT");
const tx = (...body: Statement[]): Statement[] => [BEGIN, ...body, COMMIT];

/** PgEventLogStore.assertLiveFence and PgSessionStore.updateStatusIfClaimed. */
const LIVE_FENCE = [pk("SELECT FOR UPDATE", "sessions"), pk("SELECT FOR UPDATE", "pending_events"), pk("SELECT", "pending_events")];

/** The counter-row protocol shared by every event append path. */
function appendCore(keyed: boolean, newRow: boolean): Statement[] {
  return [
    pk("INSERT ON CONFLICT", "event_counters"),
    pk("SELECT FOR UPDATE", "event_counters"),
    ...(keyed ? [ix("SELECT", "events")] : []),
    ...(newRow ? [pk("UPDATE", "event_counters"), st("INSERT", "events")] : []),
  ];
}

/**
 * TransactionalDelegationStore.transaction in PG: every write path (and the
 * reads that are not overridden) takes ONE global row lock, so these
 * transactions serialize across all Runners. `fences` is the number of
 * assertFence calls, each rechecked just before COMMIT.
 */
function delegationTx(fences: number, ...body: Statement[]): Statement[] {
  return [BEGIN, pk("SELECT FOR UPDATE", "delegation_lock"), ...body,
    ...Array.from({ length: fences }, () => pk("SELECT", "pending_events")), COMMIT];
}
/** DelegationTransaction.assertFence. */
const ASSERT_FENCE = [pk("SELECT FOR UPDATE", "sessions"), pk("SELECT FOR UPDATE", "pending_events"), pk("SELECT", "sessions"), pk("SELECT", "pending_events")];
/** DelegationTransaction.sessions.getById. */
const TX_SESSION = [pk("SELECT FOR UPDATE", "sessions"), pk("SELECT", "sessions")];
/** `this.execution(tx, id)` filters `record->>'id'`, not the id column. */
const EXECUTION_BY_ID = seq("SELECT", "delegation_executions");
/** PgDelegationStore.append inside a delegation transaction (always keyed). */
const TX_APPEND = appendCore(true, true);
/** PgDelegationStore.withEnvironmentLock: snapshot transaction, then compare-and-set transaction. */
const ENVIRONMENT_ROW = [pk("INSERT ON CONFLICT", "delegation_environments"), pk("SELECT FOR UPDATE", "delegation_environments")];

type Cost = (facts: CallFacts) => Statement[];
const fixed = (statements: Statement[]): Cost => () => statements;

const appendInput = (facts: CallFacts) => facts.args[1] as { pendingFence?: unknown; idempotencyKey?: string };

export const PG_COSTS: Record<string, Cost> = {
  // PgPendingEventStore
  "pendingEventStore.requestInterrupt": fixed([ix("UPDATE", "pending_events")]), // NOT EXISTS reads every event of the Session
  "pendingEventStore.interruptRequested": fixed([pk("SELECT", "pending_events")]),
  "pendingEventStore.enqueue": fixed([st("INSERT", "pending_events")]), // + trigger: sessions lookup, delegation_environments upsert + lock
  "pendingEventStore.enqueueBatchIfSessionActive": (facts) => tx(pk("SELECT FOR UPDATE", "sessions"),
    ...((facts.args[1] as unknown[]) ?? []).map(() => st("INSERT", "pending_events"))),
  "pendingEventStore.peek": fixed([ix("SELECT", "pending_events")]),
  "pendingEventStore.claim": (facts) => facts.claimOutcome === "empty"
    ? tx(ix("SELECT FOR UPDATE", "pending_events"))
    : tx(ix("SELECT FOR UPDATE", "pending_events"), pk("UPDATE", "pending_events")),
  "pendingEventStore.renewClaim": fixed(tx(pk("SELECT FOR UPDATE", "pending_events"), pk("UPDATE", "pending_events"))),
  "pendingEventStore.releaseClaim": fixed([pk("UPDATE", "pending_events")]),
  "pendingEventStore.ownsClaim": fixed(tx(pk("SELECT FOR UPDATE", "pending_events"), pk("SELECT", "pending_events"))),
  "pendingEventStore.ack": fixed(tx(ix("SELECT FOR UPDATE", "pending_events"), pk("DELETE", "pending_events"))),
  "pendingEventStore.ackCompletedTurn": (facts) => {
    const result = facts.result as { acknowledged?: boolean; idleEvent?: unknown } | undefined;
    const gate = [pk("SELECT FOR UPDATE", "sessions"), ix("SELECT", "events"), ix("SELECT FOR UPDATE", "pending_events")];
    if (!result?.acknowledged) return tx(...gate);
    const removal = [pk("DELETE", "pending_events"), ix("SELECT", "pending_events")];
    if (!result.idleEvent) return tx(...gate, ...removal);
    return tx(...gate, ...removal, pk("UPDATE", "sessions"), ...appendCore(true, true));
  },
  "pendingEventStore.listPendingSessionIds": fixed([st("SELECT DISTINCT", "pending_events", "full")]),
  "pendingEventStore.clear": fixed([ix("DELETE", "pending_events")]),
  "pendingEventStore.count": fixed([ix("SELECT", "pending_events")]),
  "pendingEventStore.listUnclaimed": fixed([ix("SELECT", "pending_events")]),

  // PgSessionStore
  "sessionStore.getById": fixed([pk("SELECT", "sessions")]),
  "sessionStore.create": fixed([st("INSERT", "sessions")]),
  "sessionStore.updateStatus": fixed([pk("UPDATE", "sessions")]),
  "sessionStore.updateStatusIfClaimed": fixed(tx(...LIVE_FENCE, pk("UPDATE", "sessions"))),
  "sessionStore.setTitle": fixed([pk("UPDATE", "sessions")]),
  "sessionStore.setThinking": fixed([pk("UPDATE", "sessions")]),
  "sessionStore.terminate": fixed(tx(pk("SELECT FOR UPDATE", "sessions"), pk("UPDATE", "sessions"), ix("DELETE", "pending_events"),
    st("INSERT ON CONFLICT", "session_cleanup"), ...appendCore(true, true))),

  // PgEventLogStore
  "eventLogStore.append": (facts) => {
    const input = appendInput(facts);
    return tx(...(input?.pendingFence ? LIVE_FENCE : []), ...appendCore(input?.idempotencyKey !== undefined, facts.appendedNewRow !== false));
  },
  "eventLogStore.appendIfSessionActive": fixed(tx(pk("SELECT FOR UPDATE", "sessions"), ...appendCore(false, true))),
  // One page per call; the Router's readAllEvents pages 50 rows at a time
  // and also downloads every OSS-offloaded payload it returns.
  "eventLogStore.getEvents": fixed([pk("SELECT", "events")]),
  "eventLogStore.getLatestSeq": fixed([pk("SELECT", "event_counters")]),

  // Agent configuration read per Turn
  "agentStore.getById": fixed([pk("SELECT", "agents")]),
  "agentFileStore.get": fixed([pk("SELECT", "agent_files")]),
  // `WHERE skill_id = $1` cannot use the (tenant_id, skill_id) key.
  "skillStore.getById": fixed([seq("SELECT", "skills")]),
  "loopStore.dispatchDue": fixed(tx(ix("SELECT FOR UPDATE SKIP LOCKED", "loops"))), // + per due Loop

  // PgDelegationStore: plain queries (overridden, no global lock)
  "delegationStore.getExecution": fixed([pk("SELECT", "delegation_executions")]),
  "delegationStore.getByPendingEventId": fixed([ix("SELECT", "delegation_executions")]),
  "delegationStore.listExecutions": fixed([ix("SELECT", "delegation_executions")]),
  "delegationStore.list": fixed([ix("SELECT", "delegation_executions")]),
  "delegationStore.getChild": fixed([pk("SELECT", "sessions")]),
  "delegationStore.get": fixed([pk("SELECT", "sessions"), ix("SELECT", "delegation_executions")]),
  "delegationStore.listCommands": fixed([seq("SELECT", "delegation_commands")]),
  "delegationStore.listWaits": fixed([seq("SELECT", "delegation_waits")]),
  // Two status scans joined to sessions; a transaction only when something is found.
  "delegationStore.reconcileTerminatedExecutions": (facts) => [seq("SELECT", "delegation_executions"), seq("SELECT", "delegation_waits"),
    ...(((facts.result as unknown[]) ?? []).length ? delegationTx(0, EXECUTION_BY_ID, ...TX_SESSION, ...TX_SESSION) : [])],
  "delegationStore.withEnvironmentLock": fixed([...tx(...ENVIRONMENT_ROW), ...tx(...ENVIRONMENT_ROW, pk("UPDATE", "delegation_environments"))]),

  // PgDelegationStore: transactions under the global delegation_lock
  "delegationStore.acquireResourceUse": fixed(delegationTx(1, ...ASSERT_FENCE, st("INSERT ON CONFLICT", "delegation_resource_uses"))),
  "delegationStore.releaseResourceUse": fixed(delegationTx(0, seq("SELECT", "delegation_resource_uses"), pk("DELETE", "delegation_resource_uses"))),
  // + per resource use and per queued execution of the binding
  "delegationStore.hasResourceUsers": fixed(delegationTx(0, seq("SELECT", "delegation_resource_uses"), seq("SELECT", "delegation_executions"))),
  // + one ownsClaim per running sibling
  "delegationStore.startExecution": fixed(delegationTx(1, EXECUTION_BY_ID, ...ASSERT_FENCE, ix("SELECT", "delegation_executions"),
    ...TX_SESSION, st("INSERT ON CONFLICT", "delegation_resource_uses"), st("INSERT ON CONFLICT", "delegation_executions"))),
  "delegationStore.updateEffectiveConfig": fixed(delegationTx(1, EXECUTION_BY_ID, ...ASSERT_FENCE, st("INSERT ON CONFLICT", "delegation_executions"))),
  "delegationStore.finishExecution": fixed(delegationTx(1, EXECUTION_BY_ID, ...ASSERT_FENCE, ...TX_SESSION, ...TX_APPEND,
    seq("SELECT", "delegation_commands"), seq("SELECT", "delegation_resource_uses"), pk("DELETE", "delegation_resource_uses"),
    st("INSERT ON CONFLICT", "delegation_executions"))),
  "delegationStore.saveWait": fixed(delegationTx(1, ...ASSERT_FENCE, EXECUTION_BY_ID, ...TX_SESSION, seq("SELECT", "delegation_waits"),
    st("INSERT ON CONFLICT", "delegation_waits"))),
  "delegationStore.consumeResult": fixed(delegationTx(1, ...ASSERT_FENCE, EXECUTION_BY_ID, ...TX_SESSION, ...TX_APPEND,
    st("INSERT ON CONFLICT", "delegation_executions"), seq("SELECT", "delegation_waits"), st("INSERT ON CONFLICT", "delegation_waits"))),
  "delegationStore.markNotificationProcessed": fixed(delegationTx(1, EXECUTION_BY_ID, ...ASSERT_FENCE, st("INSERT ON CONFLICT", "delegation_executions"))),
  "delegationStore.cancelWaits": (facts) => delegationTx(facts.args[2] ? 1 : 0, ...(facts.args[2] ? ASSERT_FENCE : []), seq("SELECT", "delegation_waits")),
  "delegationStore.command": (facts) => delegationTx(facts.args[1] ? 1 : 0, ...(facts.args[1] ? ASSERT_FENCE : []), ...TX_SESSION,
    seq("SELECT", "delegation_commands"), ix("SELECT", "delegation_executions"), st("INSERT ON CONFLICT", "delegation_commands")),
  "delegationStore.applyCommand": fixed(delegationTx(1, seq("SELECT", "delegation_commands"), EXECUTION_BY_ID, ...ASSERT_FENCE, ...TX_APPEND,
    st("INSERT ON CONFLICT", "delegation_commands"))),
  // The child's sequence read filters childId alone; its index leads with tenantId.
  "delegationStore.accept": fixed(delegationTx(1, ...ASSERT_FENCE, ...TX_SESSION, ix("SELECT", "delegation_executions"),
    pk("SELECT FOR UPDATE", "workspaces"), st("INSERT", "sessions"), seq("SELECT", "delegation_executions"), st("INSERT", "pending_events"),
    st("INSERT ON CONFLICT", "delegation_executions"), st("INSERT ON CONFLICT", "delegation_waits"))),

  // PgSandboxLifecycleStore (one binding row lock per transaction)
  "sandboxLifecycle.begin": fixed(tx(...ENVIRONMENT_ROW, pk("SELECT", "delegation_environments"), pk("SELECT", "pending_events"),
    seq("DELETE", "delegation_resource_uses"), st("INSERT ON CONFLICT", "delegation_resource_uses"))),
  "sandboxLifecycle.finish": fixed(tx(...ENVIRONMENT_ROW, pk("DELETE", "delegation_resource_uses"), seq("SELECT", "delegation_resource_uses"),
    pk("SELECT", "delegation_environments"))),
  "sandboxLifecycle.claimReclamation": fixed(tx(...ENVIRONMENT_ROW, pk("SELECT", "delegation_environments"), seq("SELECT", "delegation_resource_uses"))),
  "sandboxLifecycle.completeReclamation": fixed(tx(...ENVIRONMENT_ROW, pk("UPDATE", "delegation_environments"), seq("DELETE", "delegation_resource_uses"))),

  // PgSessionCleanupStore.sweep: discovery, then one locked transaction per candidate
  "sessionCleanup.discover": fixed([ix("SELECT", "session_cleanup")]),
  "sessionCleanup.attempt": fixed(tx(pk("SELECT FOR UPDATE SKIP LOCKED", "session_cleanup"), pk("UPDATE", "session_cleanup"))),
  "sessionCleanup.skip": fixed(tx(pk("SELECT FOR UPDATE SKIP LOCKED", "session_cleanup"))),
};

/** A method with no entry is visible in the output instead of silently free. */
export function pgStatements(method: string, facts: CallFacts): Statement[] {
  const cost = PG_COSTS[method];
  return cost ? cost(facts) : [st("UNMAPPED", method, "none")];
}
