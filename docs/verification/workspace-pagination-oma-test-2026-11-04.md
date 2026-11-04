# Workspace recency and pagination — oma-test, 2026-11-04

The Agent sidebar orders named Workspaces by the latest visible, non-Loop,
non-delegated Session update for that Agent, descending, with Workspace ID as
the descending tie-breaker. It requests 15 Workspaces initially and another 20
for each Show more. PostgreSQL filters, aggregates and paginates the results;
the API no longer reads every Workspace and issues per-Workspace Session queries.
Session pagination remains independent at five initially, twenty subsequently.

## Release

- Application source: `436701d105d8a57281568a4924e58e90bd97dc23`.
- Built from a clean, isolated checkout on `vfs-dev` with `build.sh --push server web`.
- Immutable build tag: `202611041534`.
- API: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:af4bb67faba4c8df307a21349ca0f4dc5c32a9b75ece8c1bd18908b5006a32bb`.
- Web: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web@sha256:a711fe146d3cccc64b3bb11ef3ad2424e316262167257ad6834bf69a296326cd`.
- Applied the complete rendered test overlay to `agent-platform/oma-test` after
  reviewing `kubectl diff`; only API and Web image fields differed.
- Both rollouts completed. Public `/api/ready` returned `{"status":"ok","role":"api"}`.
- No migration. Runner and image builder retain digest
  `6d5823b163d3a92d23b4981db92a93ad64dc8dd2e47731aab0ef4df6a8ad015a`.
- Production was not deployed.

## Verification

Local checks:

- Web: 65 files, 527 tests passed with `--maxWorkers=2`; production build passed.
  The first unrestricted concurrent run had one existing child-Session tab test
  time out at five seconds; the complete rerun passed without source changes.
- API: 90 files, 1938 passed, 21 environment-gated tests skipped.
- Workspace PostgreSQL store: 13 passed using the pg-mem harness.
- In-memory stores: 120 passed.
- API, Web and both store packages passed TypeScript checks; generated OpenAPI
  validation passed with its four existing lint warnings.

Live acceptance used a dedicated disposable Tenant, account and API key in
`oma_test`, with 38 named Workspaces and controlled Session fixtures. No inference
or Sandbox was started. The fixtures, account and key were removed afterwards.

- Public authenticated API returned pages of **15, 20, 3**, all 38 IDs once in
  the expected order. Timestamps deliberately differed within one millisecond,
  exercising PostgreSQL microsecond cursor precision.
- Loop-only, delegated-only, deleted Session, deleted Workspace, unnamed and
  other-Agent fixtures were excluded before pagination.
- Invalid limits/cursors returned 400; another Agent's list was empty.
- Workspace Session pagination returned five then two, independently.
- Updating the oldest fixture Session to `running` moved its Workspace to the
  first API result with `hasRunningSessions: true`.
- Authenticated Chrome verified **15 → 35 → 38** rendered Workspace rows;
  Show more disappeared at the end. Expanding the first Workspace showed five
  Sessions; its Show more displayed all seven while keeping 38 Workspace rows.
- The next normal summary refresh moved the running Workspace to the first row
  and displayed its collapsed running indicator without a manual page reload.
- The sidebar regression also covers next-page failure/retry while preserving
  existing rows and refreshing loaded pages without duplicate Workspace rows.

## Test rollback

Render the test overlay with the following prior API/Web digests and the retained
Runner/image-builder digest above, then apply it and wait for both rollouts:

- API: `6d5823b163d3a92d23b4981db92a93ad64dc8dd2e47731aab0ef4df6a8ad015a`.
- Web: `b0d6399ef708f813d823cb2ee7e34ef230d1a568f1e56bcfdeeeedcd991258f7`.
