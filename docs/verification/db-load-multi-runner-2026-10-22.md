# Database load of N Runners (2026-10-22)

Question (#234): with several Runners on one PostgreSQL, does the database load become too
high, and if so where and how do we fix it?

Short answer: no, not at today's scale. oma-test averages ≈9–15 statements/s; the range is
because the stats window is unknown (§4). In a measured idle window its two Runners issued
exactly the modelled 2.44 statements/s. At the next scale points the polling stays within a
≥4-vCPU budget: ≈4,500 statements/s at N=4 Runners, A=100 active Turns and W=20 delegation
waits. But two thirds of that is multi-instance overhead that does no work, and it grows
with Turns × Runners and with waits × Runners.

Separately, three costs grow without bound with history: unindexed scans of the
never-pruned delegation tables, the full event-log read on every claim, and cleanup rows
retried every 5 s with no backoff (none is stuck in oma-test today). These would make the
database the bottleneck before the polling does.

Three fixes remove ≈93 % of the projected load: the delegation wait (F1), non-owner claims
(F2) and the heartbeat cadence (F3). Indexes (F4) remove the unbounded scans.

**Implemented:** F4 (**migration `deploy/migrations/0021_delegation_lookup_indexes.sql`**,
to be applied before or after the Runner image), the F5 page size and F7 first; then F1,
F2, F3 and F6 on wt/db-load-fixes (on feat/stateless-runner-resume). F8 is not done (§7).
Rates in §1–§3 are for the code at 85f2a69, before these changes. F4 and F7 change no
statement counts. F5 changes only the log-read row. **§7 re-measures after F1–F3 and F6:
4,522 → ≈310 statements/s at N=4, A=100, W=20 (−93 %), of which ≈9 /s is multi-instance
overhead.**

Measured with `server/packages/api/test/db-load.test.ts` (harness in `test/db-load/`), at
feat/stateless-runner 85f2a69. All rates below are **SQL statements per second**: every
round trip, BEGIN and COMMIT included, as issued by the PostgreSQL stores in
`server/packages/store/src/postgres/*.ts`. Raw numbers are in
`db-load-multi-runner-2026-10-22.json`: `harness` is the test's `DB_LOAD_JSON` output, and
`live` holds the read-only oma_test counters behind §4.

## 1. Cost per source

Real defaults: lease 30 s, heartbeat tick 1 s (`min(renew 10 s, 1 s)`), claim retry 100 ms→5 s,
pending scan 5 s, Loop scan 15 s, delegation poll 200 ms. The Turn shape is calibrated to
oma-test: 12 tool steps, 55 durable events and ≈339 s per Turn.

| Source | Cost | Grows with | Main statements |
|---|---|---|---|
| Background loops | **1.22 /s per Runner** (pending scan 0.60, Loop scan 0.40, cleanup discovery 0.22) | N | `reconcileTerminatedExecutions` (2 seq scans), `SELECT DISTINCT session_id FROM pending_events`, `dispatchDue` |
| Heartbeat | **6.0 /s per active Turn**; +1.0 /s `listCommands` (seq scan) per active Child Turn | A | renew tx (4), `interruptRequested` (1), `getByPendingEventId` (1, also for non-children) |
| Turn lifecycle (claim → ack) | **660 per Turn** = 550 event appends (55 × 10) + 110 control; ≈1.95 /s amortized | A (Turn rate) | fenced append tx = 10 statements per durable event; `ackCompletedTurn` 13; `listWaits` (seq) 14 |
| Full log read on claim | **+⌈H/50⌉ statements and H rows per claim** (H = events already in the Session): 1 / 11 / 41 / 101 statements at H = 0 / 500 / 2,000 / 5,000. After F5: 1 / 1 / 3 / 6 | history | `readAllEvents` paged 50 rows (now 1,000); it also downloads every OSS-offloaded payload |
| Tool fence | **4 per sandbox op** (`ownsClaim` tx); +21 once per Session for Sandbox creation | A (tool rate) | `SELECT … FOR UPDATE` + `SELECT` on pending_events |
| Scan lookups | **0.263 /s per active Turn per Runner** | A × N | `sessions.getById` per pending Session per scan per Runner |
| Non-owner claim attempts | **2.87 /s per active Turn per other Runner** (161 failed claims per Turn per other Runner, 6 statements each) | **A × (N−1)** | claim tx (4) + 2 × `peek`; from: retry timer 1.27, 5 s scan 1.19, 15 s Loop scan 0.39 |
| Sync delegation wait | **30.8 /s per waiting parent** + **35.2 /s per waiting parent per other Runner** | W, **W × (N−1)** | every 200 ms: `ownsClaim` (4) + `get` (2), then a wake broadcast; each other Runner then does `getById` + a failed claim (7) |
| Global `delegation_lock` | 3 transactions per Turn, 12 per synchronous delegation | Turn rate | `acquire`/`releaseResourceUse`, `accept`, `saveWait`, `consumeResult`, `start`/`finishExecution` |
| Cleanup row that cannot complete (none in oma-test, §4) | **7.2 /s per row, forever** (2 Runners: 12 attempts + 12 SKIP LOCKED misses per min) | stuck rows K | `withEnvironmentLock` ×2 (18), `claimReclamation` (5), sweep tx |
| Idle Session | **0** (asserted: no Runner statement names an idle Session) | none | none |
| API SSE catch-up (not measured, from `event-catchup.ts`) | 0.5 /s per watched Session per API replica | watchers | `getEvents` every 2 s |

Whole-table scans (`seq` = no usable index; `full` = by design on a small table):

| Table | Per Turn (Turn activity) | Per Runner per minute (scans) | After 0021 | Why |
|---|---|---|---|---|
| delegation_waits | 14 | 16 | 0 | `listWaits` on every tool result and twice per claim; no index at all |
| delegation_executions | 0 | 16 | 0 (1 per delegation, `accept`) | status scan in `reconcileTerminatedExecutions`; `record->>'id'` filter in every delegation transaction |
| delegation_resource_uses | 4 | 0 | 4 | `record->>'sessionId'/'sandboxSessionId'` filters, no index |
| delegation_commands | 0 | 0 | 0 | `listCommands` on `record->>'executionId'`, no index (1 /s per active Child Turn) |
| pending_events (full) | 0 | 16 | 16 | `listPendingSessionIds` (small table, fine) |
| skills | 1 per equipped Skill (not exercised) | 0 | unchanged | `WHERE skill_id = $1` cannot use the `(tenant_id, skill_id)` key |

One synchronous delegation (parent Turn of 2 steps, child Turn of 3 steps, ≈87 s) adds
13 delegation_waits, 9 delegation_resource_uses, 6 delegation_executions and 93
delegation_commands scans. After 0021 it adds 9 delegation_resource_uses scans and 1
delegation_executions scan.

The delegation tables are never pruned. These scans are cheap at today's 182–184 rows. They
grow linearly with every delegation ever made. At N=4 and A=100, delegation_waits alone is
scanned ≈5 times a second (3.5 /s from tool results, 0.6 /s from claims, 1.1 /s from
reconcile). At 10^5 rows that is ≈0.15–0.5 vCPU, as much as all the polling at that scale
point.

## 2. Scaling model

With N Runners, A active Turns (children included), W of them parents in a synchronous
delegation wait, and K cleanup rows that cannot complete:

```
S ≈ 1.22·N + A·(8.23 + 0.263·N + 2.87·(N−1)) + W·(30.8 + 35.2·(N−1)) + 7.2·K   statements/s
          8.23 = heartbeat 6.0 + Turn lifecycle 1.95 + tool fences 0.28
```

Check: harness N=4, average A=7.5, W=0 → predicted 139 /s, measured 140 /s.

| Grows with | Terms |
|---|---|
| N only | background loops (1.22 per Runner) |
| A only | heartbeat, Turn lifecycle (appends), tool fences |
| W only | delegation poll (30.8 per waiting parent) |
| **A × N, W × N (multi-instance)** | non-owner claim attempts, scan lookups, delegation wake fan-out |
| History | full log read per claim (H/50), delegation-table seq scans (rows ever created) |
| K | stuck cleanup rows |

## 3. Projection

Capacity assumption, not measured: the RDS instance is shared by production and oma-test
(max_connections 3220; class not verified here). We assume each short statement costs
50–100 µs of RDS CPU (node-postgres sends unnamed extended-protocol statements, so every
statement is parsed and planned). That gives ≈10–20k statements/s per vCPU at saturation.
We call ≤ 25 % of the instance comfortable.

| Scale point | Today's code | of which multi-instance | After F1–F3 | Est. RDS CPU, today's code |
|---|---|---|---|---|
| oma-test idle, measured (§4) | 2.44 /s Runners + ≈0.8 /s API for one open console page | 0 | 2.44 /s | negligible |
| oma-test average: N=2, A≈0.3–0.6, W≈0.05–0.09, K=0 (§4) | ≈9–15 /s | 3–5 /s | ≈4 /s | negligible |
| N=2, A=20, W=0 | 235 /s | 57 /s | 55 /s | 0.01–0.02 vCPU |
| N=2, A=20, W=4 | 499 /s | 198 /s | 67 /s | 0.02–0.05 vCPU |
| N=4, A=20, W=4 | 908 /s | 595 /s | 70 /s | 0.05–0.09 vCPU |
| N=2, A=100, W=20 | 2,485 /s | 991 /s | 325 /s | 0.12–0.25 vCPU |
| N=4, A=100, W=0 | 1,794 /s | 861 /s | 268 /s | 0.09–0.18 vCPU |
| **N=4, A=100, W=20** | **4,522 /s** | **2,973 /s (66 %)** | **328 /s** | 0.23–0.45 vCPU |

"Multi-instance" counts the (N−1) terms: non-owner claim attempts and the delegation wake
fan-out. "After F1–F3" assumes a 10 s heartbeat, no non-owner attempts, and a 2 s delegation
poll without broadcasts.

At N=4, A=100, W=20 the load is about 4,500 round trips per second. It stays within a ≥4-vCPU
budget, but it is marginal on 2 vCPU when added to API and production traffic. It also costs
outside the database:

- about 1,100 statements/s per Runner on a 10-connection pool. At a 10 ms latency spike this
  needs 11 connections, so the pool saturates and heartbeats queue behind delegation polls.
- the "reads" are not read-only. Each failed claim and each `ownsClaim` takes `SELECT … FOR
  UPDATE` on the head `pending_events` row. That writes a WAL lock record and serializes with
  the owner's renew.

## 4. Live evidence (oma-test, 2 Runners)

### Idle window (measured)

2026-10-22 02:28:25 → 03:10:30 +08:00 (2,525 s). Both Runners were idle: 0 pending inputs and
0 running or waiting Sessions. The deltas also show one console tab open on a Session page.

| Counter | Δ | Rate | Model | Source |
|---|---|---|---|---|
| pending_events seq_scan | +1,338 | 0.53 /s | 0.533 | `listPendingSessionIds`, 5 s pending scan + 15 s Loop scan per Runner |
| delegation_executions seq_scan | +1,339 | 0.53 /s | 0.533 | status scan in `reconcileTerminatedExecutions`, same cadence |
| delegation_waits seq_scan | +1,339 | 0.53 /s | 0.533 | the waits status scan in the same call |
| session_cleanup idx_scan | +1,005 | 0.40 /s | 0.400 | cleanup discovery every 5 s per Runner |
| loops idx_scan | +503 | 0.20 /s | 0.133 + 0.067 | `dispatchDue` every 15 s per Runner, plus the console's `GET /v1/agents/:id/loops` every 15 s |
| pending_events idx_scan | +167 | 0.066 /s | 0.067 | the console's queued-input poll (`listUnclaimed`) every 15 s |
| events idx_scan | +1,259 | 0.50 /s | 0.5 | the API's `EventCatchup` for one open SSE stream, every 2 s |
| sessions idx_scan | +6,873 | 2.72 /s | not modelled | unattributed, most likely the open console on the API (below) |
| delegation_environments | +0 | 0 | 0 | idle Runners never touch a binding row |
| pending_events n_tup_upd | +0 | 0 | 0 | there is no heartbeat without a running Turn |

The two idle Runners issue 2.44 statements/s, which is the model's 1.22 per Runner. The open
console page adds ≈0.8 statements/s on the API.

**sessions 2.72 /s: unattributed.** The verification query below returned **no** open
executions and **no** waiting waits on oma_test (checked 2026-10-22 ≈03:20 +08:00), so the
reconcile-join explanation is refuted. The idle Runners' own statements match the model
(2.44 /s for two Runners), and `sessions` index scans do not add round trips the model misses
from the Runner side; the most likely source is the open console (Session list and sidebar
reads on the API), which this audit does not model. EXPLAIN is not available through the
Supabase RPC path used here, so the plan could not be inspected. At ≈2.7 index lookups/s this is
negligible either way.

```sql
SELECT 'execution' AS kind, record->>'status' AS status, count(*) FROM oma_test.delegation_executions
 WHERE record->>'status' IN ('queued', 'running') GROUP BY 2
UNION ALL
SELECT 'wait', record->>'status', count(*) FROM oma_test.delegation_waits
 WHERE record->>'status' = 'waiting' GROUP BY 2;
-- result on 2026-10-22: no rows
```

### Cumulative counters

`pg_stat_database.stats_reset` is NULL, so the window is unknown. The per-Runner cadence
counters measure Runner-seconds, not wall time:

- session_cleanup idx_scan 137,972 ÷ 0.2 /s ≈ 690,000 Runner-seconds;
- pending_events seq_scan 181,564 ÷ 0.267 /s ≈ 681,000;
- loops idx_scan 46,435 ÷ 0.067 /s ≈ 697,000 (console polling inflates this one slightly).

≈690,000 Runner-seconds is about 4 days with 2 Runners or 8 days with 1. oma_test was created
on 2026-10-14. The first version of this report claimed "≈4 days"; that was an estimate that
assumed 2 Runners throughout.

The figures below are therefore per input or per Turn-second, which do not depend on the window.
Only the averages per second are ranges.

| Counter | Live | Interpretation |
|---|---|---|
| pending_events n_tup_upd | 209,544 | ≈1 renew per active Turn-second, so ≈209k Turn-seconds: ≈345 s per input over 605 inputs. A_avg ≈ 0.3–0.6 |
| events n_tup_ins | 33,181 | 55 per input (the harness Turn shape is calibrated to this) |
| delegation_executions idx_scan | 370,067 | heartbeat 1 /s per Turn-second (≈209k), plus `get` 5 /s per waiting-parent second → ≈32k waiting-parent seconds. W_avg ≈ 0.05–0.09 |
| delegation_commands seq_scan | 33,467 | 1 /s per active child second → ≈33k, matching the line above |
| delegation_waits seq_scan | 190,857 | reconcile ≈184k + ≈6.9k from `listWaits`, ≈11 per input (harness: 14 per Turn) |
| pending_events idx_scan | 1,884,711 | 2 Runners throughout would predict 2.08M (heartbeat 627k + non-owner claims 397k + delegation poll and fan-out 960k + appends and fences 95k). 1 Runner would predict ≈1.04M. The value in between fits a mixed replica history |
| session_cleanup | 214 rows, 0 open, max 2 attempts, 218 attempts in total | **no stuck cleanup row.** The first version's hypothesis was wrong; F7 is insurance only |
| delegation_environments idx_scan | 546,854 | driven by activity (Δ 0 while idle), see below |

**delegation_environments.** The straight path per Turn costs ≈8 binding-row lookups:

- input trigger 1;
- `prepare`'s `withEnvironmentLock` 3;
- lifecycle `begin` 2 and `finish` 2;
- +6 more when the Turn creates the Sandbox.

A tool op touches the row only after it fails (`recover`, +3). For 605 inputs that is ≈5–9k,
1–2 % of the counter. The cleanup attempts add ≈3k.

The remainder needs a loop. Two exist, each bounded at 185 s:

- `withPreparationLock` retries every 100 ms (1 lookup each, up to ≈1,850) while another Turn's
  Sandbox creation is pending on the same binding. A parent and its children share one binding.
- `beginActivity` retries every 250 ms (2 lookups each, up to ≈1,480) while the binding is being
  reclaimed.

About 300 such waits would explain the counter. The harness does not model them, because its
fake Sandbox is created instantly. Verify with pg_stat_statements if the instance has it, or by
sampling `SELECT id, creation_pending, reclaiming FROM oma_test.delegation_environments WHERE
creation_pending OR reclaiming;` while delegations run.

## 5. Ranked fixes

Savings are at N=4, A=100, W=20 (4,522 /s).

| # | Fix | Saves | Risk | Interacts with |
|---|---|---|---|---|
| F1 | Delegation wait without the 200 ms poll and per-poll wake broadcast — **done (§7)** | **−2,668 /s (59 %)** | low–medium | #248 (recoverWaits), #251, #252, #254 |
| F2 | No claim attempts on heads another Runner owns — **done (§7)** | **−966 /s (21 %)** | low | #254, #248/#255 (takeover latency), #250 |
| F3 | Heartbeat at the renew interval; Interrupt via the renew row + Redis hint; no delegation lookup for non-children — **done (§7)** | **−560 /s (12 %)** | medium | #249, #240, #252, #254 |
| F4 | Indexes on delegation tables + filter `id` by column (migration 0021) — **done** | statements unchanged; removes ≈14 seq scans per Turn, 32 /min per Runner, 1 /s per child | low | #251, #252 |
| F5 | Stop re-reading the whole log, 50 rows per page, on every claim — **page size done** | ⌈H/50⌉ → ⌈H/1000⌉ statements per claim (done); H rows → current Turn + context (later) | low (page size) / medium (boundary) | #245, #247, #248, #253 |
| F6 | One reconcile, not one per scan per Runner; Loop scan without its own recovery scan — **Loop part done (§7)** | −0.5 /s per Runner; −0.39 /s per active Turn per other Runner (part of F2) | low | #254 |
| F7 | Exponential backoff for cleanup retries — **done** | −7.2 /s per stuck row (oma-test has none today: insurance) | low | none (termination path) |
| F8 | Tool fence from the local lease instead of an `ownsClaim` round trip — **not done (§7)** | −0.28 /s per active Turn | medium | #240, #254 |

**F1. Delegation wait.** `DelegationCoordinator.waitForResult` calls `assertOwner`
(`ownsClaim`, 4 statements) and `get` (2 statements) every 200 ms, then
`wake(childId)`. The wake goes to every Runner. The owner of the child usually ignores it,
because `RunnerDispatch.waking` holds the child for its whole drain when that drain started
from a wake. Every other Runner pays `getById` plus a failed claim. Fix: wake the child once, at accept; the 5 s scan already
covers a lost wake. Then wait for the child's completion: `completeTurn` already wakes the
parent and `finishExecution` publishes the notification. Keep a 2–5 s PG fallback poll.
Lease loss is already signalled through the Turn's abort signal, so `assertOwner` does not
need to run on every poll. Result: W × (30.8 + 35.2·(N−1)) → W × ≈3.

**F2. Non-owner claims.** When `claim` fails because another Runner holds a live lease,
`scheduleClaimRetry` retries at 100 ms→5 s for the whole Turn. Every 5 s scan and every
15 s Loop scan also try once per Runner. Fix:

- `listPendingSessionIds` lists only claimable heads. The query uses
  `pending_events_session_idx`:
  `SELECT session_id FROM (SELECT DISTINCT ON (session_id) session_id, claim_owner, claim_expires_at FROM pending_events ORDER BY session_id, seq) h WHERE claim_owner IS NULL OR claim_expires_at <= clock_timestamp()`
- No retry timer for the "owned by a live claim" case. The owner drains its own queue.
  #254's handoff releases the claim and wakes the other Runners. A crashed owner is found by
  the 5 s scan once its lease expires, so takeover stays within 30 s + 5 s, which #255
  accepts (35 s).

This also removes the shutdown claim-retry gap noted on 10-15.

**F3. Heartbeat.** The tick is `min(renew, 1 s)` only so that Interrupts are seen within a
second. Fix:

- Tick at `pendingClaimRenewIntervalMs` (10 s).
- Return the Interrupt marker from the renew `UPDATE … RETURNING`, keeping
  `interrupt_generation = claim_generation` for #249.
- Take the delegation execution from the claim: `drainLoop` already loads it, and
  non-children never query it.
- For low latency, the API publishes a signal after `requestInterrupt` (today it does not).
  `steer`/`interruptChildren` already wake the child. A hint for an active Session makes the
  owner check once, at once. The hint must bypass the `RunnerDispatch.waking` dedup, for
  example with its own signal kind.
- Without Redis, the fallback latency is ≤10 s.

Per active Turn: 6.0 → 0.4 /s. Quick wins can land first and alone: skip
`getByPendingEventId` for non-children (−1 /s per Turn) and fold `interruptRequested` into
the renew (−1 /s).

**F4. Indexes — done: migration `deploy/migrations/0021_delegation_lookup_indexes.sql`, mirrored in `schemaDdl`.**
The tables hold a few hundred rows. Migrations run in one transaction, as do 0012, 0015,
0018 and 0020 (and atomically through the test schema's RPC path), so the migration uses
plain `CREATE INDEX` under a 5 s `lock_timeout` rather than `CONCURRENTLY`:

```sql
CREATE INDEX IF NOT EXISTS delegation_waits_input_idx ON oma.delegation_waits ((record->>'callerSessionId'), (record->>'parentPendingEventId'));
CREATE INDEX IF NOT EXISTS delegation_waits_waiting_idx ON oma.delegation_waits (id) WHERE record->>'status' = 'waiting';
CREATE INDEX IF NOT EXISTS delegation_commands_execution_idx ON oma.delegation_commands ((record->>'executionId'));
CREATE INDEX IF NOT EXISTS delegation_executions_open_idx ON oma.delegation_executions (id) WHERE record->>'status' IN ('queued', 'running');
```

Reconciliation reads open rows `ORDER BY id LIMIT`, so the open-state partial indexes are
keyed by `id`. A partial index keyed by status was not enough: with sequential scans
disabled, the planner then walked the whole primary key. `PgDelegationStore`'s transaction
`read` now looks up executions and commands by the `id` column.

`test/delegation-index-plans.test.ts` (runs when `PG_TEST_URL` is set) captures the store's
own lookups and plans them with sequential scans disabled. Against PostgreSQL 18.6 (PGlite)
every lookup on the three tables uses an index:

| Lookup | Index |
|---|---|
| `listWaits` | delegation_waits_input_idx |
| `listCommands` | delegation_commands_execution_idx |
| `getByPendingEventId` | delegation_pending_identity_idx (existing) |
| reconcile, executions | delegation_executions_open_idx + sessions_pkey |
| reconcile, waits | delegation_waits_waiting_idx + sessions_pkey |
| transaction reads of waits by caller (`cancelWaits`, `saveWait`, `consumeResult`) | delegation_waits_input_idx |
| `hasResourceUsers`, queued executions | delegation_executions_open_idx |
| executions and commands by id | their primary keys |

The same run showed that parameterized keys (`record ->> $1 = $2`) are folded into
constants in node-postgres' unnamed-statement plans and match the expression indexes. The
migration also applied cleanly to a pre-0021 schema, and a second time as a no-op.

Not covered, and left as follow-ups:

- `delegation_resource_uses` (4 scans per Turn), which needs a `sandboxSessionId` index, plus
  reading leases by id (= pendingEventId);
- `skills.skill_id`;
- `accept`'s child-sequence read (`record->>'childId'` without `tenantId`);
- `command`'s caller-identity read on delegation_commands;
- pruning old delegation rows.

**F5. Log read.** `readAllEvents` paged 50 rows. Step one is done: it uses 1,000, as `EventCatchup` does.
Then build Adapter history from the last compaction boundary, and let planResume read only
the current Turn's events after the promoted seq. Each claim also decodes every OSS-offloaded
payload in the Session's history, so a long Session pays OSS GETs on every Turn.

**F7 — done.** `PgSessionCleanupStore.sweep` now doubles the retry delay after each failed
attempt: 5 s, 10 s, 20 s, … up to 10 minutes. Before, the delay was 5 s forever.

**F6 and F8** are as in the table. Not a #234 goal ("本期不做: 批量 append"): appends are 550 of
the 660 statements of a Turn. Group commit per flush would cut 10 statements per event to
≈1.5: one fence, one counter update and a multi-row INSERT.

Other findings:

- `PgDelegationStore.append` uploads OSS payloads inside the global-lock transaction
  (`consumeResult`, `finishExecution`, `applyCommand`). A large child result therefore holds
  `delegation_lock` and stalls every Runner's Turn start and end
  (`acquire`/`releaseResourceUse`).
- `requestInterrupt`'s `NOT EXISTS` reads every event of the Session. It should use the
  completion marker's idempotency key instead.
- The oma-test Runners' polling is production load, because the RDS is shared.
- Two 185 s retry loops poll the binding row: `withPreparationLock` every 100 ms and
  `beginActivity` every 250 ms. They are the likely source of the cumulative
  delegation_environments scans (§4). A wake when the creation or reclamation completes would
  replace them.
- Delegation records appear to stay open (queued, running or waiting) with no Turn running
  (§4). Every reconcile scan on every Runner looks them up again.

## 6. Harness

`cd server/packages/api && npx vitest run test/db-load.test.ts`: 5 cases, ≈5 s. Set
`DB_LOAD_JSON=<file>` to write the raw numbers.

- **Production wiring.** It builds N Runners exactly as `src/execution.ts` does (SessionRouter,
  RunnerDispatch, LoopScheduler at their defaults, each with its own claim owner) over one
  `createMemoryStores()` set. A one-process pub/sub double stands in for Redis. Sandboxes use
  `DefaultSandboxManager` + `FakeSandboxClient` with a counting lifecycle double. The cleanup
  outbox double mirrors `PgSessionCleanupStore.sweep`.
- **Metering.** A proxy wraps every store method. `db-load/pg-statements.ts` converts each
  call into the statements its PostgreSQL implementation issues, including branches that
  depend on the result (claimed / contended / empty, append hit, ack with idle). It also
  marks statements that are sequential scans for lack of an index.
- **Attribution.** An AsyncLocalStorage context follows awaits. Timers are labelled where
  they are created (`startClaimHeartbeat`/`tick`, `scheduleClaimRetry`,
  `RunnerDispatch.start`, `LoopScheduler.start`). Each `handleNewEvent` is labelled by its
  trigger and counts as an attempt until its claim succeeds. A Session signal's handling is
  labelled by its kind and origin (`wake <- api`, `check <- turn`).
- **Time.** Fake timers run at the real defaults (1:1 virtual time) and advance in 20 ms
  steps, settling promises between steps. Timers fire ≤20 ms late: the 1 s heartbeat was
  within 2 % and the 200 ms poll within 10 %; the poll measured 30.8 /s against 30 /s in
  theory. After the fixes the tick is 10 s and the fallback poll 2 s.
- **Assertions** are behavioural: every Turn completes with no drain errors, idle Sessions are
  never touched, and cleanup retries without backoff. Since §7 the tripwires fail on a return
  to per-second polling: heartbeat < 1 /s per active Turn, non-owner attempts < 0.1·N /s per
  active Turn, scan lookups < 0.05 /s, delegation wait < 5 /s per waiting parent, idle
  Runner < 2 /s. The harness itself changes no production source.
- **Limits.**
  - The cost map is static. It is not EXPLAIN on a live database, and the planner will pick
    seq scans on tiny tables anyway.
  - Not modelled: Redis, OSS, API routes, pool waits, and variation in Pi's event mix.
  - The scripted Adapter follows the 85f2a69 contract. After #244, only `scriptedAdapter`
    changes.
  - Attribution depends on the function names above. If one is renamed, its share moves to
    the activity that created the timer.

## 7. After F1, F2, F3 and F6 (measured)

Same harness, Turn shapes and defaults as §1–§3, on wt/db-load-fixes rebased on
feat/stateless-runner-resume bda2797. What the fixes change: the heartbeat ticks every 10 s,
the delegation wait polls every 2 s as a fallback, and a new `check` Session signal tells the
owner of a running Turn to re-read its durable state at once. Raw numbers are under
`harnessAfterFixes` in the JSON.

| Source | Before (§1) | After | Fix |
|---|---|---|---|
| Background loops | 1.22 /s per Runner | **1.02 /s per Runner** (pending scan 0.60, cleanup discovery 0.20, Loop dispatch query 0.20) | F6: a Loop tick scans retained input only after it dispatched or failed |
| Heartbeat | 6.0 /s per active Turn | **0.39 /s** (one renew transaction every 10 s; it returns the Interrupt marker) | F3 |
| Child Interrupt commands (`listCommands`) | 1.0 /s per active child | **0.09 /s** (with the child's heartbeat, and on a hint) | F3 |
| Turn lifecycle | 660 per Turn (1.95 /s) | 659 per Turn (1.94 /s) | the dead peek after a failed claim is gone |
| Tool fence | 4 per Sandbox op (0.28 /s per active Turn) | unchanged | F8 not done (below) |
| Scan lookups | 0.263 /s per active Turn per Runner | **0** | F2: the scan lists only heads no live claim holds |
| Non-owner claim attempts | 2.87 /s per active Turn per other Runner (161 failed claims per Turn) | **0.015 /s** (the input's wake: one failed claim + `headClaimable`, 5 statements per input) | F2 |
| Wake handling | 0.003 /s per active Turn per Runner | unchanged | |
| Sync delegation wait | 30.8 /s per waiting parent + 35.2 per other Runner | **1.74 /s + 0.07 per other Runner** | F1 |

Of the 1.74 /s per waiting parent, the execution reads of the 2 s fallback poll are 1.03 /s.
The rest are the delegation's one-off transactions (accept, saveWait, status changes, result
consumption) amortized over the 87 s wait, plus one renewal of the parent's claim on the
child's completion hint (4 statements per delegation). Per other Runner a delegation costs
one `getById` and one failed claim for the child's single wake.

Scaling model after the fixes (compare §2):

```
S ≈ 1.02·N + A·(2.61 + 0.003·N + 0.015·(N−1)) + W·(1.74 + 0.07·(N−1)) + 7.2·K   statements/s
          2.61 = heartbeat 0.39 + Turn lifecycle 1.94 + tool fences 0.28
```

Check: harness N=4, average A=7.53, W=0 → predicted 24.2 /s, measured 24.6 /s (the
difference is Sandbox creation, 21 statements once per Session, which neither model counts
per second).

| Scale point | Before (§3) | After (model above) | of which multi-instance | Change | Est. RDS CPU after |
|---|---|---|---|---|---|
| oma-test idle (2 Runners) | 2.44 /s | 2.0 /s | 0 | −16 % | negligible |
| oma-test average: N=2, A≈0.3–0.6, W≈0.05–0.09 | ≈9–15 /s | ≈3–4 /s | < 0.1 /s | −70 % | negligible |
| N=2, A=20, W=0 | 235 /s | 55 /s | 0.3 /s | −77 % | ≈0.005 vCPU |
| N=2, A=20, W=4 | 499 /s | 62 /s | 0.6 /s | −88 % | ≈0.005 vCPU |
| N=4, A=20, W=4 | 908 /s | 65 /s | 1.7 /s | −93 % | ≈0.005 vCPU |
| N=2, A=100, W=20 | 2,485 /s | 301 /s | 2.9 /s | −88 % | 0.015–0.03 vCPU |
| N=4, A=100, W=0 | 1,794 /s | 271 /s | 4.5 /s | −85 % | 0.014–0.027 vCPU |
| **N=4, A=100, W=20** | **4,522 /s** | **310 /s** | **8.7 /s (3 %)** | **−93 %** | 0.016–0.031 vCPU |

"Multi-instance" counts the (N−1) terms, as in §3. They now come only from wakes: one per
input and one per delegation, instead of every 200 ms, every scan and every retry. The
§3 estimate for "after F1–F3" (55 / 67 / 70 / 325 / 268 / 328 /s) is confirmed within 10 %.

What remains:

- **Turn lifecycle is 74 % of a running Turn's cost**, and 550 of its 659 statements are
  event appends (10 per durable event). Group commit per flush is the next lever; it is not
  a #234 goal ("本期不做: 批量 append").
- At N=4, A=100, W=20 a Runner issues ≈78 statements/s on its 10-connection pool, down from
  ≈1,100, so a latency spike no longer saturates the pool.
- `SELECT … FOR UPDATE` on the head `pending_events` row: failed claims drop from 161 per
  Turn per other Runner to one per wake. The tool fence (`ownsClaim`) and the append fences
  still take it.
- Idle cost is linear in N only: 1.02 /s per Runner, two thirds of it the 5 s pending scan
  (`reconcileTerminatedExecutions` 2 statements, `listClaimableSessionIds` 1).

### A child waiting for a concurrency slot (found during F1)

Not in §1, because the harness never reaches the parent's concurrency limit (four
children). A child whose execution could not start released its claim and was retried at
once: the claim itself succeeded each time, which reset the retry backoff, so the child
was retried every 100 ms for as long as it stayed queued. Each attempt claims, promotes its
input, reads the log and tries `startExecution` under the global `delegation_lock`: 33
statements. Measured with the harness metering (one Runner, limit 1, 2 s): **≈314
statements/s per queued child before, 0 after** until a slot frees. The 200 ms delegation
poll removed by F1 also woke it.

The child now schedules no retry while it waits for a slot. The execution that ends wakes
its parent's queued children (`DelegationCoordinator.wakeChildrenWaitingForSlot`), so a
queued synchronous child still starts at once (`delegation.test.ts` "starts a queued
synchronous child as soon as a sibling frees its slot, without polling for one"). What
remains is each Runner's 5 s pending scan, which still attempts a queued child, since its
head is claimable: ≈33 / 5 ≈ 6.6 statements/s per Runner per queued child. Checking the slot
before the input is promoted would remove most of it; that changes drainLoop's order and is
left as a follow-up.

### Latency kept

Each is asserted by a test (fake time unless noted):

| Behaviour | Bound | Test |
|---|---|---|
| Interrupt with Redis | the owner renews when the `check` hint arrives (< 50 ms) | `session-router/test/multi-runner.test.ts` "sees an Interrupt accepted on another Host at once…"; `api/test/events.test.ts` (the API publishes the hint); `api/test/runner-dispatch.test.ts` (the hint bypasses the wake dedup) |
| Interrupt without Redis | ≤ one renew interval (10 s) | `multi-runner.test.ts` "…within one renew interval when its hint is lost" |
| Synchronous child after its parent's Interrupt or termination | at once (< 500 ms real time; the child renews every 10 s) | `session-router/test/delegation.test.ts` "stops a synchronous child at once…" (2 cases) |
| Heartbeat | 6 renewals in 60 s at the 10 s default | `multi-runner.test.ts` "renews a running Turn's claim once per renew interval" |
| No contention | 0 claims by another Runner while the owner's lease is live (one per wake) | `multi-runner.test.ts` "makes no claim attempt from another Runner…" |
| Takeover after an owner crash | ≤ lease + scan (35 s); the race has one winner, the loser makes one attempt | `multi-runner.test.ts` "takes a crashed owner's Turn over…", "E8 two Runners race…" |
| Delegation result | < 100 ms after the child completes on another Runner (real time); ≤ 2 s when the hint is lost; no reads or wakes in between | `delegation.test.ts` "a synchronous wait …" (2 cases) |

The PostgreSQL statements changed by the fixes (`renewClaim` returning the marker,
`listClaimableSessionIds`, `headClaimable`) also pass `store/test/pending-event-store.test.ts`
against PostgreSQL 18 (PGlite, `PG_TEST_URL`), except three tests that need a second backend
waiting on a row lock, which PGlite's single backend cannot run.

### F8 is not done

The tool fence (`assertExecutionOwner`, #240) checks the attempt's `stopped` flag and then the
durable claim with `ownsClaim`. A fence from local lease state would only know when this
Runner last renewed. It could not see a claim that is gone while the lease still looks live
locally: the API's termination deletes the Session's `pending_events` in another process, and
the Runner would learn of it only at its next renewal, now up to 10 s later. Clock drift
between the Runner and PostgreSQL would also move the local expiry. #240's guarantee, "a
Runner that no longer owns the Turn sends its Sandbox execution nothing", would weaken to
"…within a renew interval", for 0.28 /s per active Turn (≈28 /s at A=100). Not worth it.

### F6, the part not done

The Loop tick no longer reconciles or scans on an idle tick. Each Runner still reconciles on
every 5 s pending scan (2 statements, 0.4 /s per Runner); one reconcile across the fleet would
need a leader or a shared lock. Not worth it at 0.4 /s per Runner.
