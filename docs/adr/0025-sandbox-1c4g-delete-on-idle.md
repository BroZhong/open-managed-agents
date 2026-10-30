# ADR-0025: Sandboxes run on 1 vCPU and are deleted, never paused, 15 minutes after their last use

## Status

Accepted 2026-10-30: decided by the maintainer from production measurements
taken 2026-10-26..29 (read-only: PG schema `oma`, ARMS Prometheus,
CloudMonitor, the agent-platform cluster).

Supersedes [ADR-0019](0019-native-sandbox-lifecycle.md)'s expiry policy: pause
on expiry, about 24 hours of paused retention, a 30-minute idle deadline, and
resuming a Paused Sandbox. Revises [ADR-0023](0023-sandbox-binding-reconciliation.md)'s
reconciliation order ("a running one, else the earliest claimed") and its
sweeper's `paused` keep class, and [ADR-0024](0024-environments.md)'s Warm
Pool template (2 vCPU, 50 GiB ephemeral storage, `persistentContents:
[filesystem]`). Everything else in those ADRs stands: the 24-hour running
deadline set at create and at each Turn's connect, the shortening after the
binding's last use settles, binding reconciliation, the sweeper, the shared
Warm Pool and its in-place image swap.

## Context

Preparing a Turn's Sandbox, `span.sandbox_prepare_end`, production 10-26..29:

| Path | p50 | p90 | n |
|---|---|---|---|
| Connect to a running Sandbox | 0.25 s | — | 1,667 |
| Warm claim | 0.54 s | 0.79 s | 992 |
| Cold create | 38.1 s | — | 192 (all inside dispatch bursts) |
| Resume a Paused Sandbox | 37.3 s | 38.7 s | 160 |

Resuming is no faster than a cold create and 70 times slower than a warm claim.
The 2026-10-10 verification measured 0.7–0.8 s to resume; why production now
takes 37 s is unexplained and no longer matters. A Paused Sandbox keeps only its
root filesystem; the Workspace is on OSS either way.

Pausing is not free. On pause the gateway deletes the Pod
(`SandboxPaused reason=DeletePod`) but keeps the ACS instance
(`recover-from-instance-id`): on 10-29 the quota centre counted 929 of 2,000
vCPU, of which 852 were 426 Paused Sandboxes. ACS bills a hibernated Pod for
all of its ephemeral storage, ¥0.0021/GiB·h with no free tier: about ¥2.5 a day
for each Paused 50 GiB Sandbox. At list prices a Sandbox cost about ¥3.26
(1.76 h running ≈ ¥0.68, 24.6 h paused ≈ ¥2.58), about ¥810 for a 60-episode
drama.

Idle gaps: of 5,021 Turns that followed an idle period, 204 came after more
than 10 minutes, 195 after more than 15 and 185 after more than 30. Halving the
idle deadline sends about ten more Turns to a fresh claim. Only 2 of 4,840
waits for a Child Session (waiting → running) exceeded 15 minutes. Follow-ups
after 2–6 hours re-send a step prompt; those after 6–24 hours are reworks and
web users.

Peak use per Sandbox, 15 days of ARMS, `container="sandbox"`:

- CPU, 2-minute average, p99: 0.63–0.97 core in steps 3–5; 1.67 in step 6
  (Finalcut).
- Memory p99: 0.59–0.77 GiB in steps 3–5; 1.46 GiB in step 6, at most 2.11.
  ffmpeg has run out of 4 GiB before, so memory stays at 4 GiB.
- Writable layer p99 0.59 GiB, at most 5.7 GiB.
- At 1 core, the CPU time above one core per Finalcut, at 15-second
  resolution, was p50 1.4 min, p90 2.6 min, at most 4.5 min, against an
  11-minute p50 active time: roughly 10–25 % slower. CSI sidecar CPU is not in
  `container="sandbox"`. Bash commands (10-28, 8,520) had p99 121 s and a
  longest of 15 min, well inside the 40-minute bash timeout at half speed.

## Decision

**Resources.** Both Warm Pools (`oma-sandbox`, `oma-test-sandbox`) request and
limit 1 vCPU and 4 GiB, with 15 GiB of ephemeral storage (ACS's minimum, free
while running). Requests equal limits: ACS bills the larger of the two, so a
1-core request under a 2-core limit is billed as 2 cores. The template has no
`persistentContents`: nothing is paused. The pool keeps 8 replicas and no
PoolAutoscaler. Every Environment runs on these resources.

