#!/usr/bin/env node
// Live acceptance for Sandbox binding reconciliation (ADR-0023, #292; parent #278) on oma-test.
//
// Runs inside the oma-test API Pod with `node --import tsx` (the container's working directory,
// /app/server/packages/api, resolves tsx). It refuses any schema but oma_test and any base URL but
// https://agentry-test.welltop.tech/api, creates its own tenant with a temporary API key per phase
// (revoked at the end of the phase), reads only its own Sessions (plus aggregate counts in
// `migration`), only SELECTs from PostgreSQL inside READ ONLY transactions, and keeps its evidence
// in one JSON file (mode 0600). It never kills, scales or restarts anything: where the operator
// acts it prints `DISRUPT_NOW ...` and stops or keeps observing. Every run ends its stdout with
//   END verify-sandbox-reconcile phase=<phase> ok=<true|false>
// because output can be cut off on the way out of these ACS Pods. Run phases one at a time: each
// one reads and rewrites the evidence file.
//
// Use deploy/scripts/run-sandbox-reconcile-acceptance.sh, which copies this file into a fresh /tmp
// directory of the API Pod (never `kubectl exec -i`: output after stdin's EOF is lost there), runs
// one phase without -i, checks the end marker and copies the evidence back after every phase.
//
//   in the API Pod, through the wrapper ($R <phase> [args]; it sets VERIFY_SCHEMA and OMA_LIVE_BASE_URL):
//     migration <pre|post|after-sweep>  column state and aggregate binding/claim counts (SQL only)
//     init                            test Agent: pi-agent, VERIFY_MODEL, template oma-scale-test-20261021, blanked env
//     burst [N=200]                   N root Sessions, one bash marker each; prints DISRUPT_NOW for the rolling restart
//     check [minutes=25]              waits for every burst Turn, then evaluates the acceptance (exit 1 on failure)
//     kill-start                      one Session; prints CLAIMED, then DISRUPT_NOW while its binding is Creating
//     mark <name> [iso]               timestamps an operator action (`mark kill <KILLED_AT>` also checks the binding)
//     kill-finish                     waits for the Turn; recovery within 180 s of the takeover / 180 s + margin of the intent
//     cleanup                         terminates this tenant's Sessions and checks that termination cleared their bindings
//   locally, plain node, no cluster access:
//     sweep-summary [report.md]       stdin: `<pod> <timestamp> <log line>`; rounds, periods, report comparison
//     report-rows <evidence> <report.md>  rows of the read-only sweep report that belong to this run
//
// Runbook (#292, in this order; KUBECONFIG=~/.kube/agent-platform-config, namespace oma-test; details in
// deploy/README.md § "Sandbox binding reconciliation on oma-test"). R=deploy/scripts/run-sandbox-reconcile-acceptance.sh
//   1. report before:   deploy/scripts/run-sandbox-sweep-report.sh test > report-before.md
//   2. note rollback images; scale Runners to 0: kubectl -n oma-test scale deploy/oma-runner --replicas=0
//   3. $R migration pre                  (no live claim may remain)
//   4. node deploy/scripts/migration-for-env.mjs test deploy/migrations/0024_<name>.sql > 0024-test.sql;
//      review, apply with the privileged migration operator (deploy/README.md § Test migrations)
//   5. deploy the new image: build on vfs-dev, render.mjs test + kubectl diff + apply (restores 2 Runners),
//      rollout status, /api/health. deploy-app.sh is production-only (oma-infra); do not use it here.
//   6. $R migration post                 (creation_pending gone, creating_since present)
//   7. $R init
//   8. $R burst 200                      on DISRUPT_NOW: kubectl -n oma-test rollout restart deploy/oma-runner
//   9. $R check                          (≤ 25 min; exit 1 names the failed acceptance checks)
//  10. optional, widens the Creating window: set the test SandboxSet's spec.replicas to 0 (note the old value)
//      $R kill-start; on CLAIMED: $R owner <session>; on DISRUPT_NOW: $R kill-runner <pod> (prints KILLED_AT);
//      $R mark kill <KILLED_AT>; restore spec.replicas at once; $R kill-finish
//  11. wait one sweeper period (10 min ± jitter) after check / kill-finish, then
//      deploy/scripts/run-sandbox-sweep-report.sh test > report-after.md
//      node deploy/scripts/verify-sandbox-reconcile.mjs report-rows <evidence> report-after.md
//      wait for the next round, then $R sweep-logs 90m report-after.md
//  12. $R migration after-sweep; $R cleanup; optionally the report + report-rows once more; $R finish
//  13. write docs/verification/sandbox-reconcile-oma-test-<date>.md (+ the evidence JSON).
//
// ASSUMPTIONS to re-check once #284–#291 land (all of them live in SHAPES and the SQL below):
//  A1 Binding column `delegation_environments.creating_since timestamptz` (DB clock) replaces
//     `creation_pending`; Ready = sandbox_id set; Creating = creating_since set and sandbox_id null;
//     Cold = neither or no row; binding id = root Session id (sessions.delegation->>'sandboxSessionId'
//     for Children). Any further columns (#290's last error) are only read through to_jsonb.
//  A2 The intent deadline is creating_since + 180 s (ADR: CLAIM_SECONDS + 30).
//  A3 Sandbox tool errors are native toolResult entries (`agent.context_entry`, entry.message.role
//     'toolResult', isError true) with `entry.message.details.code` ∈ {sandbox_unavailable,
//     sandbox_creating}; when details are absent, the code is matched in the result text.
//  A4 Spans are events `span.sandbox_prepare_start` / `span.sandbox_prepare_end` whose data carries
//     turnId, outcome, code (or error.code), sandboxId, durationMs; an optional prepareId/attemptId pairs
//     them, otherwise each end pairs with the earliest open start of its Turn. An end succeeded when it
//     has no code and its outcome does not look like fail/error/unavailable/abort/timeout. A create retry
//     is a start after a failed end in the same Turn, or data.attempt > 1.
//  A5 The Turn-end error is `session.error {turnId, error: {code: 'sandbox_unavailable'}}`, written once
//     before session.turn_completed. Takeovers are `session.turn_resumed {reason, generation}`.
//  A6 `GET /v1/sessions/{id}` returns `sandbox: {state, since, last_error}` (lastError accepted too),
//     state ∈ cold|creating|ready|unavailable; last_error carries a code.
//  A7 pending_events.claim_owner is `host_<uuid>` (session-router.ts, SessionRouter default; execution.ts
//     passes none), so it cannot name a Pod. The owning Runner Pod is the one whose recent logs carry
//     `"msg":"turn_journal_flush","sessionId":"<id>"` (written at input promotion and every flush).
//  A8 The sweeper logs one line per round: {"msg":"sandbox_sweep", env, orphans, unresolved,
//     unusedRunning, noDeadline, killed, adopted, ms}, every 10 min with jitter (the band checked by
//     sweep-summary defaults to 300–900 s); the read-only report's "Planned `sandbox_sweep` counters"
//     block uses the same names.
//  A9 The verification Agent's Sandboxes run in VERIFY_ENVIRONMENT_ID (default env_video_production):
//     its variables reach every command (ADR-0024). To keep business credentials out of the test
//     Sandboxes, point it at a ready Tenant Environment whose variables are inert.
//  A10 Preconditions outside this script: oma-test has its own gateway API key (#283) and its Runners
//     label new Sandboxes `oma.dev/environment=test` (#284), so the report and the sweeper see only test.
//
// Knobs (VERIFY_*, passed through by the wrapper): MODEL (default openai-codex/gpt-5.6-sol), ENVIRONMENT_ID,
// CREATE_CONCURRENCY (20), SUBMIT_CONCURRENCY (50), BURST_WATCH_SECONDS (300), BURST_SAMPLE_MS (5000),
// DISRUPT_CREATING_RATIO (0.25), READ_CONCURRENCY (8), MIN_SANDBOX_USED_RATIO (1), SKIP_FILES (1 skips the
// Workspace file reads), KILL_WAIT_SECONDS (180), KILL_FINISH_MINUTES (15), RECOVERY_MARGIN_SECONDS (60),
// CLEANUP_WAIT_SECONDS (300).
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const END_MARKER = 'END verify-sandbox-reconcile';
export const INTENT_DEADLINE_SECONDS = 180;
const BASE_URL = 'https://agentry-test.welltop.tech/api';
const SCHEMA = 'oma_test';
const DEFAULT_ENVIRONMENT_ID = 'env_video_production';
const DEFAULT_MODEL = 'openai-codex/gpt-5.6-sol';
const KUBE = 'kubectl --kubeconfig ~/.kube/agent-platform-config -n oma-test';
const WRAPPER = 'deploy/scripts/run-sandbox-reconcile-acceptance.sh';

