# Native Sandbox lifecycle capability gate (#217)

## Subsequent accepted contract

After this report, the user explicitly accepted the small pause-duration difference
at the 24-hour scale and authorized implementation of #218–#222. The maintained
contract is now approximately 24 hours from **pause initiation**, including pause
operation time (ADR-0019). The historical strict-gate result and all observations
below remain unchanged; they no longer block this approved implementation.

## Decision: failed retention contract; #218–#222 remain blocked

The requested policy is 24 hours running, pause on expiry, retain for 24 hours
**starting after actual pause completion**, then platform deletion; ordinary
binding idle changes the running deadline to 30 minutes. Pi stays in the Runner.
This report does not change ADR-0017 or activate the proposed policy.

An isolated delayed-pause experiment on the actual deployment demonstrated that
retention starts before pause completion and is not re-anchored afterward. With
60 seconds configured, the resource was already absent about 51 seconds after
pause completion was first observed. This fails the required full retention
period after actual pause; happy-path pause/resume support is insufficient.

#217 explicitly requires: “任一能力不满足时明确报告差异并阻塞依赖任务，不悄悄改变策略、
扩展到 Kubernetes 直接管理或新增控制器。” Consequently #218–#222 have not been
implemented. No application policy, schema or shared control plane was changed;
no production release or business-resource cleanup was performed.

## Reproduced retention failure

[Delayed-pause evidence](native-sandbox-delayed-pause-2026-10-10.json), resource
`sandbox-system--auto-story-v2-lxs86`:

1. Allocate a dedicated Sandbox with a 60-second paused-retention extension.
2. Write 512 MiB of random data to its local `/tmp`, then start a native filesystem
   snapshot through the SDK. The snapshot request specifies a 60-second TTL.
3. While that request is outstanding, shorten the Sandbox running deadline to
   one second. No Kubernetes patches, custom probes or controller were used.
4. Record control-plane state and Sandbox conditions until pause completes; exit
   and let the platform delete the resource.

| Observation time (UTC) | Actual completion condition | Scheduled deletion |
| --- | --- | --- |
| 11:39:53.342 | `SandboxPaused=False`, `WaitingForExistingCheckpoint` | 11:40:52 |
| 11:40:01.251 | Still waiting for checkpoint | 11:40:52 |
| 11:40:05.312 | `SandboxPaused=False`, `SetPause` | 11:40:52 |
| 11:40:06.698 | First observation of `SandboxPaused=True`, `PauseSucceed` | Still 11:40:52 |
| 11:40:57.745 | Resource absent; SDK typed `SandboxNotFoundError` | Already removed |

The pause request was at 11:39:52. Its 60-second retention clock ran throughout
checkpoint waiting and actual pause. At the first completion observation only
about 45 seconds remained on the deadline. Deletion was confirmed about 51
seconds after that observation, rather than a full 60-second retention period.
The observations bracket completion; they are not a precise physical freeze
or deletion timestamp. They nevertheless show that the platform never shifted
the deadline to account for the roughly 13-second pause delay.

Two other observations matter for future integration:

- `getInfo.state` was already `paused` while `SandboxPaused=False`. It represents
  a broader control-plane state, not proof of completed pause.
- The condition's `lastTransitionTime` remained **11:39:52** even after it changed
  from False to True. Use the timestamped observations to understand this run;
  subtracting that stale field from the deadline would falsely report 60 seconds.

The preceding [fast snapshot experiment](native-sandbox-pause-anchor-2026-10-10.json)
waited for snapshot creation before requesting pause. It exposed the intermediate
False condition but did not establish a multi-second pause delay. It is retained
as an exploratory run, not presented as the decisive reproduction.

## Corroborating upstream source

