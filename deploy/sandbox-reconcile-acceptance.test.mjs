import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  END_MARKER, bindingState, distribution, evaluateKill, parseSweepLines, percentile, plannedCountersFromReport,
  prepareSpans, reportRows, summarizeBurst, summarizeSession, summarizeSweep, toolResults,
} from "./scripts/verify-sandbox-reconcile.mjs";

const script = new URL("scripts/verify-sandbox-reconcile.mjs", import.meta.url).pathname;
const at = (s) => new Date(Date.UTC(2026, 9, 25, 2, 0, 0) + s * 1000).toISOString();

/** Events as GET /v1/sessions/{id}/events returns them: native entries and the display events derived from them. */
function turn({ marker, start = 0, failFirst = null, resumedAt = null, unavailable = false, answer = true, prepare = [] }) {
  const events = [];
  let seq = 0;
  const push = (s, type, data) => events.push({ seq: ++seq, ts: at(s), type, data });
  push(start, "user.message", { content: [{ type: "text", text: "go" }] });
  const call = (s, id, ok, text, details) => {
    push(s, "agent.context_entry", { turnId: "t1", entry: { id: `e-${id}`, type: "message", message: { role: "assistant",
      content: [{ type: "toolCall", id, name: "bash", arguments: { command: `echo ${marker}` } }] } } });
    push(s, "agent.tool_use", { turnId: "t1", toolUseId: id, name: "bash", input: { command: `echo ${marker}` }, sourceEntryId: `e-${id}` });
    push(s + 1, "agent.context_entry", { turnId: "t1", entry: { id: `r-${id}`, type: "message", message: { role: "toolResult",
      toolCallId: id, toolName: "bash", isError: !ok, content: [{ type: "text", text }], ...(details ? { details } : {}) } } });
    push(s + 1, "agent.tool_result", { turnId: "t1", toolUseId: id, isError: !ok, content: [{ type: "text", text }], sourceEntryId: `r-${id}` });
  };
  for (const p of prepare) push(start + p.at, p.type, { turnId: "t1", ...p.data });
  if (failFirst) call(start + 2, "c0", false, `Sandbox is not ready (${failFirst})`, failFirst === "text-only" ? undefined : { code: failFirst });
  if (resumedAt !== null) push(resumedAt, "session.turn_resumed", { turnId: "t1", reason: "expired", generation: 2 });
  if (!unavailable) call((resumedAt ?? start) + 10, "c1", true, `${marker}\n`);
  if (unavailable) push(start + 200, "session.error", { turnId: "t1", error: { code: "sandbox_unavailable", message: "x" } });
  if (answer && !unavailable) push(start + 15, "agent.message", { turnId: "t1", content: [{ type: "text", text: `RESULT:${marker}` }], sourceEntryId: "m" });
  push(start + 210, "session.turn_completed", { turnId: "t1", pendingEventId: "p" });
  return events;
}

test("percentile and distribution use nearest rank and ignore non-numbers", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 95), 5);
  const values = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(values, 50), 50);
  assert.equal(percentile(values, 95), 95);
  assert.deepEqual(distribution([3, undefined, 1, NaN, 2]), { count: 3, min: 1, p50: 2, p95: 3, max: 3 });
});

test("tool results are counted once, with the Sandbox code from details or the text", () => {
  const events = turn({ marker: "m1", failFirst: "sandbox_creating" });
  const results = toolResults(events);
  assert.equal(results.length, 2, "display events derived from native entries are not counted again");
  assert.deepEqual(results.map((r) => [r.name, r.isError, r.code ?? null]), [["bash", true, "sandbox_creating"], ["bash", false, null]]);
  const fromText = toolResults(turn({ marker: "m1", failFirst: "text-only" }));
  assert.equal(fromText[0].code, undefined, "no code without details or a known code in the text");
  const host = [{ seq: 1, ts: at(0), type: "agent.tool_use", data: { toolUseId: "c9", name: "bash" } },
    { seq: 2, ts: at(1), type: "agent.tool_result", data: { id: "recovery_c9", toolUseId: "c9", isError: true, content: [{ type: "text", text: "sandbox_unavailable: gone" }] } }];
  assert.deepEqual(toolResults(host).map((r) => [r.source, r.name, r.code]), [["host", "bash", "sandbox_unavailable"]]);
});