/** Every assumption about event and API shapes, in one place (see A3–A6 above). */
export const SHAPES = {
  turnCompleted: 'session.turn_completed',
  turnResumed: 'session.turn_resumed',
  sessionError: 'session.error',
  prepareStart: 'span.sandbox_prepare_start',
  prepareEnd: 'span.sandbox_prepare_end',
  turnEndingCode: 'sandbox_unavailable',
  sandboxCodes: ['sandbox_unavailable', 'sandbox_creating'],
  toolResultCode: (message) => message?.details?.code ?? message?.details?.error?.code,
  sessionErrorCode: (data) => data?.error?.code ?? data?.code,
  prepareOutcome: (data) => data?.outcome,
  prepareCode: (data) => data?.code ?? data?.error?.code,
  prepareSandboxId: (data) => data?.sandboxId ?? data?.sandbox_id,
  prepareDurationMs: (data) => data?.durationMs ?? data?.duration_ms,
  preparePairId: (data) => data?.prepareId ?? data?.attemptId ?? data?.spanId,
  prepareAttempt: (data) => data?.attempt,
  prepareSucceeded: (data) => !SHAPES.prepareCode(data) && !/fail|error|unavailable|abort|timeout/i.test(String(SHAPES.prepareOutcome(data) ?? '')),
  sandbox: (session) => session?.sandbox,
  sandboxLastErrorCode: (sandbox) => {
    const last = sandbox?.last_error ?? sandbox?.lastError;
    return last == null ? null : (typeof last === 'string' ? last : last.code ?? 'unknown');
  },
};

const SYSTEM = 'Follow the verification instructions exactly. Use only the bash tool. A tool error about the Sandbox '
  + '(for example sandbox_unavailable or sandbox_creating) means the Sandbox was not ready: run the same command again.';

/** One bash call that writes and prints a per-Session marker; safe to repeat. */
export function bashPrompt(marker) {
  const file = `/home/user/workspace/${marker}.txt`;
  const command = `echo ${marker} > ${file} && cat ${file}`;
  return `Use bash with exactly this command: ${JSON.stringify(command)}. It is safe to repeat. If a tool result is an error about `
    + 'the Sandbox (for example sandbox_unavailable or sandbox_creating), or says that its outcome is unknown, run '
    + `the same command again, at most five times in total. Once the command has printed ${marker}, reply with exactly `
    + `RESULT:${marker} and nothing else.`;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested in deploy/sandbox-reconcile-acceptance.test.mjs)
// ---------------------------------------------------------------------------------------------

const ms = (ts) => (ts instanceof Date ? ts.getTime() : Date.parse(ts));
const iso = (value) => (value == null ? null : new Date(value).toISOString());
const tally = (keys) => keys.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});

/** Nearest-rank percentile of finite numbers; null for none. */
export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function distribution(values) {
  const finite = values.filter(Number.isFinite);
  return { count: finite.length, min: finite.length ? Math.min(...finite) : null, p50: percentile(finite, 50),
    p95: percentile(finite, 95), max: finite.length ? Math.max(...finite) : null };
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('');
}

const codeInText = (text) => text.match(new RegExp(`\\b(${SHAPES.sandboxCodes.join('|')})\\b`))?.[1];