**Lifecycle.** Create asks the gateway to delete the Sandbox at its deadline
(`lifecycle: { onTimeout: 'kill' }`, no `reserve-paused-sandbox-duration`).
Create and each Turn's connect set the deadline to 24 hours, as before. When
the binding's last use settles and no input is queued, the deadline is
shortened to 15 minutes (`SANDBOX_IDLE_SECONDS`), by the Turn's release or by
the sweeper. At the deadline the gateway deletes the Sandbox and its ACS
instance. The next Turn's connect finds it missing, the binding goes Cold, and
the first tool call claims a new Sandbox from the Warm Pool (the prepare span
ends `deferred`, then a claim).

**OMA has no Paused state.** Nothing in OMA pauses a Sandbox, so:

- the gateway list is asked for running Sandboxes only, and an entry in any
  other state is dropped;
- `state()` answers running or missing; any other state is an unknown
  control-plane state and throws, like a transport error;
- reconciliation, ensure's and the sweeper's alike, keeps the earliest claimed
  Sandbox (then the lowest id) and kills the others;
- the sweeper has no `paused` keep class; its kill cap takes Sandboxes without
  a deadline first, then the earliest claimed.

The invariant matters beyond the code it removes: upstream kruise keeps a
Paused Sandbox without `reserve-paused-sandbox-duration` forever, and OMA's
listing would not see it. The operator report
(`server/packages/api/src/sandbox-sweep-report.ts`) still asks for paused ones
and counts any it finds.

The model's Workspace instructions say the Sandbox "can disappear independently
of this Turn, and a later Turn may get a new one"; they no longer mention
pausing.

## Consequences

- Anything outside the Workspace (local dependencies, caches, `/tmp`, the
  installed Skill Set) survives 15 minutes between Turns instead of about a day.
  A new Sandbox installs the Skill Set again, beside the model's first request
  (ADR-0022).
- A late idle deadline write (ADR-0019, "Database ordering is not remote
  fencing") now deletes the new Turn's Sandbox instead of pausing it. Recovery
  is the same: the operation is reported as unconfirmed and not replayed, the
  binding goes Cold once the Sandbox is confirmed missing, and the next tool
  claims a new one. Local state is lost. Accepted as before; it needs a
  30-second-timed-out deadline write to land after the next Turn's connect.
- A Turn still running 24 hours after its connect loses its Sandbox in the same
  way. A Sandbox whose Runner was lost mid-Turn stays in use, and runs to its
  24-hour deadline, as before; it is then deleted rather than paused.
- Finalcut is expected to run 10–25 % slower, more if the CSI sidecar competes
  for the core. The maintainer's acceptance line is no OOM and no crash; the
  duration is recorded, not gated.
- Every Turn after a 15-minute gap draws from the Warm Pool instead of resuming.
  The 160 resumes in the sample become claims (0.5 s instead of 37 s when the
  pool has a Sandbox ready, a cold create when it does not, as before).
- Estimated at list prices (not reconciled with a bill): about ¥0.41 per
  Sandbox with 15 GiB, about ¥100–130 per 60-episode drama, down from ¥810. A
  Sandbox idle for more than 15 minutes holds no quota.

## Rollout

- The pool template is patched on the live SandboxSets:
  `spec.template.spec.containers[0].resources` and `spec.persistentContents`
  only, never the whole manifest (the image builder owns the image). The patch
  rolls the pool's unclaimed Pods, 20 % at a time; a claimed Sandbox keeps its
  resources until it is deleted. Reverting is the opposite patch.
- The Runner and the image builder both create Sandboxes through
  `E2BSandboxClient`: the release replaces the `oma-server` image of every
  Deployment that runs it (oma-api, oma-runner, oma-image-builder).
- A Sandbox created before the release keeps the policy it was created with
  and would pause again after its next Turn. The policy is on its Sandbox CR:
  a pausing Sandbox has `spec.pauseTime`, a deleting one only
  `spec.shutdownTime`. (The gateway writes
  `agents.kruise.io/reserve-paused-sandbox-duration: forever` on every claimed
  Sandbox it was not given one for, so that annotation is no marker.) Before
  the release, list the claimed Sandboxes with `spec.pauseTime`; kill idle ones
  by id (their bindings go Cold on the next Turn's connect) and let a Turn in
  progress finish first. On 2026-10-30 at 08:13Z production had 5 Paused
  Sandboxes, all deleted by 10:36Z, and no claimed running one.
- oma-test acceptance: one full episode, steps 3–6 with Finalcut, at
  1 vCPU/4 GiB, with a gap of more than 15 minutes before Finalcut so that it
  runs on a new claim; `alibabacloud.com/pod-use-spec` on the claimed Pod; the
  Sandbox deleted 15 minutes after the Turn, not Paused, and its quota
  released; the next Turn `deferred`, then a warm claim; an image-builder
  verification Sandbox deleted at its deadline; sweeper lines without
  unexpected kills.