test("a Turn that recovered from a Sandbox error used its Sandbox and records no session.error", () => {
  const s = summarizeSession(turn({ marker: "m2", failFirst: "sandbox_creating" }), { marker: "m2" });
  assert.equal(s.completed, true);
  assert.equal(s.sandboxUsed, true);
  assert.equal(s.answered, true);
  assert.equal(s.endedSandboxUnavailable, false);
  assert.deepEqual(s.toolErrors.map((e) => e.code), ["sandbox_creating"]);
  assert.equal(s.bashCalls, 2);
});

test("prepare spans pair by id, else by Turn order, and count retries after a failed end", () => {
  const prepare = [
    { at: 1, type: "span.sandbox_prepare_start", data: {} },
    { at: 4, type: "span.sandbox_prepare_end", data: { outcome: "failed", code: "sandbox_creating" } },
    { at: 5, type: "span.sandbox_prepare_start", data: { prepareId: "b" } },
    { at: 9, type: "span.sandbox_prepare_end", data: { prepareId: "b", outcome: "ready", sandboxId: "sb-1", durationMs: 3500 } },
    { at: 20, type: "span.sandbox_prepare_start", data: {} },
  ];
  const events = turn({ marker: "m3", prepare });
  const spans = prepareSpans(events);
  assert.deepEqual(spans.map((s) => [s.outcome, s.ok, s.durationMs ?? null]), [["failed", false, 3000], ["ready", true, 3500], ["open", false, null]]);
  assert.equal(spans[1].sandboxId, "sb-1");
  const s = summarizeSession(events, { marker: "m3" });
  assert.equal(s.prepareRetries, 1);
});

test("binding states follow the derived state machine", () => {
  assert.equal(bindingState(undefined), "cold");
  assert.equal(bindingState({ sandbox_id: null, creating_since: null }), "cold");
  assert.equal(bindingState({ sandbox_id: null, creating_since: at(0), past_deadline: false }), "creating");
  assert.equal(bindingState({ sandbox_id: null, creating_since: at(0), past_deadline: true }), "unresolved");
  assert.equal(bindingState({ sandbox_id: "sb", creating_since: null }), "ready");
});

test("the burst passes only when every Turn completed, used its Sandbox, and no binding or Turn is stuck", () => {
  const ok = (id) => ({ sessionId: id, submitted: true, summary: summarizeSession(turn({ marker: id, failFirst: "sandbox_creating" }), { marker: id }) });
  const ready = (id) => [id, { sandbox_id: `sb-${id}`, creating_since: null, past_deadline: false }];
  const entries = [ok("a"), ok("b"), { sessionId: "c", submitted: false, summary: null }];
  const bindings = new Map([ready("a"), ready("b")]);
  const sandboxes = new Map([["a", { state: "ready", since: at(0), last_error: null }], ["b", { state: "ready", last_error: { code: "sandbox_creating" } }]]);
  const seen = { a: { creatingSince: at(0), readyAt: at(30) }, b: { creatingSince: at(0) } };
  const pass = summarizeBurst(entries, { bindings, sandboxes, seen });
  assert.deepEqual(pass.checks.filter((c) => c.acceptance).map((c) => c.ok), [true, true, true, true]);
  assert.equal(pass.metrics.submitted, 2);
  assert.deepEqual(pass.metrics.toolErrorsByCode, { sandbox_creating: 2 });
  assert.deepEqual(pass.metrics.sandbox, { byState: { ready: 2 }, lastErrorCodes: { sandbox_creating: 1 } });
  assert.deepEqual(pass.metrics.creatingToReadySampledMs, { count: 1, min: 30000, p50: 30000, p95: 30000, max: 30000 });
  assert.equal(pass.checks.find((c) => c.name.includes("rolling restart")).ok, false, "no takeover is reported, not failed");

  const stuck = summarizeBurst(entries, { bindings: new Map([ready("a"), ["b", { sandbox_id: null, creating_since: at(0), past_deadline: true }]]) });
  assert.deepEqual(stuck.metrics.bindings.stuckCreatingPastDeadline, ["b"]);
  assert.equal(stuck.checks.find((c) => c.name.includes("Creating past")).ok, false);

  const failing = { sessionId: "d", submitted: true, summary: summarizeSession(turn({ marker: "d", unavailable: true }), { marker: "d" }) };
  const unavailable = summarizeBurst([ok("a"), failing], { bindings });
  assert.deepEqual(unavailable.metrics.endedSandboxUnavailable, ["d"]);
  assert.deepEqual(unavailable.checks.filter((c) => !c.ok && c.acceptance).map((c) => c.name),
    ["burst: no Turn ended with sandbox_unavailable", "burst: Sessions that used their Sandbox ≥ 100%"]);

  const incomplete = summarizeBurst([ok("a"), { sessionId: "e", submitted: true, summary: null }], { bindings });
  assert.equal(incomplete.checks[0].ok, false);
  assert.deepEqual(incomplete.metrics.notCompleted, ["e"]);
});

