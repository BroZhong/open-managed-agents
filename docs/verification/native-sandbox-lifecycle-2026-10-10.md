# Native Sandbox lifecycle capability gate (#217)

## Decision: not qualified; #218–#222 remain blocked

The requested policy is 24 hours running, pause on expiry, retain for 24 hours
**starting after actual pause completion**, then platform deletion; ordinary
binding idle changes the running deadline to 30 minutes. Pi stays in the Runner.
This report does not change ADR-0017 or activate the proposed policy.

The isolated happy paths below passed. They do **not** establish the required
retention anchor during delayed pause completion. The inspected upstream source
starts retention when requesting pause, before completion. We cannot certify the
deployment's delayed-pause behavior from these fast observations or map the
deployed image digest to that upstream revision. This is a qualification blocker,
not a claim that this run observed premature deletion or that all of #217 passed.

#217 explicitly requires: “任一能力不满足时明确报告差异并阻塞依赖任务，不悄悄改变策略、
扩展到 Kubernetes 直接管理或新增控制器。” No application migration, schema removal,
production rollout, shared control-plane modification, or business-resource
cleanup was performed.

## Retention contract gap

Source examined: `openkruise/agents` at
[`64915f0d061df97e650f2f022a69448fc2467d13`](https://github.com/openkruise/agents/tree/64915f0d061df97e650f2f022a69448fc2467d13).
This is upstream source evidence, **not a verified source revision of the deployed
ACK images**.

- [`handlePauseTimeout`](https://github.com/openkruise/agents/blob/64915f0d061df97e650f2f022a69448fc2467d13/pkg/controller/sandbox/sandbox_controller.go#L1068)
  patches `Spec.Paused=true` and `ShutdownTime=now+retention` together. It also
  replaces `PauseTime` with that deadline. It does not wait for
  `SandboxPaused=True` before starting retention.
- [`handleShutdownTimeout`](https://github.com/openkruise/agents/blob/64915f0d061df97e650f2f022a69448fc2467d13/pkg/controller/sandbox/sandbox_controller.go#L1107)
  defers deletion for a due pause only while `!Spec.Paused`. An incomplete pause
  with `Spec.Paused=true` is not protected by this condition.
- [`ensureStopPaused`](https://github.com/openkruise/agents/blob/64915f0d061df97e650f2f022a69448fc2467d13/pkg/controller/sandbox/core/util.go#L90)
  records actual completion separately, after Pod deletion. That path does not
  re-anchor `ShutdownTime`.

Consequently, in that source a pause requested at T and completed at T+D retains
the Sandbox until T+R, giving R-D after completion instead of the required R.
The live fast pauses completed within the same recorded second, so D was not
distinguishable at the persisted timestamp resolution. They cannot resolve this
gap. Do not change the product contract to “24 hours after pause request” silently.

To unblock: establish the deployed implementation's exact retention semantics
and verify a delayed pause has a full retention period after completion. If it
matches the inspected source, the platform needs a fix and isolated requalification
outside this application-only change. No such platform change is authorized here.

## Deployment and evidence

Date: 2026-10-10 (Asia/Shanghai). JSON timestamps use UTC.

- E2B JS SDK: **2.24.0**, with this repository's existing patch.
- Gateway: **ack-sandbox-gateway:v0.3.0**.
- Manager: **ack-sandbox-manager:v0.6.11**.
- Exact running image IDs/digests are recorded in each JSON file below. Image tags
  alone do not identify the source revision.
- All resources were allocated through `Sandbox.create('auto-story-v2', ...)`
  with an exact, random `oma.dev/native-lifecycle-verification` ownership marker.
  Their CR creation timestamps can precede this run because the platform supplies
  unclaimed warm-pool resources. No existing business Sandbox was selected.
- Kubernetes access was read-only for deployment, ownership and condition evidence;
  lifecycle mutations used E2B. Control-plane `getInfo` was used without data-plane
  health checks and without automatic resume.

| Case | Observed result | Evidence |
| --- | --- | --- |
| 90-second running deadline, 60-second paused retention, verifier exits | Paused at 11:17:22Z, deadline 11:18:22Z, then platform removal and typed `SandboxNotFoundError`; no OMA renewal or cleanup controller | [Lifecycle JSON](native-sandbox-lifecycle-2026-10-10.json) |
| Connect while Running | Same ID; deadline extended from 11:20:19Z to 11:23:50Z | [Recovery JSON](native-sandbox-recovery-2026-10-10.json) |
| Shorten with `setTimeout(20_000)` | Deadline shortened to 11:19:10Z; still paused instead of killed | Recovery JSON |
| Pause during a command | `ISSUED` output retained; SDK `TimeoutError`; no reliable completion and no replay | Recovery JSON |
| Connect while Paused | Same ID resumed in 684ms with a 300-second running deadline; subsequent tool exited 0 | Recovery JSON |
| Observable side effect | Command appended once; after resume file had exactly one line | Recovery JSON |
| Nonexistent image, 10-second claim budget, 3-second readiness budget | Server rejected create in 10,305ms, before the 35-second client timeout; three failed attempts discovered by exact marker | [Readiness JSON](native-sandbox-readiness-2026-10-10.json) |
| Failed attempt cleanup | All three had finite shutdown deadlines; subsequent checks found no marked resources and typed NotFound for all recorded IDs | Readiness JSON |

`getInfo` returned `state: running/paused` but omitted `lifecycle`; no lifecycle
field was invented by the verifier. During failed creation it returned NotFound
even while a marked, reserved failed CR was still present. Do not equate that
response with complete physical cleanup of failed creates: inspect the exact
ownership marker as well.

The retained `/tmp` file is an observation of this template/runtime only. It is
not an OSS persistence test or a promise that local files, processes, memory or
command streams survive pause. Only successfully written and closed OSS Workspace
files are intended to be guaranteed by the requested policy.

All five recorded IDs are absent and all three evidence files have
`cleanupConfirmed: true`. Platform expiry performed the deletion; the cleanup
phases needed no kill calls. No replacement resources remained under the markers
at the final checks.

## Reproduction

Install the locked server dependencies (`pnpm --dir server install --frozen-lockfile`).
The script uses the configured Shanghai kubeconfig and reads the existing gateway
key without writing it into evidence. `OMA_KUBECONFIG` and `E2B_DOMAIN` can select
an explicitly authorized target. It never alters a template or controller.

Run phases **sequentially**, with one fresh evidence filename per `init` or
`init-failure`. Do not run two phases against the same file concurrently. Init
uses exclusive file creation; the initial record survives a lost create response.

```sh
node deploy/scripts/verify-native-sandbox-lifecycle.mjs init /tmp/oma-native-lifecycle.json
# Exit the verifier. Inspect around the 90s pause and after the following 60s retention.
node deploy/scripts/verify-native-sandbox-lifecycle.mjs inspect /tmp/oma-native-lifecycle.json
node deploy/scripts/verify-native-sandbox-lifecycle.mjs cleanup /tmp/oma-native-lifecycle.json

node deploy/scripts/verify-native-sandbox-lifecycle.mjs init /tmp/oma-native-recovery.json
node deploy/scripts/verify-native-sandbox-lifecycle.mjs exercise /tmp/oma-native-recovery.json
# Resume promptly, before the 60s paused retention expires.
node deploy/scripts/verify-native-sandbox-lifecycle.mjs resume /tmp/oma-native-recovery.json
node deploy/scripts/verify-native-sandbox-lifecycle.mjs cleanup /tmp/oma-native-recovery.json

node deploy/scripts/verify-native-sandbox-lifecycle.mjs init-failure /tmp/oma-native-readiness.json
# This intentionally reports a create error and exits nonzero. Always follow with cleanup.
node deploy/scripts/verify-native-sandbox-lifecycle.mjs cleanup /tmp/oma-native-readiness.json
```

Cleanup discovers lost-response resources by exact run marker and uses direct
kill only after rechecking the UID and marker. A kill acknowledgement alone is
not reported as complete deletion. If asynchronous removal is still pending,
cleanup exits nonzero; inspect or repeat cleanup until confirmed. A failed
observation is not permission to clear a resource identity.

The 60/90-second claim/readiness settings and 185-second request timeout are
experimental budgets based on the existing client/ALB budget, not a product
cold-start SLA. The failed-readiness case intentionally uses much shorter budgets.

## Still required before #217 passes

- Resolve and verify the actual-pause retention anchor, including delayed pause.
- Verify mounted OSS Workspace writes across pause, deletion and reconstruction;
  the `/tmp` command marker does not provide this evidence.
- Exercise client cancellation/disconnection during creation and observe that no
  late replacement attempts continue after cancellation.
- Distinguish injected control-plane network timeout from NotFound, and exercise
  deletion during a live command stream. The paused-command SDK timeout above is
  not a controlled network-timeout test.
- Calibrate production claim/readiness budgets using mounted cold starts. The
  measured happy creates were warm claims, not cold starts.

#218–#222 implementation and integrated acceptance are intentionally pending the
capability gate. None of their acceptance criteria are claimed as delivered.

## Local verification

- `node --check deploy/scripts/verify-native-sandbox-lifecycle.mjs`
- Sandbox package typecheck passed.
- Full Sandbox package test suite: **5 files, 107 tests passed**.
- Application behavior and database schema are unchanged; other package suites
  were not run for this evidence-only change.
