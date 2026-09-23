# Sandbox lifecycle verification — 2026-09-22

Scope: #172–#176 / ADR-0017. All changed cloud resources are isolated verification
resources. No production Host deployment, gateway configuration, user Sandbox
deadline or global reclamation policy was changed.

## Deployment and gateway facts

- Shanghai `agent-platform`, explicit `~/.kube/agent-platform-config`.
- `sandbox-system/sandbox-gateway`: ACK gateway v0.3.0.
- `sandbox-system/sandbox-manager`: ACK manager v0.6.11; configured finite
  timeout ceiling `--e2b-max-timeout=3155760000` seconds. This configuration is
  not used as a substitute for no expiry.
- Repository E2B JS SDK: 2.24.0.
- New isolated E2B creation with `e2b.agents.kruise.io/never-timeout=true` and a
  60-second control timeout produced **no** `spec.shutdownTime`.
- Creation with `timeoutMs=0` produced a deadline about five minutes later.
  Creation with `timeoutMs=60000` produced a one-minute deadline. Both controls
  ran commands with command `timeoutMs=0`, separating command and Sandbox expiry.
- An isolated existing finite-lifetime Sandbox was patched with a UID test and
  removal of `spec.shutdownTime`. Its UID stayed unchanged, its original command
  remained alive and E2B reconnect left the deadline absent.
- A bounded command call timed out while that Sandbox remained running. A
  transport timeout alone is not an assertion that the remote process exited.

These are observed deployment behaviors, not assumptions from SDK comments.
The [upstream extension documentation](https://openkruise.io/kruiseagents/user-manuals/sandbox-claim)
and [v0.2 release notes](https://github.com/openkruise/agents/releases/tag/v0.2.0)
describe the creation mechanism; the deployed controller and SDK were tested
separately. The annotation is consumed during creation, so merely adding it to an
existing Sandbox is not the verified adoption method.

## Automated validation

Real PostgreSQL tests use a disposable Pod, reached only through a local
port-forward, and an isolated schema. The lifecycle suite verifies:

- 30-minute boundary and rediscovery of confirmed idle state after a new store instance;
- running activity retention beyond one hour and after lease/queue removal;
- all three input origins invalidate idle time, even when removed before a sweep;
- queued and running child protection, independent Session/Workspace semantics;
- both orderings of input acceptance versus reclamation across Hosts;
- committed deletion tickets block use until cleanup completes;
- late old-generation callbacks cannot release another execution;
- unverified legacy adoption is rejected and explicit deletion respects users.
- legacy input remains independent of legacy provisioning locks, and the
  application role has the required trigger/activity privileges without broad grants.

Additional Sandbox/Router tests cover lazy creation, never-timeout mapping,
Workspace rebuild, failed database/deletion retention, model waiting, successful
and failed runtime settlement, Interrupt drain abandonment, lost process streams,
and kill acknowledgements without observed exit. Existing package suites and
TypeScript checks are run alongside these tests.

Current package results: Sandbox 106, Session Router 108, store 143 and API 418
tests passed. The real PostgreSQL lifecycle suite has 13 passing tests. The
external Supabase live test and unrelated opt-in PostgreSQL suites are not
counted as passed.

## Real-time acceptance

`verify-sandbox-lifetime.mjs` and `verify-sandbox-idle.mts` create repeatable JSON
evidence. The latter's Host process exits after initializing three real mounted
Sandboxes: confirmed idle, queued child needing a parent temporary file, and an
unresolved execution whose Host disappears. A separate process checks the
post-restart state after 30 real idle minutes.

The real idle/queue/restart check passed after 1,836,552 ms from initialization:
the confirmed-idle Sandbox was reclaimed and rebuilt; saved Workspace bytes
survived and `/tmp` bytes did not. A child queued for more than 30 minutes read
its parent's original temporary input, then continued a real command after a
concurrent parent finished and disposed its own handle. The unresolved command
case retained its original binding after Host exit and lease expiry; only reading
its explicit remote-exit marker permitted its exact activity to be released and
a fresh idle period to start.

The [real idle/queue/restart JSON](sandbox-idle-2026-09-22.json) records the
isolated binding IDs, timestamps and successful checks. Those Sandboxes, their
test Workspace files and database schema were cleaned up after acceptance; the
disposable PostgreSQL Pod was deleted separately.

The long command completed naturally after **3,700 seconds (61 minutes 40
seconds)**, from remote epoch 1790091007 to 1790094707. The original Sandbox and
Pod remained present, with unchanged identities and no shutdown deadline. Probe
processes exited between brief observational reconnects; there was no renewal
heartbeat. `elapsedSinceProbeStartMs` measures total elapsed time, not a claim of
continuous disconnection. The zero-timeout and finite-timeout controls expired.
The adopted Sandbox retained its original running command beyond its former
deadline and through reconnects.

The [gateway lifetime JSON](sandbox-lifetime-2026-09-22.json) records these
observations and the explicit deletion of both surviving probe Sandboxes.
Cleanup confirmed their Kubernetes resources were removed; the two expired
controls were already absent. All isolated verification resources are cleaned up.

## Limits and activation

The implementation has explicit Session-binding enablement and a separate sweep
switch. Legacy resources require verified in-place deadline removal and preserved
uncertainty records. Unknown executions may retain resources indefinitely.
An ambiguous create is reconciled using its durable gateway binding metadata;
there is no destructive orphan-age fallback. No user-state migration or full
Sandbox snapshot restore is claimed.

Production activation and rollback follow
[the deployment procedure](../sandbox-lifecycle-deployment.md) and require
separate authorization. Rollback pauses deletion while keeping retention and
activity recording; it never restores the old short deadline.