test("the burst counts takeovers that came before the Sandbox was first used", () => {
  const s = summarizeSession(turn({ marker: "f", start: 0, failFirst: "sandbox_creating", resumedAt: 40 }), { marker: "f" });
  const { metrics, checks } = summarizeBurst([{ sessionId: "f", submitted: true, summary: s }], { bindings: new Map([["f", { sandbox_id: "sb" }]]) });
  assert.deepEqual(metrics.takeovers, { sessions: 1, byReason: { expired: 1 }, beforeFirstSandboxUse: 1 });
  assert.equal(checks.find((c) => c.name.includes("rolling restart")).ok, true);
});

test("a kill during creation passes when the tool is used again within 180 s of the takeover and of the intent plus margin", () => {
  // Intent at 0 s, kill at 5 s, takeover at 35 s, Sandbox used at 45 s.
  const events = turn({ marker: "k", start: 0, resumedAt: 35 });
  const pass = evaluateKill({ events, marker: "k", creatingSince: at(0), disruptedAt: at(5) });
  assert.deepEqual(pass.checks.filter((c) => !c.ok).map((c) => c.name), []);
  assert.equal(pass.metrics.msKillToTakeover, 30_000);
  assert.equal(pass.metrics.msTakeoverToTool, 11_000);

  // Used again 215 s after the takeover and 250 s after the intent: both bounds fail.
  const late = evaluateKill({ events: turn({ marker: "k", start: 0, resumedAt: 35 }).map((x) =>
    x.data?.entry?.message?.toolCallId === "c1" ? { ...x, ts: at(250) } : x), marker: "k", creatingSince: at(0), disruptedAt: at(5) });
  assert.deepEqual(late.checks.filter((c) => !c.ok && c.acceptance).map((c) => c.name),
    ["kill: tool use resumed within 180 s of the takeover", "kill: tool use resumed within 180 s + 60 s of the creation intent"]);

  const noTakeover = evaluateKill({ events: turn({ marker: "k", start: 0 }), marker: "k", creatingSince: at(0), disruptedAt: at(5) });
  assert.equal(noTakeover.checks.find((c) => c.name === "kill: takeover recorded after the kill").ok, false);
  assert.equal(noTakeover.checks.find((c) => c.name.includes("of the takeover")).ok, false);
});

const report = `# Sandbox sweep report: test (schema oma_test), 2026-10-25T02:05:00Z

## Decisions

Planned \`sandbox_sweep\` counters:

\`\`\`json
{"msg":"sandbox_sweep","env":"test","orphans":2,"unresolved":1,"unusedRunning":0,"noDeadline":0,"killed":2,"adopted":1}
\`\`\`

## Sandboxes

| sandboxId | binding | environment | state | startedAt | endAt | binding row | recorded | decision | reason |
|---|---|---|---|---|---|---|---|---|---|
| sb-1 | sess_a | test | running | 2026-10-25T02:00:00Z | 2026-10-25T02:30:00Z | Creating(2026-10-25T02:00:00Z), in use | no | adopt | unresolved |
| sb-2 | sess_b | test | running | 2026-10-25T02:00:00Z | 2026-10-25T02:30:00Z | Ready(other) | no | kill | superseded |
| sb-3 | sess_x | test | paused | 2026-10-25T01:00:00Z | 2026-10-26T01:00:00Z | Ready(this) | yes | keep | paused |

<!-- end of report -->
`;

