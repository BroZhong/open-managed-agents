/**
 * Database load of N Runners sharing one PostgreSQL (#234): which activity
 * issues how many SQL statements, as a function of active Turns, idle
 * Sessions and Runners. Runs the production Runner wiring on store-memory in
 * fake time at the real defaults (1:1 virtual time: 30 s lease, 10 s heartbeat
 * tick, 100 ms–5 s claim retry, 5 s pending scan, 15 s Loop scan, 2 s
 * delegation fallback poll) and converts every store call into the statements its
 * PostgreSQL implementation issues (db-load/pg-statements.ts).
 *
 * The printed tables feed docs/verification/db-load-multi-runner-2026-10-22.md.
 * Set DB_LOAD_JSON=<file> to also write the raw per-source numbers.
 * Assertions are behavioural invariants plus regression tripwires that fail
 * on a return to per-second polling.
 */
import { writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advance, bySource, Fleet, labelTimers, OMA_TEST_TURN, seqScans, statementCount, type CallRecord, type TurnShape } from "./db-load/harness.js";

const RUNNER_COUNTS = [1, 2, 4];
const results: Record<string, unknown> = {};
let restoreTimers: () => void;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  restoreTimers = labelTimers();
  // The Router's TurnJournal logs one line per flush.
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  restoreTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const runFor = (ms: number) => advance(ms, (step) => vi.advanceTimersByTime(step));
const round = (value: number, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;

async function fleetOf(runners: number, shape: TurnShape): Promise<Fleet> {
  const fleet = new Fleet(runners, shape);
  await fleet.start();
  return fleet;
}

/** Runner calls only; the API's own enqueue and startup are reported apart. */
const runnerCalls = (fleet: Fleet, from = 0) => fleet.meter.calls.filter((call) =>
  call.runner !== "api" && call.source !== "startup" && call.at >= from);

function table(title: string, rows: Array<Record<string, string | number>>): void {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  console.log([`\n### ${title}`, `| ${columns.join(" | ")} |`, `|${columns.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${columns.map((column) => row[column]).join(" | ")} |`)].join("\n"));
}

/** Statements per source, as a rate over `seconds`, with the top methods behind each. */
function sourceRows(calls: CallRecord[], seconds: number, per: number, unit: string) {
  return [...bySource(calls)].sort(([, a], [, b]) => b.statements - a.statements).map(([source, totals]) => ({
    source,
    "store calls": totals.calls,
    statements: totals.statements,
    "statements/s": round(totals.statements / seconds),
    [`statements/s per ${unit}`]: round(totals.statements / seconds / per, 3),
    "top methods (statements)": [...totals.methods].sort(([, a], [, b]) => b.statements - a.statements).slice(0, 4)
      .map(([method, { statements }]) => `${method.replace("Store.", ".")} ${statements}`).join(", "),
  }));
}

afterAll(() => {
  if (process.env.DB_LOAD_JSON) writeFileSync(process.env.DB_LOAD_JSON, JSON.stringify(results, null, 2));
});

