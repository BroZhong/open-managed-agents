# PR-A on oma-test (2026-10-22)

PR-A of #234 (TurnJournal persistence, #235–#239, #241–#244, plus #246 and the DB-load fixes in
migration 0021) released to the test environment only. Production (`oma-infra`) was not touched.

## Release

| Item | Value |
| --- | --- |
| Commit | `feat/stateless-runner` `0bdc0d5e1cc5` (full suite green: adapter 430, session-router 159, api 494, store 166, web 491, cli 27; all typechecks; openapi:check) |
| Images | `oma-server:0bdc0d5e1cc5` (API and Runner), `oma-web:0bdc0d5e1cc5`, built on vfs-dev from a git bundle |
| Manifest | `render.mjs test` + `kubectl diff` (image fields only) + `apply`; Runner 2 replicas, strategy Recreate |
| Migration | `0021_delegation_lookup_indexes.sql` applied to `oma_test` before the rollout (indexes only) |
| Rollback | API `oma-server@sha256:ceb8726f…`, Runner `oma-server@sha256:401c5fe4…`, Web `oma-web@sha256:a909ab8d…` |
| Pre-check | 0 pending inputs and 0 running/waiting Sessions before the rollout |

## Release verifier

`deploy/scripts/verify-api-runner-release.mjs` inside a Runner Pod with
`OMA_LIVE_BASE_URL=https://agentry-test.welltop.tech/api VERIFY_SCHEMA=oma_test`, phases `init`,
`basic`, `real-start`, `real-finish`, `interrupt`, `delegation-sync`, `delegation-async`, `loop`,
`terminate`, `active-terminate`, `cleanup`: **26/26 checks passed** (evidence:
`pr-a-oma-test-2026-10-22.json`). Real model `openai-codex/gpt-5.6-sol` with a 45 s Sandbox command,
durable Interrupt with preserved tail input, real sync and background Child Sessions, Loop cadence,
idle and active termination with Workspace retention.

## Journal flush latency (Runner logs, `turn_journal_flush`)

| Flushes | Errors | p50 | p90 | p99 | max | events/flush p50 (max) | bytes p50 (max) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 91 | 0 | 4.0 ms | 13.2 ms | 21.4 ms | 26.9 ms | 1 (5) | 212 B (5,473 B) |

No flush carried ≥64 KiB in this run; #255 adds a large tool result to measure that case.
All verification Turns were claimed by one of the two Runners.

## Database counters (pg_stat_user_tables, schema `oma_test`)

Window 04:10:09 → 04:25:32 (+08:00), 923 s, 11 inputs, including the verifier run:

| Table | Change | Before migration 0021 (idle rate) |
| --- | --- | --- |
| delegation_waits seq_scan | **+0** (idx_scan +501) | +0.53 /s |
| delegation_executions seq_scan | **+0** (idx_scan +696) | +0.53 /s |
| delegation_commands seq_scan | +25 | — |
| pending_events n_tup_upd | +143 for 11 inputs (≈13 per input) | ≈350 per input cumulative before |
| events n_tup_ins | +168 | — |

The 0021 indexes removed the delegation sequential scans. The remaining multi-Runner costs
(heartbeat cadence, failed claims, delegation wait polling) are scheduled with PR-B; see
`db-load-multi-runner-2026-10-22.md`.
