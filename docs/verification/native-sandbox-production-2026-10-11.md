# Production native Sandbox lifecycle release — 2026-10-11

## Release scope and authorization

The user authorized production testing, then explicitly authorized production
migration/deployment after incorporating latest main. `origin/main` at
`1a964e4` (#223/#224) was merged without conflicts in `5cbdf66aa`.
The release was built from that merged history on `vfs-dev`.

Production cluster: `agent-platform`, Shanghai. Application namespace: `oma-infra`.
Public API: `https://agentry.welltop.tech/api`.

## Database and application rollout

Before migration, production had no running Session, no Queued Input and no old
activity records. It had 1,454 environment bindings (one non-null Sandbox ID).
The old Runner was stopped and its Pod deletion confirmed before migration.
The combined `oma-server` remained at zero replicas.

The affected tables and old function/trigger definitions were backed up to the
private database schema `oma_native_backup_20261011` (PUBLIC access revoked).
Migration 0020 was applied with the privileged existing database connector as one
atomic DO statement, preserving the migration's lock timeout and statements.
The connector's SQL RPC does not support explicit BEGIN/COMMIT; the initial
transaction-wrapper attempt was rejected without changes. The successful call
also checked that running executions and legacy activities were absent.

Confirmed afterward:

- `sandbox_activities` removed;
- `idle_since` removed;
- `creation_pending` present;
- `sandbox_input_coordination` trigger enabled.

Initial candidate Server digest:
`sha256:9e6abdb78a213cd95390465b398d8d706fcf3752bc691ec580b8d21f296b8ce1`.
Both actual split Deployments, `oma-api` and `oma-runner`, were updated. The legacy
combined deployment script was not used. Production Web already matched the
built digest `sha256:ef373d2de948e41c16b3f58b151423c4479b16b87cf75e9423bd76638feb4487`,
so no redundant Web restart was needed.

## Defect found by the production test and corrected

The first real Router Turn successfully wrote/read the file and reused its
Sandbox, but its deadline remained 24h after completion. Production testing
exposed an omission in the prior isolated Manager acceptance:
`SessionRouter.completeTurn` calls `releaseResourceUse` before queue ack, which
removed the managed execution record before `lifecycle.finish` could make its
idle decision. The prior Manager-level acceptance called finish directly.

Commit `12f6933` changes ordinary release to preserve `managedTurn` records.
Only lifecycle settlement removes them and requests idle under the binding lock.
A real PostgreSQL regression now exercises bookkeeping release, queue ack and
settlement in Router order. It failed with zero idle calls before the fix and
passed afterward, including duplicate-callback protection.

Independent review found no actionable issue with the patch. The idle-settlement correction was first deployed to both API and Runner:

`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:8633a020094ac0b96c3ecd2ba7c842cfe853780265fa055c1d11f74675abd499`

Image tag: `12f69330e42b`. This follow-up required no further database migration.
No business Sandbox was deleted or patched during either release.

## Verification

- Merged release: eight server package typechecks, 1,021 default server tests,
  469 Web tests, and Web production build passed.
- Production fix: Store typecheck, all 11 real PostgreSQL coordination tests and
  the full default server suite passed. Opt-in cases remain skipped in the default
  suite; the real PostgreSQL cases ran separately.
- Server image source was checked for native policy, absence of `sweepIdle` and
  the Turn-local uncertainty fix. Both Deployments became ready and public health
  returned `{ "status": "ok" }`.

The production verifier uses a new isolated verification tenant through the public
API, real Pi model/tool execution, the production Router/database and real E2B/OSS.
SDK faults affect only exact Sandbox IDs whose tenant and binding metadata match
the recorded verification Session. Temporary API keys are revoked after each phase.

Observed successful paths:

- Session creation and pure chat stay cold.
- A real Pi bash tool writes the OSS marker.
- Multiple Turns reuse the same ID and can read the marker.
- After the fix, completed Turns set an approximately 30m deadline (1,798–1,799s).
- Explicit pause followed by a new Turn resumes the same ID and retains the file.
- Deleting the exact test resource leads to a new ID on later tool demand and
  the original OSS file remains readable.
- A real synchronous Child Session executes its bash command, reads the shared
  file, inherits the parent's binding and returns its result. Final shared
  settlement produces the 30m deadline.

The evidence preserves failed attempts: the verifier initially ran in API, which
intentionally has no E2B credentials; it was moved to Runner rather than widening
API secrets. The SDK method is `Sandbox.pause`, not `tryPause`; that verifier-only
mistake was corrected. One initially misordered key-revoke call was corrected and
that exact test tenant's outstanding key explicitly revoked before proceeding.

Final fault-injection and cleanup results follow below.

## Paused explicit-timeout failure and correction

The same-Turn fault test supplied bash `timeout=15`, wrote one observable effect,
and paused that exact test Sandbox. The platform kept the stream connected while
freezing Pi's internal timer. The original wrapper explicitly disabled its Host
transport timeout, so the production test exceeded its 240-second budget. The
exact resource was manually resumed to release that one test Turn; no command
was reissued. Its first side-effect file is retained in test evidence until cleanup.

Commits `6d7055a` and `d19bb17` mirror an explicitly requested positive finite bash
timeout on the Host transport, plus five seconds for the native settled response.
Grace is clamped to Node's maximum timer; invalid native timeout inputs are left
to native validation. Omitted timeouts retain the existing no-default-timeout
contract. On an environmental stream failure, the SDK wrapper now disconnects
without issuing a new kill RPC that could itself stall while Paused. The original
operation remains unconfirmed. Explicit user cancellation keeps its separate
kill path. This does not imply an exactly-once guarantee or lossless process resume.

Native parity caught an intermediate overflow at an invalid timeout above Node's
maximum; it was fixed before this patch was deployed. All 287 Pi Adapter tests,
the other Adapter packages, Server typechecks and the full Server suite passed.
Independent review found no remaining actionable finding in either patch.

Final deployed Server: `d19bb17229bd`, digest
`sha256:30333f28d3cae850e37ddf421ac33a3ccec8f8d0223651f8d07a26223d9a2ece`.
The production failure test was repeated successfully with a unique new side-effect
file; the earlier failed attempt is preserved in the raw evidence.

A deliberately unlimited command whose transport stays silently connected while
Paused has no newly invented Host timeout; it may require explicit user action or
an eventual transport failure. The successful bounded test must not be described
as proving automatic detection of every silent, indefinitely connected stream.

## Final production result

[Raw production evidence](native-sandbox-production-2026-10-11.json) includes all
initial failures and corrected repeats, rather than representing this as a clean
first attempt. The final `recover-tool` phase passed all checks:

- the failed tool honestly reported uncertainty and no automatic replay;
- a later tool in the same Turn successfully inspected the effect file;
- the file contained exactly one `once` marker;
- the recovered resource kept a finite active deadline.

That Turn also records the expected `workspace_storage_error` diagnostic for an
unconfirmed operation; it is not a user Interrupt or a claim of a failed overall
Turn. The verifier allowed this exact diagnostic during fault injection (its
historical check label says “without session error”; read the allowed-code logic,
not that overly broad label).

The final `terminate` phase paused the exact owned test resource, terminated its
Session through the production API, observed the cleanup outbox completion and
null binding, and confirmed SDK NotFound. The saved OSS file remained readable
until the explicit test-file cleanup phase.

Final independent audit:

| Item | Result |
| --- | --- |
| API / Runner / Web | 1 ready replica each |
| Legacy combined Server | 0 replicas |
| Public `/api/health` and `/api/ready` | Healthy |
| Test Sandbox resources | 0 |
| Test Workspace files | 0, confirmed with actual OSS Store listing |
| Active test API keys | 0 |
| Unterminated test Sessions | 0 |
| Unresolved test bindings / queued input | 0 / 0 |
| Test Agents | 0 |

Two test Session histories and the empty Workspace metadata remain as audit
records in the isolated verification tenant. No business resource was selected
for fault injection or deletion. The private migration backup was deliberately
retained for recovery. The dedicated local regression PostgreSQL container was
removed after verification.

Final verification totals: **1,022 server tests**, **442 Adapter tests** (287 Pi
plus 155 other Adapter tests), **469 Web tests**, and **11 real PostgreSQL
coordination tests** passed. Server and Pi typechecks and Web build passed.
The shortened fault injections do not claim a 48-hour endurance test. Existing
business Sandboxes created under the previous policy were not automatically
adopted or mass-deleted.

No outstanding review finding remains in the two production corrections. The
silent, deliberately unlimited-stream boundary above is an explicit limitation;
no default command timeout or hidden resource probe was introduced.
