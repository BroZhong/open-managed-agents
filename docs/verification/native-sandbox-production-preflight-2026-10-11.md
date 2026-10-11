# Native Sandbox lifecycle production test preflight

Read-only inspection on 2026-10-11 (Asia/Shanghai), cluster `agent-platform`,
namespace `oma-infra`. Candidate commit: `a6340cc` on
`codex/native-sandbox-lifecycle`.

## Observed state

- `oma-runner`: one ready replica, image
  `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server:thinking-ad04fbd`.
  Reading the deployed Sandbox Manager source confirms `sweepIdle` is present
  and `SANDBOX_RUNNING_SECONDS` is absent: the new policy is not deployed.
- `oma-api`: one ready replica, image
  `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:db8144236b0f200e5bf11d2d9b159ea6fdfe59190df8099740bdf20df2c2a95c`.
- Legacy combined `oma-server`: zero replicas.
- Production environment table has `idle_since` and `reclaiming`, but no
  `creation_pending`; migration 0020 has not been applied.
- Session counts at inspection: 1,948 idle and 129 terminated; no other status
  returned. This is a point-in-time observation, not a drain guarantee.

No production data, Deployment, input queue, or Sandbox was changed by this
preflight. No claim is made that the new feature passed production API testing.
The earlier isolated application integration used production E2B/OSS but a local
PostgreSQL schema; it is not equivalent to the requested production application test.

## Concrete prerequisite for the production API test

The implementation is committed and reviewable. Deployment must follow
`docs/sandbox-lifecycle-deployment.md` and migration
`deploy/migrations/0020_native_sandbox_lifecycle.sql`:

1. Build the committed candidate's Server image on `vfs-dev`, record its immutable
   digest, and verify the image includes the native policy. Preserve current image
   identities and back up the affected database state before cutover.
2. Recheck and drain active execution. Stop every old execution-capable Runner;
   keep the legacy combined Deployment at zero. The API can durably queue input
   during the short execution interruption.
3. Apply migration 0020 to production. This removes the old `sandbox_activities`
   table, `idle_since` column and old trigger, then installs binding coordination.
   It is not a read-only test and is incompatible with restarting the old Runner.
4. Update the actual split API/Runner Deployment image fields to the verified
   candidate, restore the Runner replica, and check readiness and startup logs.
   Do not use the legacy `deploy-app.sh` against the zero-replica combined
   Deployment as though that released the current Runner.
5. Through the production API, use a new dedicated verification Tenant/key, Agent,
   Sessions and Workspaces. Verify lazy creation, cross-Turn reuse, shared child
   protection, idle timeout, isolated fault recovery, saved OSS data and direct
   termination. Any accelerated expiry or fault injection must target exact newly
   created test resources only; never stop the shared Runner merely to simulate
   a fault after cutover.
6. Revoke temporary credentials and remove only recorded test resources/files.
   Preserve sanitized evidence and report limitations separately from successes.

Existing business Sandboxes are not part of the test cleanup. Their historical
never-timeout configuration is not automatically migrated by this change. No
blanket existing-resource deletion or policy patch is included.

The current request authorizes production testing, but this prerequisite also
requires a shared-service deployment and destructive schema migration. Obtain
explicit confirmation for that cutover before proceeding. No approval blocker
came from a tool; this distinction follows the actual live state and the repository
release requirement that implementation/tests alone do not authorize release.

## Authorization and execution update

The user authorized production deployment and migration after incorporating latest
main. `origin/main` at `1a964e4` was merged without conflicts in `5cbdf66`. Migration
0020 and production rollout were then performed; a production-discovered idle
settlement issue was corrected in `12f6933`. This preflight is historical. See
`native-sandbox-production-2026-10-11.md` for the final production result.
