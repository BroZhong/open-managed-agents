# Pi public SDK release verification — 2026-09-21

Host/Web source image revision: `b597846f3abc` (includes current main).
Sandbox Node compatibility and additive release recipe: `be53d46`.
PR: [#164](https://github.com/BroZhong/open-managed-agents/pull/164).

## Local verification

- Adapter: **409 passed** across 33 files.
- Server: **871 passed**, 8 existing opt-in external tests skipped.
- Web: **372 passed** across 50 files; production build passed.
- Adapter and Server typechecks passed; two deployment contract checks passed.
- Standards and Spec reviews: no unresolved findings after fixes.

The actual unmodified Pi 0.83.0 SDK runs on both sides of tool comparisons.
Coverage includes binary/image bytes, UTF-8, BOM/CRLF, symlinks, file URLs,
at-prefixed filenames, Unicode-space lock aliases, search semantics and limits,
large-output storage, and native timeout/cancellation output. A real process test
cancels Bash before a delayed write and checks that the file never appears.
Boundary tests forbid Host fs/process calls for all seven tools and renderers.

Context tests cover native threshold/overflow compaction and retry requests,
failed persistence, replay in another process, repeated equal summaries, and
continuation plus steering followed by another compaction. Public awaited Agent
listeners detach transport markers before steering; these markers do not become
native compaction turn boundaries or broken persisted parent chains.

## Release and live verification

### Images and compatibility

Host and Web images use tag `b597846f3abc`. Sandbox image:

`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:8ec76b3feb5978abeaf2711511d609b26225218b9ef421ce39d78cfdfc1bcf47`

The live sandbox had diverged from the repository's clean recipe: it ran 0.3.0
with offline Whisper. The test release preserves that exact parent digest
`4595630a998eec424ca73c3d2842797177ac94459345d4c1f42c971d0ad30f1f`
using `sandbox/auto-story-v2/pi-tools/Dockerfile.overlay`. It adds the committed
Pi npm lockfile and Host's Node 22.23.2 binary. The initial Node 20 image failed
Pi import (`webidl.util.markAsUncloneable`); the pinned Node 22 image passes.
The clean recipe also now pins Node 22, but a complete clean-image rebuild is
not the image used for this live test.

Reproduce on the Shanghai builder from the repository root:

```sh
docker buildx build --platform linux/amd64 --load \
  -f sandbox/auto-story-v2/pi-tools/Dockerfile.overlay \
  -t registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:auto-story-v2-pi-b597846f3abc \
  sandbox/auto-story-v2/pi-tools
bash sandbox/auto-story-v2/verify-image.sh \
  registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:auto-story-v2-pi-b597846f3abc
```

- Seven native Pi tool smoke checks passed as the ordinary sandbox user.
- Inherited media tools, offline Whisper and network-disabled acceptance passed.
- Inherited ACS Jupyter startup and health passed.
- A newly provisioned Kubernetes sandbox independently reports Node 22.23.2,
  Pi 0.83.0 and all seven native tool smoke checks passing.
- SandboxSet image was updated with a guarded image-only JSON patch after a
  server-side dry run, preserving live replica count and all other settings.
  Full-manifest apply would have overwritten unrelated live configuration.

### Deployment

`deploy/scripts/deploy-app.sh --tag b597846f3abc --apply --confirm-production`
completed both image-only rollouts after server-side validation. Public
`/api/health` returned `{"status":"ok"}`. There were no running/waiting Sessions
before rollout. The SandboxSet retains two warm replicas; both updated replicas
are available. The authenticated console loads the continued Session.

### Real-provider isolated compaction

A separate process in the deployed Host used the production Adapter and real
`deepseek/deepseek-flash` provider with synthetic history and an isolated Pi
profile (8192 context window, 1024 reserve, 512 recent tokens). Seed usage was
artificially high to trigger the threshold; production model configuration and
the requested Session were unchanged. Tool I/O was disabled in the fixture.

- First turn emitted exactly `started/threshold`, then `completed/threshold`.
- One native compaction entry passed the persistence callback and was written
  to an fsync'ed temporary journal before continuation.
- Restoring that journal reproduced the native context.
- The next Adapter turn returned the retained test codename, with no duplicate
  compaction and no tool attempts.

This exercises the real provider and production Adapter hooks; it is distinct
from a naturally triggered compaction in the requested long Session.

### Background Bash investigation

The live Agent once reported a missing background review log. Its command
backgrounded the entire `checksum && probe && nohup ...` list. Direct native Pi
and the Adapter's local bridge reproduce the same failure when the preflight
writes after the outer shell exits and Pi closes the idle output pipes. `&&`
then prevents reaching `nohup`; this is not evidence of a lost running job.

The production Sandbox transport independently confirmed that a correctly
redirected standalone `nohup` survives tool completion and writes a delayed
marker. The whole-list background variant fails identically. The Agent recovered
by executing the review in the foreground. No SDK or shell patch was introduced.

### Live Session

The first continuation exercised 59 tools over approximately 28 minutes. The
media reviewer kept requesting additional creative revisions, so the verification
was explicitly bounded: the running Bash polling wait was interrupted through
the normal API, then a finalization prompt requested completion of already-started
work, audio review, at most one final video review, and honest remaining issues
without starting further generation.

The interrupt produced a durable `session.turn_aborted`, an interrupted-tool recovery result,
and idle state. A separate process restored all 1741 stored events into 663 native
entries with no broken parent chains. The finalization Turn completed and the Session returned to idle at event 1882
(2026-09-20 17:39:11 UTC / September 21 01:39 China time).

Across both Turns:

- **79 tool calls and 79 results**: 52 Bash, 25 Read (including images), 1 Edit,
  1 Write. No `session.error`, runtime version mismatch or bridge-protocol failure.
- Three error results were accounted for: a process-absence `grep` exit code,
  the deliberate interrupt recovery, and an Agent-authored Python syntax error
  that the Agent corrected on its next attempt. They were not hidden as success.
- Fresh-process replay of **1882 events** produced **704 native entries** and
  703 context messages without identity or parent-chain errors.
- Maximum observed input was **356,495 tokens**, below the configured 1,000,000
  context window; no automatic compaction was naturally triggered in this Session.
  The isolated real-provider test above covers the actual compact/restore path.
- Audio and final native Agentic video review artifacts exist. The final film
  exists (40,549,231 bytes), and its SHA-256 matches `delivery.json`.
- Business delivery is explicitly **partial with review completed**: four open
  media review items remain, and are preserved in the delivery/review records.
  Platform validation does not claim that the film passed all creative checks.

Raw Session history, prompts, media, credentials and review reports are omitted
from this repository; this record contains aggregate verification evidence only.
