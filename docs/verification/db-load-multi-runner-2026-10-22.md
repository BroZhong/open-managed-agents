# Database load of N Runners (2026-10-22)

Question (#234): with several Runners on one PostgreSQL, does the database load become too
high, and if so where and how do we fix it?

Short answer: no, not at today's scale. oma-test averages ≈23 statements/s, and a third
of that is probably one stuck cleanup row (to verify, §4). At the next scale points the polling stays within a
≥4-vCPU budget: ≈4,500 statements/s at N=4 Runners, A=100 active Turns and W=20 delegation
waits. But two thirds of that is multi-instance overhead that does no work, and it grows
with Turns × Runners and with waits × Runners.

Separately, three costs grow without bound with history: unindexed scans of the
never-pruned delegation tables, the full event-log read on every claim, and cleanup rows
retried every 5 s forever. These would make the database the bottleneck before the polling
does.

Three fixes remove ≈93 % of the projected load: the delegation wait (F1), non-owner claims
(F2) and the heartbeat cadence (F3). Indexes (F4) remove the unbounded scans.

Measured with `server/packages/api/test/db-load.test.ts` (harness in `test/db-load/`), at
feat/stateless-runner 85f2a69. All rates below are **SQL statements per second**: every
round trip, BEGIN and COMMIT included, as issued by the PostgreSQL stores in
`server/packages/store/src/postgres/*.ts`. Raw numbers are in
`db-load-multi-runner-2026-10-22.json`.

## 1. Cost per source

Real defaults: lease 30 s, heartbeat tick 1 s (`min(renew 10 s, 1 s)`), claim retry 100 ms→5 s,
pending scan 5 s, Loop scan 15 s, delegation poll 200 ms. The Turn shape is calibrated to
oma-test: 12 tool steps, 55 durable events and ≈339 s per Turn.

| Source | Cost | Grows with | Main statements |
|---|---|---|---|
| Background loops | **1.22 /s per Runner** (pending scan 0.60, Loop scan 0.40, cleanup discovery 0.22) | N | `reconcileTerminatedExecutions` (2 seq scans), `SELECT DISTINCT session_id FROM pending_events`, `dispatchDue` |
| Heartbeat | **6.0 /s per active Turn**; +1.0 /s `listCommands` (seq scan) per active Child Turn | A | renew tx (4), `interruptRequested` (1), `getByPendingEventId` (1, also for non-children) |
| Turn lifecycle (claim → ack) | **660 per Turn** = 550 event appends (55 × 10) + 110 control; ≈1.95 /s amortized | A (Turn rate) | fenced append tx = 10 statements per durable event; `ackCompletedTurn` 13; `listWaits` (seq) 14 |
| Full log read on claim | **+⌈H/50⌉ statements and H rows per claim** (H = events already in the Session): 1 / 11 / 41 / 101 statements at H = 0 / 500 / 2,000 / 5,000 | history | `readAllEvents` pages 50 rows; also downloads every OSS-offloaded payload |
| Tool fence | **4 per sandbox op** (`ownsClaim` tx); +21 once per Session for Sandbox creation | A (tool rate) | `SELECT … FOR UPDATE` + `SELECT` on pending_events |
| Scan lookups | **0.263 /s per active Turn per Runner** | A × N | `sessions.getById` per pending Session per scan per Runner |
| Non-owner claim attempts | **2.87 /s per active Turn per other Runner** (161 failed claims per Turn per other Runner, 6 statements each) | **A × (N−1)** | claim tx (4) + 2 × `peek`; from: retry timer 1.27, 5 s scan 1.19, 15 s Loop scan 0.39 |
| Sync delegation wait | **30.8 /s per waiting parent** + **35.2 /s per waiting parent per other Runner** | W, **W × (N−1)** | every 200 ms: `ownsClaim` (4) + `get` (2), then a wake broadcast; each other Runner then does `getById` + a failed claim (7) |
| Global `delegation_lock` | 3 transactions per Turn, 12 per synchronous delegation | Turn rate | `acquire`/`releaseResourceUse`, `accept`, `saveWait`, `consumeResult`, `start`/`finishExecution` |
| Cleanup row that cannot complete | **7.2 /s per row, forever** (2 Runners: 12 attempts + 12 SKIP LOCKED misses per min) | stuck rows K | `withEnvironmentLock` ×2 (18), `claimReclamation` (5), sweep tx |
| Idle Session | **0** (asserted: no Runner statement names an idle Session) | none | none |
| API SSE catch-up (not measured, from `event-catchup.ts`) | 0.5 /s per watched Session per API replica | watchers | `getEvents` every 2 s |

Whole-table scans (`seq` = no usable index; `full` = by design on a small table):

| Table | Per Turn (Turn activity) | Per Runner per minute (scans) | Why |
|---|---|---|---|
| delegation_waits | 14 | 16 | `listWaits` on every tool result and twice per claim; no index at all |
| delegation_executions | 0 | 16 | status scan in `reconcileTerminatedExecutions`; `record->>'id'` filter in every delegation transaction |
| delegation_resource_uses | 4 | 0 | `record->>'sessionId'/'sandboxSessionId'` filters, no index |
| delegation_commands | 0 | 0 | `listCommands` on `record->>'executionId'`, no index (1 /s per active Child Turn) |
| pending_events (full) | 0 | 16 | `listPendingSessionIds` (small table, fine) |
| skills | 1 per equipped Skill (not exercised) | 0 | `WHERE skill_id = $1` cannot use the `(tenant_id, skill_id)` key |

One synchronous delegation (parent Turn of 2 steps, child Turn of 3 steps, ≈87 s) adds
13 delegation_waits, 9 delegation_resource_uses, 6 delegation_executions and 93
delegation_commands scans.

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
| oma-test now: N=2, A≈0.6, W≈0.09, K≈1 (§4) | ≈23 /s | 5 /s | ≈11 /s (with F7: ≈4) | negligible |
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

The cumulative `pg_stat_user_tables` counters fit the model. The stats window comes from
`session_cleanup.idx_scan` = 137,972 ÷ (2 Runners × 0.2 /s) = 344,930 s ≈ 4.0 days.

| Counter | Live | Model |
|---|---|---|
| loops idx_scan | 46,435 | `dispatchDue` every 15 s × 2 Runners → 45,991 (−1 %) |
| pending_events seq_scan | 181,564 | `listPendingSessionIds` at 5 s + 15 s × 2 Runners → 183,963 (+1 %) |
| delegation_executions seq_scan | 184,256 | the reconcile status scan, same cadence → 183,963 |
| delegation_waits seq_scan | 190,857 | reconcile 183,963 + 6,894 ≈ 11 per input (harness: 14 per Turn) |
| pending_events n_tup_upd | 209,544 (≈350 per input) | ≈1 renew per active Turn-second → A_avg ≈ 0.6, ≈345 s per input |
| delegation_executions idx_scan | 370,067 | 1 /s per active Turn (heartbeat) + 5 /s per waiting parent → W_avg ≈ 0.09 (≈32k waiting-seconds) |
| delegation_commands seq_scan | 33,467 | 1 /s per active child → ≈33k child-seconds, matching the 32k waiting-seconds above |
| events n_tup_ins | 33,181 | 55 per input (the harness Turn shape is calibrated to this) |
| pending_events idx_scan | 1,884,711 | heartbeat 627k + non-owner claims 397k + delegation poll/fan-out 960k + appends/fences 95k ≈ 2.08M (+10 %) |
| delegation_environments idx_scan | 546,854 (1.59 /s) | per-Turn use explains < 10k. The residual ≈1.56 /s matches **one cleanup row whose Sandbox binding is still in use, retried every 5 s**: `claimReclamation` refuses, then two `withEnvironmentLock` calls; 8 index lookups per retry × 0.2 /s = 1.6 /s. A gateway delete failure would cost only ≈0.4 /s, so it does not fit |

Hypothesis to verify (read-only):
`SELECT session_id, attempts, retry_at FROM oma_test.session_cleanup WHERE completed_at IS NULL ORDER BY attempts DESC;`
We expect one row with ≈70,000 attempts, probably a terminated Session whose binding a live
Session still uses (for example a Child of a running parent). If it is there, that row is
about a third of today's oma-test Runner load. Such a row only completes when the binding
is released, so it can be retried for days.

## 5. Ranked fixes

Savings are at N=4, A=100, W=20 (4,522 /s).

| # | Fix | Saves | Risk | Interacts with |
|---|---|---|---|---|
| F1 | Delegation wait without the 200 ms poll and per-poll wake broadcast | **−2,668 /s (59 %)** | low–medium | #248 (recoverWaits), #251, #252, #254 |
| F2 | No claim attempts on heads another Runner owns | **−966 /s (21 %)** | low | #254, #248/#255 (takeover latency), #250 |
| F3 | Heartbeat at the renew interval; Interrupt via the renew row + Redis hint; no delegation lookup for non-children | **−560 /s (12 %)** | medium | #249, #240, #252, #254 |
| F4 | Indexes on delegation tables + filter `id` by column (migration 0021) | statements unchanged; removes ≈14 seq scans per Turn, 32 /min per Runner, 1 /s per child | low | #251, #252 |
| F5 | Stop re-reading the whole log, 50 rows per page, on every claim | ⌈H/50⌉ → ⌈H/1000⌉ statements per claim; H rows → current Turn + context | low (page size) / medium (boundary) | #245, #247, #248, #253 |
| F6 | One reconcile, not one per scan per Runner; Loop scan without its own recovery scan | −0.5 /s per Runner; −0.39 /s per active Turn per other Runner (part of F2) | low | #254 |
| F7 | Exponential backoff for cleanup retries | −7.2 /s per stuck row (likely −7 /s in oma-test today) | low | none (termination path) |
| F8 | Tool fence from the local lease instead of an `ownsClaim` round trip | −0.28 /s per active Turn | medium | #240, #254 |

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

**F4. Indexes (draft for `deploy/migrations/0021_delegation_lookup_indexes.sql` + `schema.ts`).**
The tables are tiny, so a plain `CREATE INDEX` under the usual `lock_timeout` is enough:

```sql
CREATE INDEX IF NOT EXISTS delegation_waits_input_idx ON oma.delegation_waits ((record->>'callerSessionId'), (record->>'parentPendingEventId'));
CREATE INDEX IF NOT EXISTS delegation_waits_waiting_idx ON oma.delegation_waits ((record->>'callerSessionId')) WHERE record->>'status' = 'waiting';
CREATE INDEX IF NOT EXISTS delegation_commands_execution_idx ON oma.delegation_commands ((record->>'executionId'));
CREATE INDEX IF NOT EXISTS delegation_executions_open_idx ON oma.delegation_executions ((record->>'status')) WHERE record->>'status' IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS delegation_resource_uses_binding_idx ON oma.delegation_resource_uses ((record->>'sandboxSessionId'));
CREATE INDEX IF NOT EXISTS skills_skill_id_idx ON oma.skills (skill_id);
```

Two code changes go with them:

- `PgDelegationStore`'s transaction `read` should map an `id` filter to the `id` column.
  Today every delegation transaction runs `this.execution(tx, id)`, which filters
  `record->>'id'` and scans the table.
- `releaseResourceUse` should read the row by its id, which is the pendingEventId.

Pruning old delegation rows is a separate follow-up.

**F5. Log read.** `readAllEvents` pages 50 rows. Step one: use 1,000, as `EventCatchup` does.
Then build Adapter history from the last compaction boundary, and let planResume read only
the current Turn's events after the promoted seq. Each claim also decodes every OSS-offloaded
payload in the Session's history, so a long Session pays OSS GETs on every Turn.

**F6–F8** are as in the table. Not a #234 goal ("本期不做: 批量 append"): appends are 550 of
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

## 6. Harness

`cd server/packages/api && npx vitest run test/db-load.test.ts`: 5 cases, ≈15 s. Set
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
  trigger and counts as an attempt until its claim succeeds.
- **Time.** Fake timers run at the real defaults (1:1 virtual time) and advance in 20 ms
  steps, settling promises between steps. Timers fire ≤20 ms late: the 1 s heartbeat is
  within 2 % and the 200 ms poll within 10 %; the poll measured 30.8 /s against 30 /s in
  theory.
- **Assertions** are behavioural: every Turn completes with no drain errors, idle Sessions are
  never touched, and cleanup retries without backoff. The tripwires are set at about twice
  today's cost. No production source was changed.
- **Limits.**
  - The cost map is static. It is not EXPLAIN on a live database, and the planner will pick
    seq scans on tiny tables anyway.
  - Not modelled: Redis, OSS, API routes, pool waits, and variation in Pi's event mix.
  - The scripted Adapter follows the 85f2a69 contract. After #244, only `scriptedAdapter`
    changes.
  - Attribution depends on the function names above. If one is renamed, its share moves to
    the activity that created the timer.
