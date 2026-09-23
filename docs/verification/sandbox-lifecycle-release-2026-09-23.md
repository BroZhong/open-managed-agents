# Sandbox lifecycle production release — 2026-09-23

Scope: #172–#176. User authorized production deployment and online testing.
Times in evidence are UTC; the release date above is Asia/Shanghai.

## Release

- Target: `agent-platform`, Shanghai, `oma-infra/oma-server`.
- Release source: `69b8c4be0eb7`, branch `codex/sandbox-idle-lifecycle`.
  Includes `origin/main` at `92d4633`, preserving the already-deployed
  JSONB-unsafe tool-result fix from `8fcff12`.
- Server image: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server:69b8c4be0eb7`.
- Running image digest: `sha256:a9bffbc42276a7ab975b5eccfb1c2e255e6e1177f18f48d2cb474fa58f0ae30e`.
- Web image retained: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web:d7eed9764d9c`.
- Built and pushed with `bash build.sh --push server` from the clean release
  checkout at `vfs-dev:~/workspace/yuzhong/open-managed-agents`. Remote GitHub
  fetch stalled; a Git bundle transferred the exact already-pushed commit.
- Applied migration `0014_sandbox_lifecycle.sql` through the existing production
  Supabase `/pg/query` administrative endpoint. Verified `supabase_admin`,
  `supabase_db` and all three unique fixture Session IDs before mutation.
  Credentials stayed in memory. The application role can SELECT/INSERT/DELETE
  activity rows and execute the enabled input trigger.
- Deployment used `deploy/scripts/deploy-app.sh` with the explicit Server/Web
  images, first server-side dry-run, then `--apply --confirm-production`.
  The pre-cutover snapshot contained zero pending inputs and running Sessions.
- Retested merged Store/API suites: 150 and 421 passed respectively; opt-in
  database and external-service skips are not counted as passes. Earlier
  lifecycle tests and real-time gateway acceptance remain documented in
  [the pre-release report](sandbox-lifecycle-2026-09-22.md).
  The merged API TypeScript check also passed.

## Controlled activation

`SANDBOX_IDLE_SWEEP=true` with these exact root Session IDs in
`SANDBOX_IDLE_BINDINGS`:

- `sess_CQWe4-RJ4W8NAw6Tk12Jh`: saved Workspace and idle/rebuild verification.
- `sess_mA7cS0vO2CHQso2MFC0hQ`: shared parent/background child verification.
- `sess_YKnmJTKv5ROPOcfrmGV4p`: independent Session in the same Workspace.

All belong to the isolated tenant `sandbox-release-1790096976541` and Workspace
`ws_8_TlUTUiL4kPooMd0UX6T`. No existing user Sandbox deadline or lifecycle
ownership was changed. This is a production canary release, not global enablement.

## Online finding: optional tool arguments

The first two shared-child attempts failed because the model supplied invented
`resume` values. The Host rejected those IDs correctly; neither attempt is
counted as passed. Exact-argument prompting did not fix the problem.

A minimal paired request isolated the cause. Pi 0.83's `openai-responses`
transport defaults `supportsStrictMode` to false and therefore omits the wire
`strict` field. The deployed Responses gateway returned the omitted case with
`strict:true` and changed `required:["prompt"]` to include both `resume` and
`run_in_background`; the model supplied `resume:"omitted"`. With explicit
`strict:false`, the same gateway retained the original required list and the
model omitted `resume` correctly. This matches the documented
[Responses default normalization](https://developers.openai.com/api/docs/guides/function-calling#strict-mode).

Updated only GPT-5.6 Sol's `compat.supportsStrictMode=true` in the existing
`oma-pi-gateway` model catalog, preserving all other fields and credentials.
This makes ordinary Pi function tools emit `strict:false`; it does not enable
strict tool schemas. Restarted the Host with zero pending/running work and zero
unresolved activities. Other model definitions were not modified.

After replacement of `oma-server-64c89d49b7-2vhtc` by
`oma-server-68cb997c67-ftj79`, all three Sandbox IDs and idle timestamps were
unchanged. Both idle/independent bindings retained their original
`2026-09-22T17:14:19Z` idle start. The public health endpoint remained healthy.

## Completed acceptance

The deployed Host has passed lazy creation, public-API Workspace readback,
independent Sandbox identity and restart persistence checks. All three created
Sandbox resources have no `spec.shutdownTime`.

The corrected shared-child retry passed: parent completion was observed while
the child was still running, with one durable activity and one pending input
protecting the binding. The child executed the exact `sleep 90; cat ...` command
and returned the parent's original temporary marker. Its durable result became
`completed` / `processed`; only after settlement did the shared binding acquire
its new idle start at `2026-09-22T17:26:25.904Z`. Read-only trace audit confirmed
the successful `Agent` call omitted `resume`, and the independent Session's
exact command verified that the shared Workspace file was present while the
other Session's temporary marker was absent.

At `2026-09-22T17:44:27.211Z`, after **1,808,039 ms (30 minutes 8 seconds)**
from the first confirmed idle timestamp, the deployed sweeper had removed both
original idle Sandbox bindings. Read-only checks every 30 seconds had confirmed
retention before the boundary; no clock, deadline or idle timestamp was shortened.
Kubernetes independently confirmed that both original resources were absent.
The later-settled shared binding remained on its original Sandbox, correctly
preserving its separate full idle period.

The same original Session then completed a real model Turn on a new Sandbox,
`sandbox-system--auto-story-v2-cp484`. Its exact shell command checked that the
old `/tmp` marker was absent and read the unchanged persisted Workspace bytes.
The replacement resource also had no shutdown deadline.

Cleanup terminated all four verification Sessions after confirming settlement.
All four allocated verification Sandbox resources (three original, one rebuilt)
are absent. Final database inspection found zero active verification API keys,
zero unresolved activities and zero pending inputs. The verification Agent,
terminated Session histories and small Workspace marker file remain available
for audit. The selected test bindings remain the only enabled bindings.

Final production state: one ready Host, zero container restarts, the expected
image digest, and public `/api/health` returning `{"status":"ok"}`. No idle-sweep
failure was observed during acceptance.

The [complete JSON evidence](sandbox-lifecycle-release-2026-09-23.json) contains
the failed and corrected attempts, successful tool traces, paired Responses
probe, real idle-monitor timestamps and Kubernetes cleanup snapshots. Reproduce
with the scripts and safe activation/rollback steps in
[the deployment procedure](../sandbox-lifecycle-deployment.md).
