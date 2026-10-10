# Native lifecycle implementation and acceptance: #217–#222

The user accepted approximately 24 hours of retention **from pause initiation**,
including time spent pausing, and authorized proceeding after the strict #217
qualification run. ADR-0019 records that decision. No platform patch is assumed.

## Delivered behavior

- Cold Session creation and pure chat do not allocate. First tool use reserves a
  durable creation intent, creates with 24h pause-on-timeout / 24h paused retention,
  verifies mounted identity, prepares Skills, and persists its binding before
  executing the business operation. Preparation failure retains a known resource;
  an ambiguous response/commit never automatically creates a replacement.
- Each existing binding is connected/resumed and prepared once per Turn. Ordinary
  tools use the prepared handle, without extra health, mount or timeout RPCs.
- Actual current execution settlement plus an empty shared input queue permits a
  coordinated 30-minute deadline. Model waiting, child executions and every input
  origin protect it. Unknown outcomes and lost callbacks retain the existing
  finite deadline. A newly admitted generation supersedes abandoned business uses;
  stale callbacks cannot shorten that generation's timeout.
- Tool faults query control-plane state. Paused resumes, confirmed missing rebuilds
  on demand, Running is not replaced, and unknown transport state does not imply
  deletion. Partial output is retained and the original operation is never replayed.
  Pi receives explicit guidance to inspect effects before deciding its next action.
- Explicit termination preserves legitimate shared users, uses direct kill without
  resume, confirms deletion before pointer removal and retries through the existing
  cleanup outbox. Native expiry can clear an obsolete pointer even if an old
  unknown business use remains. Replacement IDs survive stale cleanup callbacks.
- Removed the idle sweeper, `idle_since`, separate permanent activity table and old
  lifecycle verification scripts. Migration 0020 retains only input/binding and
  explicit termination coordination. There is no old-policy switch or adoption.

## Automated verification

All eight server package typechecks passed. The MCP catalog now declares the same
Node 22 development types as the other server packages, fixing its inherited old
`BufferEncoding` definition during the full typecheck. No runtime dependency changed.

Final full server tests passed after review: **1,020 tests**, with opt-in external cases skipped in
that default run. Adapter dependencies had to be installed from their existing
lockfile before the Pi-context integration test could load; the final full run
was clean.

Additional isolated infrastructure checks:

- **10 real PostgreSQL coordination tests** passed against a new local container
  and private schema: all three input origins, shared children, independent Session
  bindings, generation takeover, stale callbacks, serialized input/idle race,
  failed timeout response, cross-Runner deletion tickets and durable creation intent.
- **10 API/Runner process tests** passed across the initial run and focused reruns.
  They cover competing Runners, offline Runner acceptance, missed wake, cross-API
  Interrupt, Loop dispatch, Redis failure/recovery, sync/async children and cleanup.
  The first Redis fault test refused the container's non-test name; after rename,
  Docker's dynamically allocated port changed on restart. Recreating this same
  dedicated fixture with a fixed port resolved the infrastructure failure. No
  production Redis or application fallback behavior was changed.
- Manager tests inject a late idle update after a fresh 24h preparation, pause the
  environment, and verify same-Turn recovery with no original write replay. A
  separate partial-output command writes once, disconnects, and remains single-shot.
  Router verification confirms continuation produces one completed Turn and no
  user-Interrupt event.

The DB tests exercise real locks/triggers rather than using pg-mem as concurrency
evidence. Timeout-update ordering is still not remote fencing: a late update can
cause early pause, as explicitly accepted in the tickets.

## Application-level online verification

[Raw evidence](native-sandbox-integration-2026-10-10.json) was produced by
[`verify-native-sandbox-integration.mts`](../../deploy/scripts/verify-native-sandbox-integration.mts).
It uses the actual Manager, E2B client, PostgreSQL stores and OSS mount verifier.
The database was a dedicated local `oma_local_native` database/schema, never the
production OMA database. The existing Shanghai Gateway/Manager served only new
randomly marked test resources. No shared controller or template was modified.

| Path | Observation |
| --- | --- |
| Cold pure-chat preparation | No Sandbox created |
| First tool use | Warm allocation in 756ms, mount verified before file use |
| Multiple normal tools | One mount check and no reconnect in that Turn |
| Next Turn | Same ID; deadline observed near 86,400 seconds |
| Parent settles with shared child input | 24h deadline retained |
| Last child settles | Deadline observed near 1,800 seconds |
| Pause and resume | Same resource resumed; saved file available |
| Native retention expiry | Old resource confirmed missing; preparation clears pointer without creating |
| Demand rebuild from private snapshot | New cold resource in **105,017ms**, below the 150s server budget |
| OSS after rebuild | Sandbox read and Host read of exact isolated prefix matched |
| Parent termination while child legitimate | Resource retained |
| Last-user termination | Direct release with no additional connect; binding cleared after confirmation |