/** Tool calls, from the display events and from native assistant entries, one per toolUseId. */
export function toolUses(events) {
  const uses = new Map();
  for (const x of events) {
    if (x.type === 'agent.tool_use' && x.data?.toolUseId && !uses.has(x.data.toolUseId)) {
      uses.set(x.data.toolUseId, { toolUseId: x.data.toolUseId, name: x.data.name, input: x.data.input, ts: x.ts, seq: x.seq });
    }
    const m = x.type === 'agent.context_entry' ? x.data?.entry?.message : undefined;
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block?.type === 'toolCall' && block.id && !uses.has(block.id)) {
          uses.set(block.id, { toolUseId: block.id, name: block.name, input: block.arguments, ts: x.ts, seq: x.seq });
        }
      }
    }
  }
  return [...uses.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/**
 * Original tool results only: native toolResult entries and Host-written results (recovery repairs,
 * delegation results). Display events derived from a native entry carry sourceEntryId and are skipped.
 */
export function toolResults(events) {
  const names = new Map(toolUses(events).map((u) => [u.toolUseId, u.name]));
  const out = [];
  for (const x of events) {
    const m = x.type === 'agent.context_entry' ? x.data?.entry?.message : undefined;
    if (m?.role === 'toolResult') {
      const text = textOf(m.content);
      out.push({ toolUseId: m.toolCallId, name: m.toolName ?? names.get(m.toolCallId), isError: !!m.isError, text,
        code: SHAPES.toolResultCode(m) ?? (m.isError ? codeInText(text) : undefined), ts: x.ts, seq: x.seq, source: 'native' });
    } else if (x.type === 'agent.tool_result' && !x.data?.sourceEntryId) {
      const text = textOf(x.data?.content);
      out.push({ toolUseId: x.data?.toolUseId, name: names.get(x.data?.toolUseId), isError: !!x.data?.isError, text,
        code: SHAPES.toolResultCode(x.data) ?? (x.data?.isError ? codeInText(text) : undefined), ts: x.ts, seq: x.seq, source: 'host' });
    }
  }
  return out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/** Paired span.sandbox_prepare_* events (A4). An end without a start still counts; its duration comes from its data. */
export function prepareSpans(events) {
  const open = [];
  const spans = [];
  for (const x of [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    if (x.type === SHAPES.prepareStart) open.push(x);
    if (x.type !== SHAPES.prepareEnd) continue;
    const pair = SHAPES.preparePairId(x.data);
    let i = pair !== undefined ? open.findIndex((s) => SHAPES.preparePairId(s.data) === pair) : -1;
    if (i < 0) i = open.findIndex((s) => s.data?.turnId === x.data?.turnId && SHAPES.preparePairId(s.data) === undefined);
    const start = i >= 0 ? open.splice(i, 1)[0] : undefined;
    const durationMs = SHAPES.prepareDurationMs(x.data) ?? (start ? ms(x.ts) - ms(start.ts) : undefined);
    spans.push({ turnId: x.data?.turnId, outcome: SHAPES.prepareOutcome(x.data), code: SHAPES.prepareCode(x.data),
      sandboxId: SHAPES.prepareSandboxId(x.data), durationMs, attempt: SHAPES.prepareAttempt(x.data),
      ok: SHAPES.prepareSucceeded(x.data), startTs: start?.ts, endTs: x.ts, seq: x.seq });
  }
  for (const s of open) spans.push({ turnId: s.data?.turnId, outcome: 'open', ok: false, startTs: s.ts, seq: s.seq, open: true });
  return spans;
}

/** Create retries visible in the spans: a start after a failed end of the same Turn, or attempt > 1. */
export function prepareRetries(spans) {
  let retries = 0;
  const failedTurns = new Set();
  for (const s of [...spans].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    if (failedTurns.has(s.turnId) || (Number(s.attempt) > 1)) retries++;
    if (!s.ok && !s.open) failedTurns.add(s.turnId);
    else if (s.ok) failedTurns.delete(s.turnId);
  }
  return retries;
}

function finalText(events) {
  const display = events.filter((x) => x.type === 'agent.message');
  if (display.length) return textOf(display.at(-1).data?.content);
  const native = events.filter((x) => x.type === 'agent.context_entry' && x.data?.entry?.message?.role === 'assistant')
    .map((x) => textOf((x.data.entry.message.content ?? []).filter((c) => c?.type === 'text'))).filter(Boolean);
  return native.at(-1) ?? '';
}

/** One Session's Turn: completion, Sandbox use, Sandbox errors, takeovers and prepare spans. */
export function summarizeSession(events, { marker }) {
  const results = toolResults(events);
  const sessionErrors = events.filter((x) => x.type === SHAPES.sessionError)
    .map((x) => ({ code: SHAPES.sessionErrorCode(x.data) ?? 'unknown', ts: x.ts, seq: x.seq }));
  const sandboxUses = results.filter((r) => r.name === 'bash' && !r.isError && r.text.includes(marker));
  const prepares = prepareSpans(events);
  const text = finalText(events);
  return {
    completed: events.some((x) => x.type === SHAPES.turnCompleted),
    completedAt: events.find((x) => x.type === SHAPES.turnCompleted)?.ts ?? null,
    resumed: events.filter((x) => x.type === SHAPES.turnResumed).map((x) => ({ ts: x.ts, seq: x.seq, reason: x.data?.reason, generation: x.data?.generation })),
    sessionErrors,
    endedSandboxUnavailable: sessionErrors.some((e) => e.code === SHAPES.turnEndingCode),
    bashCalls: toolUses(events).filter((u) => u.name === 'bash').length,
    toolErrors: results.filter((r) => r.isError).map((r) => ({ name: r.name, code: r.code ?? null, source: r.source, ts: r.ts })),
    sandboxUses: sandboxUses.map((r) => ({ ts: r.ts, seq: r.seq })),
    sandboxUsed: sandboxUses.length > 0,
    answered: text.includes(`RESULT:${marker}`),
    finalText: text.slice(0, 200),
    prepares,
    prepareRetries: prepareRetries(prepares),
  };
}

/** The derived binding state (A1), from a row of BINDING_SQL; no row is Cold. */
export function bindingState(row) {
  if (!row) return 'cold';
  if (row.sandbox_id) return 'ready';
  if (row.creating_since) return row.past_deadline ? 'unresolved' : 'creating';
  return 'cold';
}

/**
 * The burst's acceptance (#292): every submitted Session completed and used its Sandbox, no binding
 * stayed Creating past its deadline, no Turn ended with sandbox_unavailable. `entries`:
 * [{sessionId, submitted, summary|null}]; `bindings`: Map id → BINDING_SQL row; `sandboxes`:
 * Map id → GET /v1/sessions/{id}.sandbox; `seen`: per-binding samples of the burst phase.
 */
export function summarizeBurst(entries, { bindings = new Map(), sandboxes = new Map(), seen = {}, minSandboxUsedRatio = 1 } = {}) {
  const submitted = entries.filter((x) => x.submitted);
  const summaries = submitted.map((x) => ({ sessionId: x.sessionId, s: x.summary }));
  const ids = (pred) => summaries.filter(({ s }) => s && pred(s)).map((x) => x.sessionId);
  const completed = ids((s) => s.completed);
  const used = ids((s) => s.sandboxUsed);
  const unavailable = ids((s) => s.endedSandboxUnavailable);
  const prepares = summaries.flatMap(({ s }) => s?.prepares ?? []);
  const states = submitted.map((x) => [x.sessionId, bindingState(bindings.get(x.sessionId))]);
  const stuck = submitted.filter((x) => bindings.get(x.sessionId)?.past_deadline).map((x) => x.sessionId);
  const reported = [...sandboxes.values()];
  const creatingToReady = Object.values(seen).filter((b) => b.readyAt && b.creatingSince).map((b) => ms(b.readyAt) - ms(b.creatingSince));
  const metrics = {
    sessions: entries.length, submitted: submitted.length, completed: completed.length, sandboxUsed: used.length,
    answered: ids((s) => s.answered).length,
    endedSandboxUnavailable: unavailable,
    sessionErrorsByCode: tally(summaries.flatMap(({ s }) => (s?.sessionErrors ?? []).map((e) => e.code))),
    toolErrorsByCode: tally(summaries.flatMap(({ s }) => (s?.toolErrors ?? []).map((e) => e.code ?? 'none'))),
    sessionsWithSandboxToolErrors: ids((s) => s.toolErrors.some((e) => SHAPES.sandboxCodes.includes(e.code))).length,
    takeovers: { sessions: ids((s) => s.resumed.length > 0).length,
      byReason: tally(summaries.flatMap(({ s }) => (s?.resumed ?? []).map((r) => r.reason ?? 'unknown'))),
      beforeFirstSandboxUse: ids((s) => s.resumed.length > 0 && (!s.sandboxUses.length || ms(s.resumed[0].ts) < ms(s.sandboxUses[0].ts))).length },
    prepare: { spans: prepares.length, open: prepares.filter((p) => p.open).length,
      byOutcome: tally(prepares.map((p) => String(p.outcome ?? 'none'))), byCode: tally(prepares.filter((p) => p.code).map((p) => p.code)),
      okMs: distribution(prepares.filter((p) => p.ok).map((p) => p.durationMs)),
      allMs: distribution(prepares.map((p) => p.durationMs)),
      retries: summaries.reduce((n, { s }) => n + (s?.prepareRetries ?? 0), 0),
      sessionsWithRetries: ids((s) => s.prepareRetries > 0).length },
    bindings: { byState: tally(states.map(([, st]) => st)), stuckCreatingPastDeadline: stuck,
      withoutSandbox: states.filter(([, st]) => st !== 'ready').map(([id]) => id),
      reclaiming: submitted.filter((x) => bindings.get(x.sessionId)?.reclaiming).map((x) => x.sessionId) },
    creatingToReadySampledMs: distribution(creatingToReady),
    sandbox: { byState: tally(reported.map((e) => e?.state ?? 'absent')), lastErrorCodes: tally(reported.map(SHAPES.sandboxLastErrorCode).filter(Boolean)) },
    notCompleted: submitted.filter((x) => !x.summary?.completed).map((x) => x.sessionId),
    notUsed: submitted.filter((x) => !x.summary?.sandboxUsed).map((x) => x.sessionId),
  };
  const ratio = submitted.length ? used.length / submitted.length : 0;
  const checks = [
    { name: 'burst: every submitted Session completed its Turn', ok: submitted.length > 0 && completed.length === submitted.length, acceptance: true,
      details: { submitted: submitted.length, completed: completed.length, notCompleted: metrics.notCompleted.slice(0, 20) } },
    { name: `burst: no binding Creating past creating_since + ${INTENT_DEADLINE_SECONDS} s`, ok: stuck.length === 0, acceptance: true,
      details: { stuck: stuck.slice(0, 20), count: stuck.length } },
    { name: 'burst: no Turn ended with sandbox_unavailable', ok: unavailable.length === 0, acceptance: true,
      details: { count: unavailable.length, sessions: unavailable.slice(0, 20) } },
    { name: `burst: Sessions that used their Sandbox ≥ ${minSandboxUsedRatio * 100}%`, ok: ratio >= minSandboxUsedRatio, acceptance: true,
      details: { used: used.length, submitted: submitted.length, notUsed: metrics.notUsed.slice(0, 20) } },
    { name: 'burst: final answers carry the marker', ok: metrics.answered === completed.length, acceptance: false,
      details: { answered: metrics.answered, completed: completed.length } },
    { name: 'burst: the rolling restart took over Turns', ok: metrics.takeovers.sessions > 0, acceptance: false,
      details: metrics.takeovers },
  ];
  return { metrics, checks };
}

/** kill-start → kill -9 → kill-finish: recovery after a lost creator (#292, ADR-0023 Consequences). */
export function evaluateKill({ events, marker, creatingSince, disruptedAt, marginSeconds = 60, takeoverBoundSeconds = INTENT_DEADLINE_SECONDS }) {
  const s = summarizeSession(events, { marker });
  const killAt = ms(disruptedAt), intentAt = ms(creatingSince);
  const resumed = s.resumed.filter((r) => ms(r.ts) >= killAt);
  const takeoverAt = resumed.length ? ms(resumed[0].ts) : NaN;
  const use = s.sandboxUses.find((u) => ms(u.ts) > killAt);
  const useAt = use ? ms(use.ts) : NaN;
  const intentBound = (INTENT_DEADLINE_SECONDS + marginSeconds) * 1000;
  const metrics = {
    msIntentToKill: killAt - intentAt, msKillToTakeover: takeoverAt - killAt, msTakeoverToTool: useAt - takeoverAt,
    msIntentToTool: useAt - intentAt, resumed, toolErrors: s.toolErrors, sessionErrors: s.sessionErrors,
    prepares: s.prepares, prepareRetries: s.prepareRetries, finalText: s.finalText,
  };
  const checks = [
    { name: 'kill: Turn completed', ok: s.completed, acceptance: true },
    { name: 'kill: takeover recorded after the kill', ok: resumed.length > 0, acceptance: true, details: { resumed } },
    { name: 'kill: Sandbox used successfully after the kill', ok: !!use, acceptance: true, details: { use } },
    { name: `kill: tool use resumed within ${takeoverBoundSeconds} s of the takeover`, ok: useAt - takeoverAt <= takeoverBoundSeconds * 1000,
      acceptance: true, details: { msTakeoverToTool: metrics.msTakeoverToTool } },
    { name: `kill: tool use resumed within ${INTENT_DEADLINE_SECONDS} s + ${marginSeconds} s of the creation intent`, ok: useAt - intentAt <= intentBound,
      acceptance: true, details: { msIntentToTool: metrics.msIntentToTool, creatingSince, boundMs: intentBound } },
    { name: 'kill: no Turn ended with sandbox_unavailable', ok: !s.endedSandboxUnavailable, acceptance: true, details: { sessionErrors: s.sessionErrors } },
    { name: 'kill: the takeover followed lease expiry', ok: resumed.every((r) => r.reason === 'expired'), acceptance: false, details: { reasons: resumed.map((r) => r.reason) } },
    { name: 'kill: final answer reports the marker', ok: s.answered, acceptance: false, details: { finalText: s.finalText } },
  ];
  return { metrics, checks };
}

/** `kubectl logs --timestamps` lines, optionally prefixed with the Pod name ("pod(previous)" for --previous). */
export function parseSweepLines(text) {
  const rounds = [];
  for (const line of text.split('\n')) {
    const brace = line.indexOf('{');
    if (brace < 0 || !line.includes('"sandbox_sweep"')) continue;
    let json;
    try { json = JSON.parse(line.slice(brace)); } catch { continue; }
    if (json?.msg !== 'sandbox_sweep') continue;
    const words = line.slice(0, brace).trim().split(/\s+/).filter(Boolean);
    const tsIndex = words.findIndex((w) => !Number.isNaN(Date.parse(w)) && /^\d{4}-/.test(w));
    const source = (tsIndex > 0 ? words[0] : '-');
    rounds.push({ source, pod: source.replace(/\(previous\)$/, ''), ts: tsIndex >= 0 ? words[tsIndex] : null, ...json });
  }
  return rounds.sort((a, b) => ms(a.ts) - ms(b.ts));
}

export const SWEEP_COUNTERS = ['orphans', 'unresolved', 'unusedRunning', 'noDeadline'];

/** The report's heading time and its planned `sandbox_sweep` line (sandbox-sweep-report.ts). */
export function plannedCountersFromReport(markdown) {
  const at = markdown.match(/^# Sandbox sweep report: .*?, (\S+)\s*$/m)?.[1] ?? null;
  const line = markdown.match(/^\{"msg":"sandbox_sweep".*\}$/m)?.[0];
  return line ? { at, ...JSON.parse(line) } : null;
}

/**
 * Rounds per container, their spacing, and the first round after the report compared with the report's
 * planned counters: equal when no Session activity fell between the two; killed and adopted can only be
 * lower (the 50-kill cap, a Sandbox used again before the action's re-check).
 */
export function summarizeSweep(rounds, { planned = null, minIntervalSeconds = 300, maxIntervalSeconds = 900, maxKills = 50 } = {}) {
  const sources = {};
  for (const r of rounds) (sources[r.source] ??= []).push(r);
  const bySource = Object.fromEntries(Object.entries(sources).map(([source, rs]) => {
    const intervals = rs.slice(1).map((r, i) => (ms(r.ts) - ms(rs[i].ts)) / 1000);
    return [source, { rounds: rs.length, first: rs[0].ts, last: rs.at(-1).ts, intervalsSeconds: distribution(intervals),
      outOfBand: intervals.filter((s) => s < minIntervalSeconds || s > maxIntervalSeconds),
      killed: rs.reduce((n, r) => n + (r.killed ?? 0), 0), adopted: rs.reduce((n, r) => n + (r.adopted ?? 0), 0),
      envs: [...new Set(rs.map((r) => r.env))] }];
  }));
  const periodic = Object.values(bySource).filter((s) => s.rounds >= 2);
  const checks = [
    { name: 'sweep: sandbox_sweep lines found', ok: rounds.length > 0, acceptance: true, details: { rounds: rounds.length } },
    { name: 'sweep: rounds only for env test', ok: rounds.length > 0 && rounds.every((r) => r.env === 'test'), acceptance: true },
    { name: `sweep: a Runner logged consecutive rounds ${minIntervalSeconds}–${maxIntervalSeconds} s apart`,
      ok: periodic.length > 0 && periodic.every((s) => s.outOfBand.length === 0), acceptance: true,
      details: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, { rounds: v.rounds, intervals: v.intervalsSeconds, outOfBand: v.outOfBand }])) },
  ];
  let comparison = null;
  if (planned) {
    const next = rounds.find((r) => !planned.at || ms(r.ts) >= ms(planned.at));
    const diffs = next ? SWEEP_COUNTERS.filter((k) => next[k] !== planned[k]).map((k) => ({ counter: k, report: planned[k], round: next[k] })) : [];
    const killedOk = next ? next.killed <= Math.min((planned.orphans ?? 0) + (planned.noDeadline ?? 0), maxKills) : false;
    const adoptedOk = next ? next.adopted <= (planned.unresolved ?? 0) : false;
    comparison = { reportAt: planned.at, round: next ?? null, diffs, killedOk, adoptedOk };
    checks.push({ name: 'sweep: the first round after the report matches its planned counters', ok: !!next && !diffs.length && killedOk && adoptedOk,
      acceptance: true, details: comparison });
  }
  return { bySource, comparison, checks };
}

/** Rows of the report's "## Sandboxes" table whose binding is one of `bindingIds`. */
export function reportRows(markdown, bindingIds) {
  const wanted = new Set(bindingIds);
  const section = markdown.split(/^## Sandboxes\s*$/m)[1] ?? '';
  const rows = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('| sandboxId ')) continue;
    const cells = line.slice(2, -2).split(' | ');
    if (cells.length < 10 || !wanted.has(cells[1])) continue;
    const [sandboxId, binding, environment, state, startedAt, endAt, bindingRow, recorded, decision, ...reason] = cells;
    rows.push({ sandboxId, binding, environment, state, startedAt, endAt, bindingRow, recorded, decision, reason: reason.join(' | ') });
  }
  return rows;
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Live phases (API Pod)
// ---------------------------------------------------------------------------------------------

const delay = (t) => new Promise((r) => setTimeout(r, t));
const now = () => new Date().toISOString();
const num = (name, fallback) => (process.env[name] === undefined || process.env[name] === '' ? fallback : Number(process.env[name]));

const BINDING_SQL = `SELECT e.id, e.sandbox_id, e.creating_since, e.reclaiming,
    (e.creating_since IS NOT NULL AND e.sandbox_id IS NULL AND now() >= e.creating_since + ($2::int * interval '1 second')) AS past_deadline,
    now() AS db_now, to_jsonb(e) - 'id' - 'sandbox_id' - 'creating_since' - 'reclaiming' AS extra
  FROM delegation_environments e WHERE e.id = ANY($1::text[])`;

async function readOnly(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

async function bindingColumns(client) {
  const { rows } = await client.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = 'delegation_environments' AND column_name IN ('creating_since', 'creation_pending')`, [SCHEMA]);
  return rows.map((r) => r.column_name).sort();
}

async function readBindings(pool, ids) {
  return readOnly(pool, async (client) => {
    const columns = await bindingColumns(client);
    assert.deepEqual(columns, ['creating_since'], `delegation_environments has ${columns.join(' and ') || 'neither column'}: migration 0024 is not (fully) applied`);
    const { rows } = await client.query(BINDING_SQL, [ids, INTENT_DEADLINE_SECONDS]);
    return new Map(rows.map((r) => [r.id, r]));
  });
}

const compactBinding = (r) => (r ? { state: bindingState(r), sandboxId: r.sandbox_id, creatingSince: iso(r.creating_since),
  pastDeadline: r.past_deadline, reclaiming: r.reclaiming, dbNow: iso(r.db_now), extra: r.extra } : { state: 'cold', row: false });

function makeContext(phase, file, e, pool, base) {
  const ctx = { phase, file, e, pool, base, checks: [], headers: null };
  ctx.save = () => writeFile(file, JSON.stringify(e, null, 2), { mode: 0o600 });
  ctx.check = (name, ok, details, acceptance = true) => {
    const c = { name, ok: !!ok, acceptance, phase, at: now(), details };
    e.checks.push(c);
    ctx.checks.push(c);
    console.log(JSON.stringify({ check: name, ok: !!ok, acceptance, details }));
  };
  ctx.api = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const r = await fetch(base + path, { method, headers: ctx.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
    const t = await r.text();
    if (!r.ok) throw Object.assign(Error(`HTTP ${r.status} ${method} ${path}: ${t.slice(0, 300)}`), { status: r.status });
    return t ? JSON.parse(t) : null;
  };
  ctx.events = async (id) => {
    let after = 0;
    const out = [];
    for (let i = 0; i < 50; i++) {
      const r = await ctx.api(`/v1/sessions/${id}/events?after_seq=${after}&limit=1000`);
      out.push(...r.data);
      if (!r.has_more) return out;
      after = r.data.at(-1).seq;
    }
    throw Error(`events of ${id}: more than 50 pages`);
  };
  ctx.waitFor = async (label, read, done, timeoutMs, everyMs = 1000) => {
    const end = Date.now() + timeoutMs;
    let log = 0;
    while (Date.now() < end) {
      const v = await read();
      if (done(v)) return v;
      if (Date.now() > log) { console.log(JSON.stringify({ waiting: label, at: now() })); log = Date.now() + 15_000; }
      await delay(everyMs);
    }
    throw Error(`Timeout: ${label}`);
  };
  ctx.userMessage = (text) => ({ events: [{ type: 'user.message', data: { content: [{ type: 'text', text }] } }] });
  return ctx;
}

const PHASES = {
  async migration(ctx, [label]) {
    assert(['pre', 'post', 'after-sweep'].includes(label), 'usage: migration <pre|post|after-sweep>');
    const snapshot = await readOnly(ctx.pool, async (client) => {
      const columns = await bindingColumns(client);
      const creating = columns.includes('creating_since') ? 'e.creating_since IS NOT NULL'
        : columns.includes('creation_pending') ? 'e.creation_pending' : 'false';
      const epoch = columns.includes('creating_since') ? "e.creating_since = 'epoch'::timestamptz" : 'false';
      const { rows: [bindings] } = await client.query(`WITH alive AS (
          SELECT DISTINCT COALESCE(s.delegation->>'sandboxSessionId', s.id) AS binding_id FROM sessions s WHERE s.status <> 'terminated')
        SELECT count(*)::int AS total, count(*) FILTER (WHERE e.sandbox_id IS NOT NULL)::int AS ready,
          count(*) FILTER (WHERE e.sandbox_id IS NULL AND ${creating})::int AS creating,
          count(*) FILTER (WHERE ${epoch})::int AS creating_epoch,
          count(*) FILTER (WHERE ${epoch} AND EXISTS (SELECT 1 FROM alive a WHERE a.binding_id = e.id))::int AS creating_epoch_alive,
          count(*) FILTER (WHERE e.reclaiming)::int AS reclaiming
        FROM delegation_environments e`);
      const { rows: [pending] } = await client.query(`SELECT count(*)::int AS total,
          count(*) FILTER (WHERE claim_owner IS NOT NULL AND claim_expires_at > clock_timestamp())::int AS live_claims FROM pending_events`);
      return { at: now(), columns, bindings, pending };
    });
    (ctx.e.migration ??= {})[label] = snapshot;
    console.log(JSON.stringify({ migration: label, ...snapshot }));
    if (label === 'pre') {
      ctx.check('migration pre: no live claim (Runners are at 0)', snapshot.pending.live_claims === 0, snapshot.pending);
      ctx.check('migration pre: the old column is still in place', snapshot.columns.includes('creation_pending'), { columns: snapshot.columns });
    } else {
      ctx.check(`migration ${label}: creation_pending dropped, creating_since present`,
        snapshot.columns.length === 1 && snapshot.columns[0] === 'creating_since', { columns: snapshot.columns });
      const pre = ctx.e.migration.pre?.bindings;
      if (label === 'post' && pre) ctx.check('migration post: every pending row became Creating(epoch)', snapshot.bindings.creating_epoch === pre.creating,
        { pendingBefore: pre.creating, epochAfter: snapshot.bindings.creating_epoch });
      if (label === 'after-sweep') console.log('NOTE Creating(epoch) rows without a Sandbox on the gateway are left to their first use (ADR-0023'
        + ' Migration); the sweeper reconciles only rows whose Sandbox it lists: compare `unresolved` in the report.');
    }
  },

  async init(ctx) {
    assert(!ctx.e.agent, `init already ran for this evidence file (agent ${ctx.e.agent}); start a new evidence file for a new run`);
    const model = process.env.VERIFY_MODEL || DEFAULT_MODEL;
    const environmentId = process.env.VERIFY_ENVIRONMENT_ID || DEFAULT_ENVIRONMENT_ID;
    const agent = await ctx.api('/v1/agents', { name: `${ctx.e.runId}-agent`, model, runtime: 'pi-agent',
      sandbox: { enabled: true }, environmentId, mcpServers: [], skills: [], system: SYSTEM });
    Object.assign(ctx.e, { agent: agent.id, model, environmentId });
    ctx.check('init: verification Agent created', true, { tenant: ctx.e.runId, agent: agent.id, model, environmentId });
  },

  async burst(ctx, [count]) {
    const { e } = ctx;
    assert(e.agent, 'run init first');
    assert(!e.burst, 'this evidence file already has a burst; start a new evidence file for another one');
    const n = Number(count ?? 200);
    assert(Number.isInteger(n) && n > 0 && n <= 500, 'burst size must be 1–500');
    const workspaceId = `${e.runId}-burst`;
    e.burst = { n, workspaceId, startedAt: now(), sessions: {}, timeline: [] };
    const createConcurrency = num('VERIFY_CREATE_CONCURRENCY', 20), submitConcurrency = num('VERIFY_SUBMIT_CONCURRENCY', 50);
    // Sessions first, then every input at once: the creates then overlap as much as the model allows.
    const created = await mapLimit([...Array(n).keys()], createConcurrency, async (i) => {
      const marker = `${e.runId}-b${String(i).padStart(3, '0')}`;
      for (let attempt = 1; ; attempt++) {
        const t0 = Date.now();
        try {
          const s = await ctx.api('/v1/sessions', { agent: e.agent, workspace_id: workspaceId });
          e.burst.sessions[s.id] = { i, marker, createdAt: now(), createMs: Date.now() - t0, createAttempts: attempt };
          return s.id;
        } catch (error) {
          // A create without its input is harmless (cleanup terminates every Session of the tenant).
          if (attempt >= 3 || (error.status && error.status < 500)) { console.log(JSON.stringify({ createFailed: i, error: String(error.message).slice(0, 200) })); return null; }
          await delay(1000 * attempt);
        }
      }
    });
    const ids = created.filter(Boolean);
    await ctx.save();
    e.burst.submitStartedAt = now();
    await mapLimit(ids, submitConcurrency, async (id) => {
      const s = e.burst.sessions[id];
      const t0 = Date.now();
      // Never retried: an append has no idempotency key, a retry could start a second Turn. `check`
      // counts a Session as submitted when its input reached the database.
      try { await ctx.api(`/v1/sessions/${id}/events`, ctx.userMessage(bashPrompt(s.marker))); s.submittedAt = now(); }
      catch (error) { s.submitError = String(error.message).slice(0, 300); }
      s.submitMs = Date.now() - t0;
    });
    e.burst.submitEndedAt = now();
    const accepted = ids.filter((id) => e.burst.sessions[id].submittedAt);
    const submit = distribution(ids.map((id) => e.burst.sessions[id].submitMs));
    e.burst.submit = { created: ids.length, accepted: accepted.length, ms: submit };
    await ctx.save();
    console.log(JSON.stringify({ burst: n, created: ids.length, accepted: accepted.length, submitMs: submit,
      window: [e.burst.submitStartedAt, e.burst.submitEndedAt] }));
    ctx.check('burst: every Session created and its input accepted', accepted.length === n, e.burst.submit, false);
    // Watch the bindings; ask for the rolling restart once creations are in flight.
    const watchMs = num('VERIFY_BURST_WATCH_SECONDS', 300) * 1000;
    const threshold = Math.max(1, Math.ceil(ids.length * num('VERIFY_DISRUPT_CREATING_RATIO', 0.25)));
    const started = Date.now();
    const seen = (e.burst.seen = {});
    while (Date.now() - started < watchMs) {
      const rows = await readBindings(ctx.pool, ids);
      const at = now();
      const states = tally(ids.map((id) => bindingState(rows.get(id))));
      for (const id of ids) {
        const r = rows.get(id);
        const b = (seen[id] ??= {});
        if (r?.creating_since && !r.sandbox_id) { b.creatingSince = iso(r.creating_since); b.firstCreatingSeenAt ??= at; }
        if (r?.sandbox_id && !b.readyAt) { b.readyAt = at; b.sandboxId = r.sandbox_id; }
      }
      e.burst.timeline.push({ at, ...states });
      console.log(JSON.stringify({ at, bindings: states }));
      if (!e.burst.disruptPrintedAt && ((states.creating ?? 0) + (states.unresolved ?? 0) >= threshold || Date.now() - started >= 60_000)) {
        e.burst.disruptPrintedAt = at;
        console.log(`DISRUPT_NOW rolling-restart creating=${states.creating ?? 0} ready=${states.ready ?? 0} cold=${states.cold ?? 0}`);
        console.log(`  run now, in another terminal: date -u +%FT%TZ; ${KUBE} rollout restart deploy/oma-runner && ${KUBE} rollout status deploy/oma-runner`);
        console.log(`  afterwards: ${WRAPPER} mark rollout-restart <the time printed by date>`);
        await ctx.save();
      }
      await delay(num('VERIFY_BURST_SAMPLE_MS', 5000));
    }
    if (!e.burst.disruptPrintedAt) {
      e.burst.disruptPrintedAt = now();
      console.log(`DISRUPT_NOW rolling-restart (the watch ended first): ${KUBE} rollout restart deploy/oma-runner`);
    }
    await ctx.save();
    console.log(`NEXT ${WRAPPER} check   (waits up to 25 min for every Turn)`);
  },

  async check(ctx, [minutes]) {
    const { e } = ctx;
    assert(e.burst, 'run burst first');
    const ids = Object.keys(e.burst.sessions);
    const waitMs = Number(minutes ?? 25) * 60_000;
    const progress = async () => readOnly(ctx.pool, async (client) => {
      const { rows } = await client.query(`SELECT s.id,
          (SELECT count(*) FROM events v WHERE v.session_id = s.id AND v.type = 'session.turn_completed')::int AS completed,
          (SELECT count(*) FROM events v WHERE v.session_id = s.id AND v.type = 'user.message')::int
            + (SELECT count(*) FROM pending_events p WHERE p.session_id = s.id)::int AS inputs
        FROM unnest($1::text[]) AS s(id)`, [ids]);
      return new Map(rows.map((r) => [r.id, r]));
    });
    let rows;
    let complete = false;
    const end = Date.now() + waitMs;
    for (let log = 0; ;) {
      rows = await progress();
      const submitted = ids.filter((id) => rows.get(id)?.inputs > 0);
      const done = submitted.filter((id) => rows.get(id).completed > 0);
      complete = done.length === submitted.length;
      if (complete || Date.now() >= end) break;
      if (Date.now() > log) { console.log(JSON.stringify({ at: now(), submitted: submitted.length, completed: done.length })); log = Date.now() + 30_000; }
      await delay(10_000);
    }
    if (!complete) console.log(`WARNING not every Turn completed within ${minutes ?? 25} min; evaluating what is there`);
    const fetched = await mapLimit(ids, num('VERIFY_READ_CONCURRENCY', 8), async (id) => {
      const s = e.burst.sessions[id];
      if (!(rows.get(id)?.inputs > 0)) return { sessionId: id, submitted: false, summary: null };
      const [events, session] = await Promise.all([ctx.events(id), ctx.api(`/v1/sessions/${id}`)]);
      return { sessionId: id, submitted: true, summary: summarizeSession(events, { marker: s.marker }), sandbox: SHAPES.sandbox(session) };
    });
    const bindings = await readBindings(ctx.pool, ids);
    const sandboxes = new Map(fetched.filter((f) => f.submitted).map((f) => [f.sessionId, f.sandbox]));
    const { metrics, checks } = summarizeBurst(fetched, { bindings, sandboxes, seen: e.burst.seen,
      minSandboxUsedRatio: num('VERIFY_MIN_SANDBOX_USED_RATIO', 1) });
    if (process.env.VERIFY_SKIP_FILES !== '1') {
      // Informational: the marker reached the Workspace through the mount.
      const files = await mapLimit(fetched.filter((f) => f.summary?.sandboxUsed), num('VERIFY_READ_CONCURRENCY', 8), async (f) => {
        try {
          const access = await ctx.api(`/v1/workspaces/${e.burst.workspaceId}/files/${e.burst.sessions[f.sessionId].marker}.txt`);
          return (await (await fetch(access.url, { signal: AbortSignal.timeout(30_000) })).text()).trim() === e.burst.sessions[f.sessionId].marker;
        } catch { return false; }
      });
      metrics.workspaceFiles = { checked: files.length, matching: files.filter(Boolean).length };
    }
    e.burst.result = { at: now(), metrics, perSession: Object.fromEntries(fetched.map((f) => [f.sessionId, {
      submitted: f.submitted, binding: compactBinding(bindings.get(f.sessionId)), sandbox: f.sandbox ?? null,
      ...(f.summary ? { completed: f.summary.completed, sandboxUsed: f.summary.sandboxUsed, answered: f.summary.answered,
        endedSandboxUnavailable: f.summary.endedSandboxUnavailable, sessionErrors: f.summary.sessionErrors, toolErrors: f.summary.toolErrors,
        resumed: f.summary.resumed, prepares: f.summary.prepares, prepareRetries: f.summary.prepareRetries, bashCalls: f.summary.bashCalls } : {}) }])) };
    console.log(`SUMMARY ${JSON.stringify(metrics)}`);
    for (const c of checks) ctx.check(c.name, c.ok, c.details, c.acceptance);
  },

  async 'kill-start'(ctx) {
    const { e } = ctx;
    assert(e.agent, 'run init first');
    if (e.kill) (e.killRuns ??= []).push(e.kill);
    const marker = `${e.runId}-kill${(e.killRuns?.length ?? 0) || ''}`;
    const s = await ctx.api('/v1/sessions', { agent: e.agent, workspace_id: `${e.runId}-kill` });
    e.kill = { sessionId: s.id, marker, createdAt: now() };
    await ctx.save();
    await ctx.api(`/v1/sessions/${s.id}/events`, ctx.userMessage(bashPrompt(marker)));
    e.kill.submittedAt = now();
    const claimOf = () => readOnly(ctx.pool, async (client) => (await client.query(
      'SELECT id, claim_owner, claim_generation, claim_expires_at FROM pending_events WHERE session_id = $1 ORDER BY seq LIMIT 1', [s.id])).rows[0]);
    const claim = await ctx.waitFor('Turn claimed', claimOf, (c) => c?.claim_owner, 120_000, 250);
    e.kill.claim = claim;
    console.log(`CLAIMED session=${s.id} claim_owner=${claim.claim_owner} generation=${claim.claim_generation}`);
    console.log(`  claim_owner is host_<uuid>, not a Pod name; find the Pod now: ${WRAPPER} owner ${s.id}`);
    await ctx.save();
    const row = await ctx.waitFor('binding Creating', async () => (await readBindings(ctx.pool, [s.id])).get(s.id),
      (r) => bindingState(r) !== 'cold', num('VERIFY_KILL_WAIT_SECONDS', 180) * 1000, 250);
    e.kill.observed = { at: now(), ...compactBinding(row) };
    await ctx.save();
    if (bindingState(row) === 'ready') {
      ctx.check('kill-start: the binding was observed Creating', false, { ...e.kill.observed,
        hint: 'the create finished between two 250 ms reads (a warm claim); empty the warm pool of the test SandboxSet and rerun kill-start' });
      return;
    }
    e.kill.creatingSince = iso(row.creating_since);
    ctx.check('kill-start: the binding was observed Creating', true, e.kill.observed);
    const owner = (await claimOf())?.claim_owner;
    console.log(`DISRUPT_NOW session=${s.id} binding=${s.id} creating_since=${e.kill.creatingSince} claim_owner=${owner}`);
    console.log(`  ${WRAPPER} kill-runner <pod from owner>     then: ${WRAPPER} mark kill <KILLED_AT>`);
  },

  async mark(ctx, [name, at]) {
    assert(name, 'usage: mark <name> [iso time]');
    const when = at ? iso(at) : now();
    (ctx.e.marks ??= {})[name] = when;
    if (name === 'kill' && ctx.e.kill) {
      const k = ctx.e.kill;
      k.disruptedAt = when;
      const row = (await readBindings(ctx.pool, [k.sessionId])).get(k.sessionId);
      const claim = await readOnly(ctx.pool, async (client) => (await client.query(
        'SELECT claim_owner, claim_generation, claim_expires_at FROM pending_events WHERE session_id = $1 ORDER BY seq LIMIT 1', [k.sessionId])).rows[0]);
      k.atMark = { at: now(), binding: compactBinding(row), claim };
      // A kill after the create returned leaves the binding Ready: the run did not test a lost creator.
      ctx.check('kill: the kill landed while the binding was Creating', ['creating', 'unresolved'].includes(bindingState(row))
        && (!k.creatingSince || iso(row.creating_since) === k.creatingSince), k.atMark);
    } else {
      ctx.check(`mark ${name}`, true, { at: when }, false);
    }
  },

  async 'kill-finish'(ctx) {
    const k = ctx.e.kill;
    assert(k?.disruptedAt && k.creatingSince, `run kill-start and ${WRAPPER} mark kill <KILLED_AT> first`);
    const events = await ctx.waitFor('Turn completion', () => ctx.events(k.sessionId),
      (es) => es.some((x) => x.type === SHAPES.turnCompleted), num('VERIFY_KILL_FINISH_MINUTES', 15) * 60_000, 5000);
    const marginSeconds = num('VERIFY_RECOVERY_MARGIN_SECONDS', 60);
    const { metrics, checks } = evaluateKill({ events, marker: k.marker, creatingSince: k.creatingSince, disruptedAt: k.disruptedAt, marginSeconds });
    const row = (await readBindings(ctx.pool, [k.sessionId])).get(k.sessionId);
    const session = await ctx.api(`/v1/sessions/${k.sessionId}`);
    k.result = { at: now(), marginSeconds, metrics, binding: compactBinding(row), sandbox: SHAPES.sandbox(session) ?? null };
    console.log(`SUMMARY ${JSON.stringify({ ...metrics, prepares: metrics.prepares.length, binding: k.result.binding, sandbox: k.result.sandbox })}`);
    for (const c of checks) ctx.check(c.name, c.ok, c.details, c.acceptance);
  },

  async cleanup(ctx) {
    const { e } = ctx;
    const ids = new Set([...Object.keys(e.burst?.sessions ?? {}), ...[e.kill, ...(e.killRuns ?? [])].filter(Boolean).map((k) => k.sessionId)]);
    let cursor;
    do {
      const r = await ctx.api(`/v1/sessions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const s of r.data) if (s.status !== 'terminated') ids.add(s.id);
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);
    const all = [...ids];
    const failures = [];
    await mapLimit(all, num('VERIFY_READ_CONCURRENCY', 8), async (id) => {
      try { await ctx.api(`/v1/sessions/${id}`, undefined, 'DELETE'); } catch (error) { if (error.status !== 404) failures.push({ id, error: String(error.message).slice(0, 200) }); }
    });
    ctx.check('cleanup: Sessions terminated', failures.length === 0, { count: all.length, failures: failures.slice(0, 20) }, false);
    // Termination reclaims by binding (#288): the row is cleared once every listed Sandbox is confirmed missing.
    const read = () => readOnly(ctx.pool, async (client) => {
      const { rows: cleanup } = await client.query('SELECT session_id, completed_at, attempts FROM session_cleanup WHERE session_id = ANY($1::text[])', [all]);
      const { rows } = await client.query(BINDING_SQL, [all, INTENT_DEADLINE_SECONDS]);
      return { cleanup, bindings: rows };
    });
    const settled = (v) => v.cleanup.length === all.length && v.cleanup.every((c) => c.completed_at)
      && v.bindings.every((b) => !b.sandbox_id && !b.creating_since && !b.reclaiming);
    let state;
    try { state = await ctx.waitFor('termination cleanup', read, settled, num('VERIFY_CLEANUP_WAIT_SECONDS', 300) * 1000, 5000); }
    catch { state = await read(); }
    const left = state.bindings.filter((b) => b.sandbox_id || b.creating_since || b.reclaiming);
    e.cleanup = { at: now(), sessions: all.length, cleanupRows: state.cleanup.length, cleanupCompleted: state.cleanup.filter((c) => c.completed_at).length,
      bindings: state.bindings.length, bindingsLeft: left.map((b) => ({ id: b.id, ...compactBinding(b) })) };
    ctx.check('cleanup: termination cleared every binding of this run', settled(state), { ...e.cleanup, bindingsLeft: e.cleanup.bindingsLeft.slice(0, 20) }, false);
    console.log('NOTE the API Pod has no gateway key, so it cannot list the Sandboxes that remain. Check them with the read-only report:');
    console.log('  deploy/scripts/run-sandbox-sweep-report.sh test > report-cleanup.md');
    console.log('  node deploy/scripts/verify-sandbox-reconcile.mjs report-rows <local evidence> report-cleanup.md');
  },
};
const API_PHASES = new Set(['init', 'burst', 'check', 'kill-start', 'kill-finish', 'cleanup']);

