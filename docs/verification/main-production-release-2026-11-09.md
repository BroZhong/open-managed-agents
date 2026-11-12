# main → production · 2026-11-09

All times below are Asia/Shanghai. The user explicitly requested promotion of the latest main from oma-test to production, regression and load testing, and a production Runner minimum of **1**. This changes ADR-0026’s original production minimum of 2.

## Release

- Application source: `3a1e0100aa59e918cf6e1c7f54e914101f49990a` (main, PR #350). The prior test image’s source, `3abee518614a9eddb47decc6ae9985b15004ea47`, has an identical tree. New images were built from a clean checkout of main on `vfs-dev`, tag `202611092153`; both OCI revision labels identify the full main SHA.
- Server (API, Runner, Builder): `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:a44550a793fc3ebd75807ca9efa1ecd8867a0800d26a279c23a71913c3c81483`.
- Web: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web@sha256:de9719215a93835568100d9119acbcc9df24b9f95b3448239398cfb3539044e8`.
- Cluster: `agent-platform`, explicit `~/.kube/agent-platform-config`; test `oma-test`, production `oma-infra`.
- Test received the rendered overlay after reviewing the diff (images only). Production used image-preconditioned patches to the four actual split Deployments. The legacy `oma-server` Deployment remained at zero; its Service still selects `oma-api`.
- Production Runner configuration: `RUNNER_CAPACITY=50`, `SHUTDOWN_GRACE_MS=2700000`, termination grace 2760 seconds, Pod-name claim owners, rolling `maxSurge=25%`, `maxUnavailable=0`. Existing production 2 CPU / 8 GiB, 6 GiB heap and PG pool 30 were retained. Test remains 1 CPU / 4 GiB.
- Production KEDA: authenticated internal demand endpoint; target 40; bounds **1–50**; at most +10 Pods / 15 seconds; 600-second downscale stabilization, at most −2 Pods / minute. Fallback retains the current count (at least 1). A new demand Secret was created without exposing its value. The replica field was removed from the Deployment’s last-applied configuration without changing its running count. The source overlay also relinquishes replica ownership.
- Scale-in was paused during deployment/regression, retaining five Runners, then resumed. No fixed-replica pause remains in the accepted state.
- Builder was released before Runner. Production’s built-in Environment remained ready, with the same init-script hash as test; no rebuild was needed. Base Images and Warm Pool configuration were not changed.
- After all previous Runners had disappeared, migration `0031_drop_delegation_lock.sql` was applied through the existing Supabase admin connection, with a five-second lock timeout. Verification at 22:07:52 returned `to_regclass('oma.delegation_lock') = NULL`. The removed table contained one coordination row. No Session/Event data was removed by the migration.

## Automated verification

| Check | Result |
|---|---|
| Server workspace suite | 3,234 passed; 131 optional/integration tests skipped |
| Real local PostgreSQL store suite | 346 passed; 3 skipped |
| Real PostgreSQL competing Runner claims and Sandbox sweeper | 18 passed |
| Adapter suite | 438 passed initially; the 24 native-search tests then passed with the Sandbox’s pinned `fd` 10.4.2 |
| Web | 528 passed; production build passed |
| API and Adapter TypeScript | Passed |
| Deployment contract/render tests | 49 passed; 1 skipped |

The native-search suite first could not find `fd`. Ubuntu’s older `fd` 8.3.1 then failed four cases because it lacks the required flags/directory semantics. The final rerun used the binary from the existing pinned OMA Base Image and passed all 24 cases; application code was not changed to accommodate the build host.

## Live regression

The same verification workflow ran with `deepseek/deepseek-flash` in fresh isolated tenants in both environments. Production passed **26 assertions**: authenticated input, ordered SSE history and live deltas, reconnect without duplicates, real model and bash, persisted Workspace file reads, Interrupt with preserved queued input, late Interrupt, synchronous and asynchronous Child Sessions and result consumption, manual Loop cadence, idle and active termination, and durable cleanup. The production basic/SSE phase used the public HTTPS API; later phases used the in-cluster API.

Test’s first active-termination probe terminated while Sandbox creation was still pending. Its old 180-second verifier timeout expired, while the system correctly waited for its 180-second creation intent and exponential cleanup backoff. The intent created at 21:57:57 was naturally cleared at 22:03:32 on attempt 7: no Sandbox pointer, no creation intent, `reclaiming=false`, cleanup completed. The test phase was rerun with a ten-minute cleanup budget and passed. That verifier budget and an optional `VERIFY_MODEL` override are included in this change. The first timeout is retained as a verification-harness limitation, not erased as an initial pass.

Public production smoke covered HTML, both referenced JS/CSS assets, `/api/health`, `/api/ready` and the OpenAPI 3.1 document. All returned 200 with expected types/content. A separate public health burst (200 requests, concurrency 20) succeeded 200/200: p50 99.9 ms, p95 205.8 ms, max 253.0 ms. These timings include the operator’s public network path.

## Load test

Five production waves used separate disposable tenants and `deepseek/deepseek-flash`: 650 text Turns and 500 Sandbox Turns, **1,150/1,150 successful**. Each Session had its own Workspace. Session creation concurrency was 30; first-input submission concurrency was 100 (the 400-input bursts completed in under 0.6 seconds). A text task requested 100 numbered lines and a completion marker; a Sandbox task called bash exactly once with `sleep 20; printf RELEASE_CAP_OK`. Validation required one completed Turn, a normal final model stop, the marker, no Session error/abort, and the expected number of successful tools. It did not separately assert the count of generated text lines.

All 500 bash calls succeeded exactly once. All 1,150 Sessions had zero failed model attempts. The requested thinking setting was `off`, but all persisted context-start events report **minimal**, the existing #346 behavior; these measurements describe that actual setting.

| Scenario | Submitted / successful | Create burst | Accept p95 | Last completion after final acceptance | Model errors/retries |
|---|---:|---:|---:|---:|---:|
| text 50 | 50 / 50 | 0.114 s | 161 ms | 14.06 s | 0 |
| text 200 | 200 / 200 | 0.445 s | 345 ms | 10.06 s | 0 |
| text 400 | 400 / 400 | 0.698 s | 179 ms | 20.18 s | 0 |
| bash 100 | 100 / 100 | 0.324 s | 135 ms | 156.63 s | 0 |
| bash 400 | 400 / 400 | 0.781 s | 217 ms | 199.50 s | 0 |

The text waves completed quickly enough that the HPA never needed to add Runners. The 400-Sandbox wave sustained demand long enough to trigger **5 → 10** through the demand metric; all ten were Ready in the 22:15:47 sample, and newly added Runners claimed work. The largest observed claim count per Runner was 50. No manual replica scaling was used.

Sandbox preparation: 100/100 and 400/400 outcomes were `ready`. For 100, p50/p95/max were 37.14/40.54/125.84 seconds; for 400, 37.49/55.10/132.17 seconds. These durations include Sandbox preparation, not the subsequent 20-second command. This run establishes the tested 400-Session burst behavior; it does not certify 2,000 simultaneous production Sessions or long-term soak capacity.


## Observation and cleanup

The HPA naturally reduced the fleet **10 → 8 → 6 → 4 → 2 → 1**, one step per minute after stabilization. Samples first recorded these counts at 22:25:45, 22:26:48, 22:27:41, 22:28:45 and 22:29:48 respectively (samples are approximately 10 seconds apart). Final production API, Runner, Web and Builder were each **1/1 Ready**; the ScaledObject was Ready, unpaused, minimum 1 / maximum 50, with demand 0. Test naturally returned to its existing zero-Runner idle policy. A server-side dry-run also verified that a later full overlay apply preserves the controller-owned Runner count.

The monitor sampled production readiness and API/Runner logs, Kubernetes state, and the shared RDS/NAT metrics throughout the load and cooldown. The highest returned one-minute RDS averages were **4.356% CPU** and **4.845% connection usage**; the highest returned NAT egress point was **2.82 Mbps**, below the configured abort limits (70%, 70%, 170 Mbps). Cloud metrics arrive with delay; monitoring continued after load completion. No API/Runner restart, public readiness failure or critical database/connection-error guard occurred. Application-role database sampling saw zero transactions older than 30 seconds and a maximum of one instantaneous lock waiter; this is not evidence that no brief lock contention occurred.

**Infrastructure warnings were present despite successful Turns.** Matching persisted Sandbox IDs to Kubernetes events attributes **218 `Throttling.Api` events across 86 Sandboxes** to the 400-Sandbox wave. All report cloud API flow-control rejection. Three other matched Sandbox event entries report `BackOff` of the `agent-runtime` init container (one Sandbox in the 100 wave, two in the 400 wave; aggregated Event counts sum to 45, not a measured restart count). All three eventually returned `ready` and executed their command successfully; their preparation delays account for the observed long tail. The deleted Pods’ failed init-container logs were not preserved, so the underlying restart cause remains undetermined. These control-plane/startup warnings prevent describing the run as warning-free or extrapolating its result to larger bursts. Related control-plane work is tracked in #349.

The application namespace also recorded six readiness `host unreachable` warnings for old API/Web/Runner Pods during replacement. New application Pods had zero restarts. The full current application log audit found one expected `Pending event claim lost` on the regression Session explicitly terminated while running; the remaining matches were successful sweeper summaries (`failed=0`). No such claim-loss entry was attributed to a load-test Session.

All production verification and load Sessions were terminated through the API. Their temporary Workspaces, Agents and verification Loop were deleted; API keys were revoked and old-key requests returned 401. Database audits show no pending input, active test key or retained Sandbox binding for the five load tenants. The production Warm Pool returned to its configured eight unclaimed instances. Test fixtures were likewise cleaned; both temporary verifier Pods were deleted. Terminated event histories remain for audit.

Structured evidence: [main-production-release-2026-11-09.json](main-production-release-2026-11-09.json). The JSON includes release identities, regression checks, all load Session IDs, latency summaries, Sandbox IDs/timings, matched warning events and sampled scaling transitions.


## Rollback

Previous image digests:

| Deployment | Previous digest (same `welltop/oma-server` or `oma-web` repository) |
|---|---|
| API / Runner | `sha256:de1332f9f2f6a82178c0f9785816dace4b9f102e39b656cee1e3e92337d5e34e` |
| Builder | `sha256:6aecfe605d75cb7695849593cfe3096af1c86451282cbf95f45033b16ef2d0cd` |
| Web | `sha256:8bd59a95685fa96b7cfa81ec502bb1701d2e6066eb8b5766c172c103802546b8` |

For application rollback, restore `deploy/migrations/0031_drop_delegation_lock.rollback.sql` **before starting any previous Runner image**. It recreates the coordination row and its SELECT/UPDATE grant. The newer image ignores this table. Hold autoscaling at the required count through the ScaledObject, then roll back the relevant image fields and verify readiness and in-flight work. Saved Deployment/ConfigMap snapshots also retain the previous configuration.

To revert autoscaling, delete the production ScaledObject and TriggerAuthentication; the Deployment retains its count at deletion. Restore an explicit replica count in the production overlay before later full applies. The demand Secret may remain inert. Do not restore the old 30-second termination grace while new long-running Turns are still draining.

Full raw operator evidence is in `/tmp/oma-production-release-20261109/`; the accompanying JSON records durable release and test results without credentials.
