import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDelegationStore, type Pool, type PendingEventFence } from "../src/index.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

/**
 * Every row lookup the delegation store issues against delegation_waits,
 * delegation_commands and delegation_executions must be able to use an index.
 * These tables are never pruned and are read on every tool result, every
 * Child heartbeat and every pending scan of every Runner, so a sequential
 * scan grows with every delegation ever made.
 *
 * The statements are captured from the store itself, then planned with
 * sequential scans disabled: a whole-table read that remains has no usable
 * index.
 */
const INDEXED_TABLES = ["delegation_waits", "delegation_commands", "delegation_executions"];

interface Statement { text: string; values?: unknown[] }

function recording(pool: Pool, statements: Statement[]): Pool {
  const record = (text: unknown, values: unknown) => {
    if (typeof text === "string") statements.push({ text, values: values as unknown[] | undefined });
  };
  const forward = <T extends object>(target: T, property: string | symbol) => {
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  };
  return new Proxy(pool, {
    get(target, property) {
      if (property === "query") return (text: string, values?: unknown[]) => { record(text, values); return target.query(text, values); };
      if (property === "connect") return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(object, name) {
            if (name === "query") return (text: string, values?: unknown[]) => { record(text, values); return object.query(text, values); };
            return forward(object, name);
          },
        });
      };
      return forward(target, property);
    },
  });
}

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };

/**
 * Relations a plan still reads whole: a Seq Scan, or an index walked without
 * an Index Cond (e.g. the primary key for ORDER BY id LIMIT). A partial index
 * read whole is bounded by its predicate, so it does not count.
 */
function unboundedScans(plan: PlanNode, partialIndexes: Set<string>, relation?: string): string[] {
  const table = (plan["Relation Name"] as string | undefined) ?? relation;
  const type = plan["Node Type"];
  const wholeIndex = (type === "Index Scan" || type === "Index Only Scan" || type === "Bitmap Index Scan") &&
    !plan["Index Cond"] && !partialIndexes.has(String(plan["Index Name"]));
  const own = type === "Seq Scan" || wholeIndex ? [`${table} (${type}${plan["Index Name"] ? ` ${plan["Index Name"]}` : ""})`] : [];
  return [...own, ...(plan.Plans ?? []).flatMap((child) => unboundedScans(child, partialIndexes, table))];
}

describe.skipIf(!process.env.PG_TEST_URL)("delegation lookups on real PostgreSQL", () => {
  let harness: PgTestHarness;
  const statements: Statement[] = [];

  beforeAll(async () => {
    harness = await createPgTestHarness();
    const store = new PgDelegationStore(recording(harness.pool, statements));
    const fence: PendingEventFence = { eventId: "pending_1", ownerId: "owner", generation: 1 };
    const event = { type: "session.interrupt_requested", data: {}, sessionThreadId: "sthr_primary" };
    // Each call issues its lookups before it fails on the empty tables.
    const calls: Array<() => Promise<unknown>> = [
      () => store.listWaits("sess_parent", "pending_1"),
      () => store.listCommands("deleg_1"),
      () => store.getByPendingEventId("pending_1"),
      () => store.reconcileTerminatedExecutions(),
      () => store.cancelWaits("sess_parent", "turn_1"),
      () => store.hasResourceUsers("sess_parent"),
      () => store.markNotificationProcessed("deleg_1", fence),
      () => store.finishExecution("deleg_1", fence, { status: "completed", reason: "done", output: "", trace: { sessionId: "sess_child" } }),
      () => store.applyCommand("dcmd_1", fence, event),
    ];
    for (const call of calls) await call().catch(() => {});
  });
  afterAll(async () => { await harness?.close(); });

  it("plans every captured lookup on the indexed delegation tables without a sequential scan", async () => {
    const lookups = statements.filter(({ text }) => /^\s*(SELECT|DELETE|UPDATE)\b/i.test(text) &&
      INDEXED_TABLES.some((table) => text.includes(table)));
    expect(lookups.length).toBeGreaterThanOrEqual(9);
    const client = await harness.pool.connect();
    const offending: string[] = [];
    try {
      const partial = await client.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexdef LIKE '% WHERE %'");
      const partialIndexes = new Set(partial.rows.map(({ indexname }) => indexname));
      await client.query("SET enable_seqscan = off");
      for (const { text, values } of lookups) {
        const result = await client.query(`EXPLAIN (FORMAT JSON) ${text}`, values);
        const plan = (result.rows[0]["QUERY PLAN"] as Array<{ Plan: PlanNode }>)[0].Plan;
        const scanned = unboundedScans(plan, partialIndexes).filter((scan) => INDEXED_TABLES.some((table) => scan.startsWith(`${table} `)));
        if (scanned.length) offending.push(`${scanned.join(", ")}: ${text.replace(/\s+/g, " ").trim()}`);
      }
    } finally {
      await client.query("RESET enable_seqscan");
      client.release();
    }
    expect(offending).toEqual([]);
  });
});