/** `deps` replaces the Pod's pg and PgApiKeyStore (tests only). */
export async function live(phase, file, args, deps = {}) {
  assert(Object.hasOwn(PHASES, phase), `unknown phase ${phase}`);
  assert(file, `usage: ${phase} <evidence.json> ...`);
  const schema = process.env.VERIFY_SCHEMA;
  assert.equal(schema, SCHEMA, 'Sandbox reconciliation acceptance runs on oma_test only');
  if (process.env.PG_SCHEMA) assert.equal(process.env.PG_SCHEMA, SCHEMA, 'the Pod is not an oma-test Pod');
  assert.equal(process.env.OMA_LIVE_BASE_URL, BASE_URL);
  let raw = null;
  try { raw = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (raw === null) assert(phase === 'init' || phase === 'migration', `no evidence in ${file}: run init (or migration) first`);
  const e = raw === null ? { runId: `reconcile-${Date.now()}`, schema, createdAt: now(), checks: [] } : JSON.parse(raw);
  assert.equal(e.schema, SCHEMA);
  const Pool = deps.Pool ?? createRequire(import.meta.url)('/app/server/packages/store/node_modules/pg').Pool;
  const pool = new Pool({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT), user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE, options: `-c search_path=${schema}`, max: 2 });
  const ctx = makeContext(phase, file, e, pool, BASE_URL);
  const failures = [];
  let keys, key;
  try {
    if (API_PHASES.has(phase)) {
      const PgApiKeyStore = deps.PgApiKeyStore ?? (await import('/app/server/packages/store/src/postgres/api-key-store.ts')).PgApiKeyStore;
      keys = new PgApiKeyStore(pool);
      key = await keys.create(e.runId, phase);
      ctx.headers = { 'x-api-key': key.rawKey, 'content-type': 'application/json' };
    }
    await PHASES[phase](ctx, args);
  } catch (error) {
    failures.push(error);
  } finally {
    for (const step of [ctx.save, () => key && keys.revoke(e.runId, key.apiKey.id), () => pool.end()]) {
      try { await step(); } catch (error) { failures.push(error); }
    }
  }
  for (const f of failures) console.error(f?.stack ?? String(f));
  return report(ctx.checks, failures.length === 0);
}