describe("database load of N Runners", () => {
  it("an idle Runner issues a small constant number of statements from its background loops", async () => {
    const rows: Array<Record<string, string | number>> = [];
    for (const runners of RUNNER_COUNTS) {
      const fleet = await fleetOf(runners, OMA_TEST_TURN);
      const from = Date.now();
      await runFor(60_000);
      const calls = runnerCalls(fleet, from);
      const perRunnerPerSecond = statementCount(calls) / 60 / runners;
      rows.push(...sourceRows(calls, 60, runners, "Runner").map((row) => ({ runners, ...row })));
      results[`idle/${runners}`] = { perRunnerPerSecond, bySource: Object.fromEntries([...bySource(calls)].map(([source, totals]) => [source, totals.statements])) };
      // ≈1.0: a 5 s pending scan + cleanup discovery and a 15 s Loop dispatch query.
      expect(perRunnerPerSecond).toBeLessThan(2);
      await fleet.stop();
    }
    table("Idle Runners (60 s, no Sessions)", rows);
  }, 60_000);

  it("concurrent long Turns: heartbeat, tool fences, Turn lifecycle and non-owner claim attempts", async () => {
    const sessions = 8;
    const summary: Array<Record<string, string | number>> = [];
    for (const runners of RUNNER_COUNTS) {
      const fleet = await fleetOf(runners, OMA_TEST_TURN);
      const idle = await Promise.all(Array.from({ length: 20 }, () => fleet.createSession()));
      const active = await Promise.all(Array.from({ length: sessions }, () => fleet.createSession()));
      const from = Date.now();
      for (const session of active) await fleet.send(session.id);
      await runFor(360_000);
      const seconds = (Date.now() - from) / 1000;
      for (const session of active) expect(await fleet.completedTurns(session.id)).toBe(1);
      expect(fleet.errors).toEqual([]);

      const calls = runnerCalls(fleet, from);
      // Idle Sessions cost a Runner nothing: no statement ever names one.
      const idleIds = new Set(idle.map(({ id }) => id));
      expect(calls.filter((call) => call.sessionId && idleIds.has(call.sessionId))).toEqual([]);

      const turnSeconds = fleet.meter.turns.reduce((sum, turn) => sum + ((turn.end ?? Date.now()) - turn.start) / 1000, 0);
      const sources = bySource(calls);
      const statementsOf = (predicate: (source: string) => boolean) =>
        [...sources].filter(([source]) => predicate(source)).reduce((sum, [, totals]) => sum + totals.statements, 0);
      const heartbeat = statementsOf((source) => source === "heartbeat");
      const toolOp = sources.get("tool-op");
      const fences = toolOp?.methods.get("pendingEventStore.ownsClaim")?.statements ?? 0;
      const turn = sources.get("turn");
      const appends = turn?.methods.get("eventLogStore.append")?.statements ?? 0;
      const attempts = statementsOf((source) => source.startsWith("attempt"));
      const wakes = statementsOf((source) => source.startsWith("wake"));
      const scans = statementsOf((source) => source === "dispatch-scan" || source === "loop-scan" || source === "cleanup-sweep");
      const scanLookups = calls.filter((call) => (call.source === "dispatch-scan" || call.source === "loop-scan") &&
        call.method === "sessionStore.getById").length;
      const contended = calls.filter((call) => call.claimOutcome === "contended").length;
      const toolOps = sessions * OMA_TEST_TURN.steps * OMA_TEST_TURN.sandboxOpsPerTool;
      const row = {
        runners,
        "Turn-seconds": round(turnSeconds, 0),
        "all statements/s": round(statementCount(calls) / seconds, 1),
        "heartbeat /s per active Turn": round(heartbeat / turnSeconds),
        "fence per sandbox op": round(fences / toolOps),
        "sandbox creation per Session": round(((toolOp?.statements ?? 0) - fences) / sessions, 0),
        "Turn lifecycle per Turn": round((turn?.statements ?? 0) / sessions, 0),
        "of which event appends": round(appends / sessions, 0),
        "non-owner attempts /s per active Turn": round(attempts / turnSeconds),
        "contended claims per Turn per other Runner": runners > 1 ? round(contended / sessions / (runners - 1), 1) : 0,
        "wake handling /s per active Turn": round(wakes / turnSeconds, 3),
        "scan getById /s per active Turn per Runner": round(scanLookups / turnSeconds / runners, 3),
        "scans /s per Runner": round(scans / seconds / runners),
      };
      summary.push(row);
      results[`turns/${runners}`] = { ...row, bySource: Object.fromEntries([...sources].map(([source, totals]) => [source,
        { statements: totals.statements, methods: Object.fromEntries([...totals.methods].map(([method, { statements }]) => [method, statements])) }])),
      seqScans: Object.fromEntries(seqScans(calls)) };
      table(`Concurrent Turns, ${runners} Runner(s), ${sessions} Sessions (+20 idle), ${round(seconds, 0)} s`,
        sourceRows(calls, seconds, sessions, "active Turn"));
      const background = (source: string) => source === "dispatch-scan" || source === "loop-scan" || source === "cleanup-sweep";
      const turnScans = seqScans(calls.filter((call) => !background(call.source)));
      const scanScans = seqScans(calls.filter((call) => background(call.source)));
      table(`Whole-table scans by table, ${runners} Runner(s)`, [...new Set([...turnScans.keys(), ...scanScans.keys()])].map((name) => ({
        table: name, "per Turn (Turn activity)": round((turnScans.get(name) ?? 0) / sessions, 1),
        "per Runner per minute (background scans)": round((scanScans.get(name) ?? 0) / runners / (seconds / 60), 1) })));
      if (runners === 1) table("Turn lifecycle (claim to ack) by method, per Turn",
        [...turn!.methods].sort(([, a], [, b]) => b.statements - a.statements).map(([method, totals]) => ({
          method, calls: round(totals.calls / sessions, 1), statements: round(totals.statements / sessions, 1) })));

      // Tripwires: the heartbeat renews every 10 s (≈0.4/s per Turn; a 1 s tick costs 6/s).
      expect(row["heartbeat /s per active Turn"]).toBeLessThan(1);
      // Another Runner claims an owned head only on a wake (≈0.01/s per Turn);
      // retrying it, or listing it in every 5 s scan, costs ≥1.2/s per Runner.
      expect(row["non-owner attempts /s per active Turn"]).toBeLessThan(0.1 * runners);
      expect(row["scan getById /s per active Turn per Runner"]).toBeLessThan(0.05);
      await fleet.stop();
    }
    table("Concurrent Turns: per-unit costs", summary);
  }, 120_000);

  it("a synchronous delegation wait reads its execution on the child's completion hint and a 2 s fallback poll", async () => {
    const parents = 4;
    const child: TurnShape = { steps: 3, modelMs: 3_000, toolMs: 25_000, sandboxOpsPerTool: 2 };
    const shape: TurnShape = { steps: 2, modelMs: 3_000, toolMs: 25_000, sandboxOpsPerTool: 2, delegateAtStep: 0, child };
    const summary: Array<Record<string, string | number>> = [];
    for (const runners of RUNNER_COUNTS) {
      const fleet = await fleetOf(runners, shape);
      const sessions = await Promise.all(Array.from({ length: parents }, () => fleet.createSession()));
      const from = Date.now();
      for (const session of sessions) await fleet.send(session.id);
      await runFor(180_000);
      const seconds = (Date.now() - from) / 1000;
      for (const session of sessions) expect(await fleet.completedTurns(session.id)).toBe(1);
      expect(fleet.errors).toEqual([]);

      const calls = runnerCalls(fleet, from);
      const parentIds = new Set(sessions.map(({ id }) => id));
      // A parent waits while its child's Turn runs.
      const waitSeconds = fleet.meter.turns.filter((turn) => !parentIds.has(turn.sessionId))
        .reduce((sum, turn) => sum + ((turn.end ?? Date.now()) - turn.start) / 1000, 0);
      const sources = bySource(calls);
      const statementsOf = (predicate: (source: string) => boolean) =>
        [...sources].filter(([source]) => predicate(source)).reduce((sum, [, totals]) => sum + totals.statements, 0);
      const poll = statementsOf((source) => source === "delegation-wait");
      const fanOut = statementsOf((source) => source.includes("wake <- delegation-wait"));
      const commandPolls = calls.filter((call) => call.source === "heartbeat" && call.method === "delegationStore.listCommands").length;
      const row = {
        runners,
        "waiting parent-seconds": round(waitSeconds, 0),
        "poll /s per waiting parent": round(poll / waitSeconds, 1),
        "wake fan-out /s per waiting parent": round(fanOut / waitSeconds, 1),
        "global delegation_lock transactions per delegation": round(calls.filter((call) =>
          call.statements.some((statement) => statement.table === "delegation_lock")).length / parents, 1),
        "heartbeat listCommands (seq scan) /s per active child": round(commandPolls / waitSeconds),
      };
      summary.push(row);
      results[`delegation/${runners}`] = { ...row, bySource: Object.fromEntries([...sources].map(([source, totals]) => [source, totals.statements])) };
      table(`Synchronous delegation, ${runners} Runner(s), ${parents} parents, ${round(seconds, 0)} s`,
        sourceRows(calls, seconds, parents, "parent"));
      const delegationScans = seqScans(calls.filter((call) => !["dispatch-scan", "loop-scan", "cleanup-sweep"].includes(call.source)));
      table(`Whole-table scans per delegation (parent + child Turn), ${runners} Runner(s)`,
        [...delegationScans].map(([name, count]) => ({ table: name, "per delegation": round(count / parents, 1) })));
      // Tripwire: ≈1.7/s per waiting parent, independent of the Runner count. A
      // 200 ms poll with a wake per poll cost 31/s plus 35/s per other Runner.
      expect(row["poll /s per waiting parent"] + row["wake fan-out /s per waiting parent"]).toBeLessThan(5);
      await fleet.stop();
    }
    table("Synchronous delegation: per waiting parent", summary);
  }, 120_000);

  it("each claim re-reads the Session's whole log, 1,000 rows per statement", async () => {
    const shape: TurnShape = { steps: 1, modelMs: 1_000, toolMs: 1_000, sandboxOpsPerTool: 1 };
    const rows: Array<Record<string, string | number>> = [];
    // The log holds the history plus the promoted input when the claim reads it.
    const expectedReads = new Map([[0, 1], [500, 1], [2_000, 3], [5_000, 6]]);
    for (const [history, pages] of expectedReads) {
      const fleet = await fleetOf(1, shape);
      const session = await fleet.createSession();
      for (let index = 0; index < history; index++) {
        await fleet.raw.eventLogStore.append(session.id, { type: "agent.message", sessionThreadId: "sthr_primary",
          data: { content: [{ type: "text", text: `earlier ${index}` }] } });
      }
      const from = Date.now();
      await fleet.send(session.id);
      await runFor(10_000);
      expect(await fleet.completedTurns(session.id)).toBe(1);
      const reads = runnerCalls(fleet, from).filter((call) => call.method === "eventLogStore.getEvents" && call.sessionId === session.id);
      rows.push({ "events before the Turn": history, "getEvents statements per Turn": reads.length,
        "rows returned per Turn": reads.reduce((sum, call) => sum + (call.rows ?? 0), 0) });
      expect(reads.length).toBe(pages);
      await fleet.stop();
    }
    results.history = rows;
    table("Full log read on claim (1 Runner)", rows);
  }, 60_000);

  it("a cleanup that cannot complete is retried every 5 s, forever", async () => {
    const shape: TurnShape = { steps: 1, modelMs: 1_000, toolMs: 1_000, sandboxOpsPerTool: 1 };
    const fleet = await fleetOf(2, shape);
    const session = await fleet.createSession();
    await fleet.send(session.id);
    await runFor(10_000);
    expect(await fleet.completedTurns(session.id)).toBe(1);
    await fleet.terminate(session.id);
    const from = Date.now();
    await runFor(60_000);
    const calls = runnerCalls(fleet, from).filter((call) => call.source === "cleanup-sweep");
    const attempts = calls.filter((call) => call.method === "sessionCleanup.attempt").length;
    const skips = calls.filter((call) => call.method === "sessionCleanup.skip").length;
    const environmentStatements = calls.flatMap((call) => call.statements).filter((statement) => statement.table === "delegation_environments").length;
    const row = {
      "cleanup attempts /min": attempts,
      "SKIP LOCKED misses /min": skips,
      "statements/s per stuck row": round(statementCount(calls) / 60),
      "delegation_environments statements/s": round(environmentStatements / 60),
      "sessions statements/s": round(calls.flatMap((call) => call.statements).filter((statement) => statement.table === "sessions").length / 60),
    };
    results.stuckCleanup = row;
    table("One cleanup row that cannot complete, 2 Runners, 60 s", [row]);
    table("Cleanup retry: statements by method", sourceRows(calls, 60, 1, "stuck row"));
    // No backoff: 5 s retry per row regardless of how often it failed.
    expect(attempts).toBeGreaterThanOrEqual(10);
    await fleet.stop();
  }, 60_000);
});