test("the report's planned counters and this run's rows are read from its markdown", () => {
  assert.deepEqual(plannedCountersFromReport(report), { at: "2026-10-25T02:05:00Z", msg: "sandbox_sweep", env: "test",
    orphans: 2, unresolved: 1, unusedRunning: 0, noDeadline: 0, killed: 2, adopted: 1 });
  assert.deepEqual(reportRows(report, ["sess_a", "sess_b"]).map((r) => [r.sandboxId, r.decision, r.reason]),
    [["sb-1", "adopt", "unresolved"], ["sb-2", "kill", "superseded"]]);
});

test("sweep lines are grouped per container, checked for spacing and compared with the report", () => {
  const line = (pod, s, counts) => `${pod} ${at(s).replace(".000Z", ".123456789Z")} ${JSON.stringify({ msg: "sandbox_sweep", env: "test", ...counts, ms: 140 })}`;
  const zero = { orphans: 0, unresolved: 0, unusedRunning: 0, noDeadline: 0, killed: 0, adopted: 0 };
  const text = [
    line("oma-runner-a", 0, zero),
    "oma-runner-a 2026-10-25T02:00:01Z {\"msg\":\"turn_journal_flush\",\"sessionId\":\"s\"}",
    line("oma-runner-b", 200, zero),
    line("oma-runner-a", 360, { orphans: 2, unresolved: 1, unusedRunning: 0, noDeadline: 0, killed: 2, adopted: 1 }),
    line("oma-runner-b", 830, zero),
    line("oma-runner-a(previous)", 10, zero),
    "garbage",
  ].join("\n");
  const rounds = parseSweepLines(text);
  assert.equal(rounds.length, 5);
  assert.deepEqual([...new Set(rounds.map((r) => r.source))].sort(), ["oma-runner-a", "oma-runner-a(previous)", "oma-runner-b"]);
  const planned = plannedCountersFromReport(report);
  const { bySource, comparison, checks } = summarizeSweep(rounds, { planned });
  assert.deepEqual(bySource["oma-runner-a"].intervalsSeconds, { count: 1, min: 360, p50: 360, p95: 360, max: 360 });
  assert.deepEqual(bySource["oma-runner-b"].outOfBand, []);
  assert.equal(comparison.round.source, "oma-runner-a");
  assert.deepEqual(comparison.diffs, []);
  assert.deepEqual(checks.map((c) => c.ok), [true, true, true, true]);

  const drift = summarizeSweep(rounds, { planned: { ...planned, orphans: 3 }, maxIntervalSeconds: 600 });
  assert.deepEqual(drift.comparison.diffs, [{ counter: "orphans", report: 3, round: 2 }]);
  assert.deepEqual(drift.checks.filter((c) => !c.ok).map((c) => c.name),
    ["sweep: a Runner logged consecutive rounds 300–600 s apart", "sweep: the first round after the report matches its planned counters"]);
  assert.equal(summarizeSweep([], {}).checks[0].ok, false);
});