function report(checks, ran) {
  const failed = checks.filter((c) => !c.ok && c.acceptance);
  const warned = checks.filter((c) => !c.ok && !c.acceptance);
  for (const c of warned) console.log(`WARN ${c.name}`);
  console.log(failed.length ? `ACCEPTANCE FAILED: ${failed.map((c) => c.name).join('; ')}` : ran ? 'ACCEPTANCE PASSED' : 'PHASE FAILED');
  return ran && failed.length === 0;
}

// ---------------------------------------------------------------------------------------------
// Local phases (no cluster access)
// ---------------------------------------------------------------------------------------------

function flag(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
}

const LOCAL = {
  async 'sweep-summary'(args) {
    const minIntervalSeconds = Number(flag(args, '--min-interval', 300));
    const maxIntervalSeconds = Number(flag(args, '--max-interval', 900));
    const [reportFile] = args;
    const rounds = parseSweepLines(readFileSync(0, 'utf8'));
    const planned = reportFile ? plannedCountersFromReport(readFileSync(reportFile, 'utf8')) : null;
    if (reportFile) assert(planned, `no planned sandbox_sweep counters in ${reportFile}`);
    const { bySource, comparison, checks } = summarizeSweep(rounds, { planned, minIntervalSeconds, maxIntervalSeconds });
    for (const r of rounds) console.log(`${r.ts} ${r.source} ${JSON.stringify(Object.fromEntries(['env', ...SWEEP_COUNTERS, 'killed', 'adopted', 'ms'].map((k) => [k, r[k]])))}`);
    console.log(`SUMMARY ${JSON.stringify({ bySource, comparison })}`);
    for (const c of checks) console.log(JSON.stringify({ check: c.name, ok: c.ok, acceptance: c.acceptance, details: c.details }));
    return report(checks, true);
  },

  async 'report-rows'([evidenceFile, reportFile]) {
    assert(evidenceFile && reportFile, 'usage: report-rows <evidence.json> <report.md>');
    const e = JSON.parse(readFileSync(evidenceFile, 'utf8'));
    const ids = [...Object.keys(e.burst?.sessions ?? {}), ...[e.kill, ...(e.killRuns ?? [])].filter(Boolean).map((k) => k.sessionId)];
    const markdown = readFileSync(reportFile, 'utf8');
    const rows = reportRows(markdown, ids);
    for (const r of rows) console.log(`${r.sandboxId} ${r.binding} ${r.state} ${r.bindingRow} | ${r.decision} | ${r.reason}`);
    const planned = plannedCountersFromReport(markdown);
    const byDecision = tally(rows.map((r) => r.decision.split(' ')[0]));
    console.log(`SUMMARY ${JSON.stringify({ run: e.runId, bindings: ids.length, sandboxesOfThisRun: rows.length, byDecision, planned })}`);
    const checks = [
      { name: 'report: no orphan or unresolved Sandbox of this run', ok: !byDecision.kill && !byDecision.adopt, acceptance: true, details: byDecision },
      { name: 'report: the environment plans no kill or adoption', ok: !!planned && SWEEP_COUNTERS.every((k) => k === 'unusedRunning' || planned[k] === 0),
        acceptance: false, details: planned },
    ];
    for (const c of checks) console.log(JSON.stringify({ check: c.name, ok: c.ok, acceptance: c.acceptance, details: c.details }));
    return report(checks, true);
  },
};

async function main(argv) {
  const [phase, ...rest] = argv;
  let ok = false;
  try {
    ok = Object.hasOwn(LOCAL, phase) ? await LOCAL[phase](rest) : await live(phase, rest[0], rest.slice(1));
  } catch (error) {
    console.error(error?.stack ?? String(error));
  } finally {
    console.log(`${END_MARKER} phase=${phase} ok=${ok}`);
  }
  if (!ok) process.exitCode = 1;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) await main(process.argv.slice(2));