Source examined: `openkruise/agents` at
[`64915f0d061df97e650f2f022a69448fc2467d13`](https://github.com/openkruise/agents/tree/64915f0d061df97e650f2f022a69448fc2467d13).
This is **not a verified source revision of the deployed ACK images**. The live
reproduction above is independent of that mapping.

- [`handlePauseTimeout`](https://github.com/openkruise/agents/blob/64915f0d061df97e650f2f022a69448fc2467d13/pkg/controller/sandbox/sandbox_controller.go#L1068)
  patches `Spec.Paused=true` and `ShutdownTime=now+retention` together, without
  waiting for `SandboxPaused=True`.
- [`handleShutdownTimeout`](https://github.com/openkruise/agents/blob/64915f0d061df97e650f2f022a69448fc2467d13/pkg/controller/sandbox/sandbox_controller.go#L1107)
  defers deletion for a due pause only while `!Spec.Paused`.
- [`ensureStopPaused`](https://github.com/openkruise/agents/blob/64915f0d061df97e650f2f022a69448fc2467d13/pkg/controller/sandbox/core/util.go#L90)
  records completion separately, after Pod deletion, without re-anchoring the
  deadline. This explains the contract gap in the inspected source; the deployed
  runtime's exact implementation still needs to be identified by its maintainers.

To unblock, the platform must guarantee retention from **completed** pause,
including checkpoint-delayed pause, and pass this isolated reproduction again.
Correct completion timestamps should also be verified. Do not silently change
the product contract to “24 hours after requesting pause.” No platform fix or
shared deployment change is included or authorized by this application task.

## Deployment and successful cases

Date: 2026-10-10 (Asia/Shanghai). JSON timestamps use UTC.

- E2B JS SDK **2.24.0**, with the existing repository patch.
- Gateway **ack-sandbox-gateway:v0.3.0**; Manager **ack-sandbox-manager:v0.6.11**.
- Actual running image IDs/digests are recorded in every initialized evidence
  file; tags alone do not identify source revisions.
- Each resource came from `Sandbox.create('auto-story-v2', ...)`, with an exact
  random `oma.dev/native-lifecycle-verification` marker. CR creation timestamps
  can predate this run because the platform allocates unclaimed warm resources.
  No existing business Sandbox was selected.
- Kubernetes access was read-only for deployment/ownership/condition evidence.
  Workspace configuration was read from the Runner's environment without logging
  it. Lifecycle mutations used E2B. No data-plane health query was used to infer
  resource deletion.

| Case | Observed result | Evidence |
| --- | --- | --- |
| Verifier exits after create, 90s run / 60s paused retention | Platform pause and deletion without OMA renewal or sweeper; typed NotFound afterward | [Lifecycle](native-sandbox-lifecycle-2026-10-10.json) |
| Connect while Running | Same ID; running deadline extended | [Recovery](native-sandbox-recovery-2026-10-10.json) |
| `setTimeout(20_000)` | Deadline shortened, expiry still paused rather than killed | Recovery |
| Pause during a command | Preserved `ISSUED` output; SDK `TimeoutError`; no reliable completion and no replay | Recovery |
| Connect while Paused | Same ID resumed in 684ms with 300s deadline; tool exited 0 | Recovery |
| Observable command side effect | Appended exactly once; one line read after resume | Recovery |
| Permanently unready image: 10s claim / 3s ready budget | Create rejected in 10,305ms, before 35s client timeout; three failed attempts, all with finite cleanup | [Readiness](native-sandbox-readiness-2026-10-10.json) |
| Cancel create at 1.2s during failed readiness | Client returned in 1,207ms; one marked attempt; later check after server budget found no resource or continued replacements | [Cancellation](native-sandbox-cancellation-2026-10-10.json) |
| Inject control-plane network timeout | Local socket accepts SDK request but sends no headers; ~205ms timeout, `name=TimeoutError`, constructor `DOMException`, not NotFound | Lifecycle |
| Mounted OSS write, pause/resume and deletion/rebuild | Saved file matches through Sandbox reads and Host reads of the exact isolated OSS prefix at all three stages | [Workspace](native-sandbox-workspace-2026-10-10.json) |
| Delete during a live command | Direct kill after `ISSUED`; command returned SDK TimeoutError with retained output, no replay; getInfo returned typed NotFound | Workspace |

The network experiment used a dummy credential on localhost, not a live key.
Its first collector assertion incorrectly expected a `TimeoutError` constructor;
Node fetch actually produced a `DOMException` whose **name** was `TimeoutError`.
The failed assertion and corrected repeat are both preserved. This distinction
must not be flattened into NotFound by future integration.

During failed creation `getInfo` returned NotFound while reserved failed CRs were
still visible under the exact marker. Thus that response alone does not prove
physical cleanup of failed creates. Lifecycle confirmation checks both surfaces.
`getInfo` omitted the optional `lifecycle` field; the verifier did not invent it.

The Workspace case used only the unique
`native-lifecycle-verification/<runId>/saved.txt` object. It is the OSS evidence;
the recovery case's `/tmp` file is only an observed side-effect marker. Neither
case promises preservation of processes, memory, local dependencies or command
streams. Only successfully written and closed OSS files are guaranteed by the
requested product policy.

## Cleanup

All **10 Sandbox IDs**, both explicitly requested snapshots, and the isolated OSS
object have been removed. Every evidence file has `cleanupConfirmed: true`;
Workspace evidence additionally has `workspaceCleanupConfirmed: true`, and the
two snapshot cases have `snapshotCleanupConfirmed: true`. Final reads found no
marked replacements or associated Checkpoint CRs.

The ordinary and delayed-pause resources expired through native platform policy.
The Workspace replacement was explicitly killed during the deletion-stream test.
Snapshot deletion used the exact IDs returned by our SDK requests; the final
script also handles a lost snapshot response by listing only its recorded test
source Sandbox. No arbitrary templates or business resources are deleted.

## Reproduction

Install server dependencies with `pnpm --dir server install --frozen-lockfile`.
The script reads the Shanghai kubeconfig and gateway key without putting secrets
in evidence. `OMA_KUBECONFIG`/`E2B_DOMAIN` can select an explicitly authorized
compatible target; Workspace phases additionally use that cluster's Runner
storage configuration. Run phases **sequentially** for each evidence file, with
one fresh filename per init. Init refuses to overwrite existing evidence.

```sh
node deploy/scripts/verify-native-sandbox-lifecycle.mjs init /tmp/lifecycle.json
# Wait for 90s running + 60s retention, inspecting around each boundary.
node deploy/scripts/verify-native-sandbox-lifecycle.mjs inspect /tmp/lifecycle.json
node deploy/scripts/verify-native-sandbox-lifecycle.mjs cleanup /tmp/lifecycle.json
node deploy/scripts/verify-native-sandbox-lifecycle.mjs network-timeout /tmp/lifecycle.json

node deploy/scripts/verify-native-sandbox-lifecycle.mjs init /tmp/recovery.json
node deploy/scripts/verify-native-sandbox-lifecycle.mjs exercise /tmp/recovery.json
# Resume promptly, before the 60s paused retention expires.
node deploy/scripts/verify-native-sandbox-lifecycle.mjs resume /tmp/recovery.json
node deploy/scripts/verify-native-sandbox-lifecycle.mjs cleanup /tmp/recovery.json

node deploy/scripts/verify-native-sandbox-lifecycle.mjs init-failure /tmp/readiness.json
node deploy/scripts/verify-native-sandbox-lifecycle.mjs cleanup /tmp/readiness.json
node deploy/scripts/verify-native-sandbox-lifecycle.mjs init-cancel /tmp/cancellation.json
# Observe beyond the 10s server claim budget, then clean up.
node deploy/scripts/verify-native-sandbox-lifecycle.mjs inspect /tmp/cancellation.json
node deploy/scripts/verify-native-sandbox-lifecycle.mjs cleanup /tmp/cancellation.json

node deploy/scripts/verify-native-sandbox-lifecycle.mjs init /tmp/delayed-pause.json
node deploy/scripts/verify-native-sandbox-lifecycle.mjs delay-pause /tmp/delayed-pause.json
# Inspect after the deadline to observe platform deletion before explicit cleanup.
node deploy/scripts/verify-native-sandbox-lifecycle.mjs inspect /tmp/delayed-pause.json
node deploy/scripts/verify-native-sandbox-lifecycle.mjs cleanup /tmp/delayed-pause.json
```

`init-failure`/`init-cancel` intentionally exit nonzero; always clean up afterward.
The snapshot overlap is bounded, creates local test data, and does not renew the
resource. Cleanup uses direct kill with marker/UID verification and reports
incomplete until resource absence is confirmed. Repeat cleanup when asynchronous
removal is still pending; an acknowledgement alone is not successful deletion.

Workspace phases must use `tsx` to import the actual mount and OSS Store contracts:

```sh
pnpm --dir server --filter @oma-server/api exec tsx ../../../deploy/scripts/verify-native-sandbox-lifecycle.mjs init-workspace /tmp/workspace.json
# Wait for Paused, but not the end of retention.
pnpm --dir server --filter @oma-server/api exec tsx ../../../deploy/scripts/verify-native-sandbox-lifecycle.mjs resume-workspace /tmp/workspace.json
# Wait for native deletion; rebuild refuses while the previous resource still exists.
pnpm --dir server --filter @oma-server/api exec tsx ../../../deploy/scripts/verify-native-sandbox-lifecycle.mjs rebuild-workspace /tmp/workspace.json
pnpm --dir server --filter @oma-server/api exec tsx ../../../deploy/scripts/verify-native-sandbox-lifecycle.mjs delete-command /tmp/workspace.json
pnpm --dir server --filter @oma-server/api exec tsx ../../../deploy/scripts/verify-native-sandbox-lifecycle.mjs cleanup /tmp/workspace.json
```

The first live rebuild invocation was intentionally refused because deletion had
not yet completed; a later attempt succeeded. Both are retained in the evidence.
Scripts collect facts; a zero exit from an observation is **not** a pass for the
entire #217 gate. Evaluate the recorded behavior against the issue contract.

## Remaining qualification after the platform fix

The 185s client budget comes from the existing ALB/client configuration. Warm
creates measured 307–907ms; mounted creates/rebuilds were also warm. Experimental
60/90s or mounted 150/150s claim/readiness budgets are not a cold-start SLA. Once
the retention defect is fixed, calibrate with actual mounted cold starts and
repeat this gate before enabling #218–#222. This run does not certify 24-hour
production behavior merely by extrapolating these shortened tests.

## Local verification

- `node --check deploy/scripts/verify-native-sandbox-lifecycle.mjs` passed.
- Sandbox package typecheck passed.
- Full Sandbox package test suite: **5 files, 107 tests passed**.
- Evidence JSON parsed and cleanup flags checked. No application behavior or
  schema changed; other package suites were not run for this verification change.

## Standards review

Final standards review (`d3a907d..58969ef`): **no hard standards violations or
 actionable smells found**.

- Ownership remains scoped to random run markers, recorded Sandbox identities,
  source-filtered snapshot listings, and the isolated OSS object. Cleanup verifies
  absence rather than treating a delete acknowledgement as completion.
- SDK and Kubernetes requests have finite budgets; snapshot pagination and
  observation loops are bounded. Command failures retain uncertainty without
  replaying side effects.
- Credentials are not persisted in evidence; localhost fault injection uses a
  dummy key. Workspace verification reuses repository mount/storage contracts.
- The delayed-pause JSON supports the revised retention finding: completion
  remained false through 11:40:05, became true by 11:40:06, and deletion was
  confirmed at 11:40:57. The unchanged 11:40:52 deadline therefore cannot supply
  60 seconds after completion. The report appropriately distinguishes observation
  times from physical transition timestamps.
- All seven evidence files confirm Sandbox cleanup, totaling ten IDs; both snapshot
  cases and the Workspace object have their additional cleanup confirmations.
- The report explicitly preserves ADR-0017 and blocks dependent implementation
  rather than silently changing policy.

Possible smells: none worth raising. The expanded script still serves one bounded
qualification workflow; phase branching alone does not justify abstraction or
splitting.

## Spec review

**No actionable findings for the negative capability-gate delivery.**

(a) Missing/partial requirements: Cold-start budget calibration remains incomplete
against “具体时间依据现有请求/网关预算及冷启动观测确定.” The report explicitly identifies
warm claims and defers calibration until platform correction; it does not promote
experimental budgets into product guarantees. #218–#222 remain unimplemented,
appropriately following “任一能力不满足时明确报告差异并阻塞依赖任务.” They must not be
marked completed.

(b) Scope creep: None. Snapshot overlap supplies an isolated delayed-pause
reproduction for “从实际暂停起计算保留期并删除.” It introduces no application controller,
policy workaround, or shared control-plane modification.

(c) Incorrect implementation / overclaim: None requiring changes. The deployed
evidence independently supports the negative result: pause remained incomplete
through the observation at 11:40:05.312; completion was first observed at
11:40:06.698; the unchanged deletion deadline was 11:40:52; absence was confirmed
at 11:40:57.745. Even allowing the observation bracket, the configured 60-second
completed-pause retention was not provided. The report appropriately warns that
observations are not exact physical timestamps and that the condition timestamp
is stale.

The former independent evidence gaps are addressed: actual mounted OSS persistence
includes host reads after resume and reconstruction; cancellation has post-budget
observations; network timeout uses a real nonresponding local socket; deletion
during a command retains partial output without replay. Cleanup covers the
additional Sandbox, snapshot, and OSS resources.

Review summary: Standards 0 actionable findings; Spec 0 actionable findings for
this negative gate. Qualification remains failed pending platform correction and
requalification; #218–#222 are not delivered.