test("the script refuses to run outside the oma-test API Pod and always ends with its end marker", () => {
  let out;
  try {
    execFileSync("node", [script, "check", "/tmp/none.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, VERIFY_SCHEMA: "oma" } });
    assert.fail("expected a failure");
  } catch (error) {
    out = error.stdout;
    assert.equal(error.status, 1);
  }
  assert.equal(out.trim().split("\n").at(-1), `${END_MARKER} phase=check ok=false`);
});

test("sweep-summary runs locally on stdin and exits non-zero without rounds", () => {
  const ok = execFileSync("node", [script, "sweep-summary", "--max-interval", "1000"], { encoding: "utf8",
    input: [0, 600].map((s) => `oma-runner-a ${at(s)} {"msg":"sandbox_sweep","env":"test","orphans":0,"unresolved":0,"unusedRunning":0,"noDeadline":0,"killed":0,"adopted":0,"ms":3}`).join("\n") });
  assert.match(ok, /ACCEPTANCE PASSED/);
  assert.equal(ok.trim().split("\n").at(-1), `${END_MARKER} phase=sweep-summary ok=true`);
  assert.throws(() => execFileSync("node", [script, "sweep-summary"], { input: "", stdio: ["pipe", "pipe", "pipe"] }), (e) => e.status === 1);
});

/**
 * A fake oma-test: the API the phases call and the SQL they send. Burst bindings go Creating → Ready on
 * their second read; the kill Session's binding stays Creating until its Turn is read after the kill.
 */
function fakeOmaTest() {
  const sessions = new Map();
  const bindings = new Map();
  let next = 0;
  const ev = (id, list) => list.map(([s, type, data], i) => ({ seq: i + 1, ts: new Date(s).toISOString(), type, data: { turnId: "t1", ...data } }));
  const result = (id, ok, text, details) => ({ entry: { id: `r-${id}`, type: "message", message: { role: "toolResult", toolCallId: id, toolName: "bash", isError: !ok, content: [{ type: "text", text }], ...(details ? { details } : {}) } } });
  const use = (id, marker) => ({ toolUseId: id, name: "bash", input: { command: `echo ${marker}` } });
  function eventsOf(id) {
    const s = sessions.get(id);
    if (s.kill) {
      const b = bindings.get(id);
      const cs = s.creatingSince;
      b.sandbox_id = `sb-${id}`;
      b.creating_since = null;
      return ev(id, [[s.messagedAt, "user.message", {}], [cs, "agent.tool_use", use("c0", s.marker)],
        [cs, "span.sandbox_prepare_start", {}], [cs + 35_000, "session.turn_resumed", { reason: "expired", generation: 2 }],
        [cs + 35_000, "agent.tool_result", { id: "recovery_c0", toolUseId: "c0", isError: true, content: [{ type: "text", text: "outcome is unknown" }] }],
        [cs + 36_000, "span.sandbox_prepare_start", {}], [cs + 40_000, "agent.tool_use", use("c1", s.marker)],
        [cs + 44_000, "span.sandbox_prepare_end", { outcome: "adopted", sandboxId: `sb-${id}`, durationMs: 8000 }],
        [cs + 45_000, "agent.context_entry", result("c1", true, `${s.marker}\n`)],
        [cs + 46_000, "agent.message", { content: [{ type: "text", text: `RESULT:${s.marker}` }] }], [cs + 47_000, "session.turn_completed", {}]]);
    }
    const t = s.messagedAt;
    const retry = s.n === 1;
    return ev(id, [[t, "user.message", {}], [t + 1000, "span.sandbox_prepare_start", {}],
      ...(retry ? [[t + 1500, "agent.tool_use", use("c0", s.marker)], [t + 2000, "span.sandbox_prepare_end", { outcome: "failed", code: "sandbox_creating", durationMs: 1000 }],
        [t + 2000, "agent.context_entry", result("c0", false, "not ready", { code: "sandbox_creating" })], [t + 2500, "span.sandbox_prepare_start", {}],
        [t + 2600, "session.turn_resumed", { reason: "released", generation: 2 }]] : []),
      [t + 3000, "agent.tool_use", use("c1", s.marker)], [t + 4000, "span.sandbox_prepare_end", { outcome: "created", sandboxId: `sb-${id}`, durationMs: 3000 + s.n * 1000 }],
      [t + 5000, "agent.context_entry", result("c1", true, `${s.marker}\n`)],
      [t + 6000, "agent.message", { content: [{ type: "text", text: `RESULT:${s.marker}` }] }], [t + 7000, "session.turn_completed", {}]]);
  }
  const json = (value, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(value) });
  async function fetch(url, init = {}) {
    const u = new URL(url);
    if (u.host === "files.example") return { ok: true, status: 200, text: async () => `${u.pathname.slice(1)}\n` };
    assert.equal(u.origin + "/api", "https://agentry-test.welltop.tech/api");
    assert.equal(init.headers?.["x-api-key"], "raw-key");
    const path = u.pathname.replace(/^\/api/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    let m;
    if (method === "POST" && path === "/v1/agents") {
      assert.equal(body.sandbox.image, "oma-scale-test-20261021");
      assert.equal(body.sandbox.env.VFS_TOKEN, "");
      return json({ id: "agent_1" }, 201);
    }
    if (method === "POST" && path === "/v1/sessions") {
      const id = `sess_${next++}`;
      sessions.set(id, { n: sessions.size, kill: body.workspace_id.endsWith("-kill") });
      return json({ id, workspaceId: body.workspace_id }, 201);
    }
    if ((m = path.match(/^\/v1\/sessions\/([^/]+)\/events$/))) {
      const s = sessions.get(m[1]);
      if (method === "GET") return json({ data: eventsOf(m[1]), has_more: false });
      s.marker = body.events[0].data.content[0].text.match(/RESULT:(\S+) and nothing/)[1];
      s.messagedAt = Date.now();
      s.creatingSince = Date.now() - 1000;
      bindings.set(m[1], { sandbox_id: null, creating_since: new Date(s.creatingSince), reclaiming: false, reads: 0, kill: s.kill });
      return json({});
    }
    if ((m = path.match(/^\/v1\/sessions\/([^/]+)$/))) {
      if (method === "DELETE") {
        Object.assign(bindings.get(m[1]) ?? {}, { sandbox_id: null, creating_since: null });
        sessions.get(m[1]).terminated = true;
        return json({ type: "session_terminated", id: m[1] });
      }
      return json({ id: m[1], status: "idle", sandbox: { state: "ready", since: new Date().toISOString(), last_error: null } });
    }
    if (path === "/v1/sessions") return json({ data: [], has_more: false });
    if ((m = path.match(/^\/v1\/workspaces\/[^/]+\/files\/(.+)\.txt$/))) return json({ url: `https://files.example/${m[1]}` });
    return json({ error: `no route ${method} ${path}` }, 404);
  }
  function sql(text, params = []) {
    if (/^(BEGIN|SET LOCAL|ROLLBACK)/.test(text)) return { rows: [] };
    if (text.includes("information_schema.columns")) return { rows: [{ column_name: "creating_since" }] };
    if (text.includes("FROM delegation_environments e WHERE e.id = ANY")) {
      const [ids, deadline] = params;
      return { rows: ids.filter((id) => bindings.has(id)).map((id) => {
        const b = bindings.get(id);
        if (!b.kill && ++b.reads >= 2 && b.creating_since) Object.assign(b, { sandbox_id: `sb-${id}`, creating_since: null });
        return { id, sandbox_id: b.sandbox_id, creating_since: b.creating_since, reclaiming: b.reclaiming, db_now: new Date(), extra: {},
          past_deadline: !!(b.creating_since && !b.sandbox_id && Date.now() >= b.creating_since.getTime() + deadline * 1000) };
      }) };
    }
    if (text.includes("FROM pending_events WHERE session_id = $1")) return { rows: [{ id: "pe", claim_owner: "host_abc", claim_generation: "1", claim_expires_at: new Date() }] };
    if (text.includes("FROM unnest($1::text[]) AS s(id)")) return { rows: params[0].map((id) => ({ id, completed: 1, inputs: sessions.get(id).messagedAt ? 1 : 0 })) };
    if (text.includes("WITH alive AS")) return { rows: [{ total: 10, ready: 2, creating: 3, creating_epoch: 3, creating_epoch_alive: 1, reclaiming: 0 }] };
    if (text.includes("live_claims")) return { rows: [{ total: 0, live_claims: 0 }] };
    if (text.includes("FROM session_cleanup")) return { rows: params[0].map((id) => ({ session_id: id, completed_at: new Date(), attempts: 1 })) };
    throw new Error(`unexpected SQL: ${text.slice(0, 80)}`);
  }
  class Pool {
    constructor(options) { assert.equal(options.options, "-c search_path=oma_test"); }
    async connect() { return { query: async (t, p) => sql(t, p), release() {} }; }
    async end() {}
  }
  class PgApiKeyStore {
    async create(tenant, name) { return { rawKey: "raw-key", apiKey: { id: `key-${name}` } }; }
    async revoke() { return true; }
  }
  return { fetch, deps: { Pool, PgApiKeyStore }, bindings, sessions };
}

test("every live phase runs end to end against a fake oma-test", async (t) => {
  const { live } = await import("./scripts/verify-sandbox-reconcile.mjs");
  const { mkdtemp, readFile, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(`${tmpdir()}/reconcile-`);
  const file = `${dir}/evidence.json`;
  const world = fakeOmaTest();
  const saved = { fetch: globalThis.fetch, log: console.log, error: console.error, env: { ...process.env } };
  const lines = [];
  t.after(async () => {
    Object.assign(globalThis, { fetch: saved.fetch });
    Object.assign(console, { log: saved.log, error: saved.error });
    process.env = saved.env;
    await rm(dir, { recursive: true, force: true });
  });
  globalThis.fetch = world.fetch;
  console.log = (line) => lines.push(String(line));
  console.error = (line) => lines.push(`ERR ${line}`);
  Object.assign(process.env, { VERIFY_SCHEMA: "oma_test", OMA_LIVE_BASE_URL: "https://agentry-test.welltop.tech/api",
    VERIFY_BURST_WATCH_SECONDS: "0.3", VERIFY_BURST_SAMPLE_MS: "50" });
  delete process.env.PG_SCHEMA;
  delete process.env.VERIFY_MODEL;
  const run = async (phase, ...args) => {
    const before = lines.length;
    const ok = await live(phase, file, args, world.deps);
    return { ok, out: lines.slice(before) };
  };

  await assert.rejects(run("check"), /no evidence/);
  assert.equal((await run("migration", "post")).ok, true);
  assert.equal((await run("init")).ok, true);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const burst = await run("burst", "3");
  assert.equal(burst.ok, true, burst.out.join("\n"));
  assert.ok(burst.out.some((l) => l.startsWith("DISRUPT_NOW rolling-restart creating=3")), burst.out.join("\n"));
  const check = await run("check", "1");
  assert.equal(check.ok, true, check.out.join("\n"));
  assert.ok(check.out.includes("ACCEPTANCE PASSED"));
  const killStart = await run("kill-start");
  assert.equal(killStart.ok, true, killStart.out.join("\n"));
  assert.ok(killStart.out.some((l) => l.startsWith("CLAIMED session=sess_3 claim_owner=host_abc")));
  assert.ok(killStart.out.some((l) => l.startsWith("DISRUPT_NOW session=sess_3 binding=sess_3")));
  let e = JSON.parse(await readFile(file, "utf8"));
  const killedAt = new Date(Date.parse(e.kill.creatingSince) + 5000).toISOString();
  assert.equal((await run("mark", "kill", killedAt)).ok, true);
  const killFinish = await run("kill-finish");
  assert.equal(killFinish.ok, true, killFinish.out.join("\n"));
  const cleanup = await run("cleanup");
  assert.equal(cleanup.ok, true, cleanup.out.join("\n"));

  e = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(e.checks.filter((c) => !c.ok).map((c) => c.name), []);
  const m = e.burst.result.metrics;
  assert.equal(m.submitted, 3);
  assert.equal(m.sandboxUsed, 3);
  assert.deepEqual(m.toolErrorsByCode, { sandbox_creating: 1 });
  assert.deepEqual(m.takeovers, { sessions: 1, byReason: { released: 1 }, beforeFirstSandboxUse: 1 });
  assert.equal(m.prepare.retries, 1);
  assert.deepEqual(m.prepare.okMs, { count: 3, min: 3000, p50: 4000, p95: 5000, max: 5000 });
  assert.deepEqual(m.bindings.byState, { ready: 3 });
  assert.deepEqual(m.workspaceFiles, { checked: 3, matching: 3 });
  assert.equal(m.creatingToReadySampledMs.count, 3);
  assert.deepEqual(e.kill.result.metrics.msKillToTakeover, 30_000);
  assert.deepEqual(e.kill.result.metrics.msIntentToTool, 45_000);
  assert.equal(e.cleanup.cleanupCompleted, 4);
  assert.deepEqual(e.cleanup.bindingsLeft, []);
  assert.ok(!JSON.stringify(e).includes("raw-key"), "the API key never reaches the evidence");
});