Every production create request was asserted to contain 86,400,000ms, pause-on-expiry,
no traffic auto-resume and 24h paused retention before the test factory shortened
**only retention** to 100 seconds. Normal application idle/active writes were
observed as 30m/24h. The verifier separately shortened running time to 20 seconds
to observe pause without waiting 30 minutes. These are accelerated acceptance
observations, not a 48-hour endurance test.

Cold reconstruction used a private snapshot, not a drained or modified shared
warm pool. Its 105s observation supports the selected finite 150s claim/readiness
budgets within the existing 185s client / 180s ALB window; it is not a cold-start
latency SLA for every template or load. SDK 2.24.0 and actual Gateway/Manager image
IDs are captured in the JSON.

Both allocated Sandbox IDs, the private snapshot, the isolated OSS file and the
local test schema were removed. Evidence has `cleanupConfirmed: true`. The first
cleanup attempt refused to claim completion before snapshot pagination was
handled; the corrected phase completed and verified absence. Failed attempts are
preserved, not rewritten as successes.

## Operational limits and release

An ambiguous creation intent intentionally blocks automatic reallocation. It does
not renew the resource. Reconcile its exact trusted binding metadata before
attaching a known resource or clearing the intent; native expiry remains finite
if the Runner never returns. Unknown execution is not an exactly-once guarantee.
Local files, processes, memory and dependencies can be lost; only closed OSS writes
are durable. Interrupt and sidebar soft deletion retain their separate semantics.

Migration 0020 and the complete new Runner build must be released together with
old Runners stopped. No production migration, application deployment or existing
business-resource cleanup was performed. Historical verification results remain
historical; the maintained policy is exclusively ADR-0019.

## Review correction

Standards review of `e0f23a8..4ca0f88` found no hard violations or actionable smells.
Spec review found one correctness issue: abandoning a command iterator bypassed
`catch`, leaving uncertainty only in a shared client flag that a sibling Turn
could reset. #219 requires unknown execution not to be treated as idle.

The manager now tracks reliable `onExit` evidence for each command and latches
Turn-local uncertainty in `finally`, including iterator abandonment. A command
conclusively aborted before issuance remains settled; confirmed Interrupt exit
evidence is preserved. File/RPC abort without local exit evidence is uncertain.
The transport fake now reports normal exit through the same public callback.

The new abandonment/sibling-preparation regression failed before the fix and
passed afterward. A second regression verifies pre-issuance abort and normal exit
remain distinct. Focused Sandbox and Router checks passed after the correction.

## Standards

Standards review (`e0f23a8..4ca0f88`): no hard standards violations or actionable smells found.

- ADR-0019 explicitly supersedes the old retention policy; CONTEXT.md and operational documentation consistently use the accepted pause-initiation contract.
- Manager preparation preserves cold pure-chat behavior and caches prepared handles for ordinary tools. Exceptional recovery does not replay operations or replace Running/unknown resources.
- Durable creation intent precedes allocation. Failed preparation retains known identity, while ambiguous creation or binding commit prevents automatic replacement.
- Business-use records carry ownership and generation; settlement and queue checks coordinate under the binding lock. Superseded callbacks cannot remove newer records.
- Explicit deletion uses direct kill, confirms absence, and matches the recorded Sandbox ID before clearing the binding. The old idle scanner is removed.
- Verification documentation separates accelerated tests, observed cold-start latency, accepted remote-ordering limitations, and the still-undeployed migration.

Possible smells: none warrant changes. The remaining lifecycle branches represent distinct required transitions; introducing another abstraction or resource ledger would obscure the documented ownership model.

## Spec

Original P1 resolved in `5892098`. Manager.exec now records reliable exit evidence locally and latches Turn-local uncertainty in finally, including iterator abandonment. Sibling preparation cannot clear that latch. Conclusive pre-issuance aborts remain settled, and confirmed user aborts do not trigger environment recovery.

The regression exercises the previously missing sequence: partial output, iterator return without exit evidence, sibling preparation, original session still unsettled. The normal-exit and pre-issuance-abort tests cover the corresponding safe paths.

No new actionable spec findings in this delta. The fake transport's onExit callbacks align successful completion with the production contract.

Final review summary: Standards 0 actionable findings; Spec 0 outstanding actionable findings (one P1 fixed and re-reviewed). Final full server run passed 1,020 tests. The dedicated local PostgreSQL and Redis containers were removed after the infrastructure tests; live resource and OSS cleanup remain confirmed in the JSON.
