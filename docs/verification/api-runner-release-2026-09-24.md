# API / Runner production release — September 24, 2026

Issues #197–#203 were deployed to `oma-infra` on the `agent-platform` cluster after
explicit release authorization. Public traffic at <https://agentry.welltop.tech>
uses the independently deployed API. The existing combined Deployment is retained
at zero replicas for rollback. Model-release automations remain unchanged.

## Release and safeguards

Builds ran on `vfs-dev` in an isolated clean checkout, preserving its original
checkout. Immutable registry tags are recorded with Pod image digests in the
[release evidence](api-runner-release-2026-09-24.json).

- Migration `0015_api_runner_split.sql` was applied with the existing admin
  migration mechanism. It is additive; 97 historical cleanup entries completed.
- Before migration, a repeatable-read logical backup captured 19 application
  tables. The compressed backup was validated and retained privately with its
  manifest; database contents and credentials are not committed to this repository.
- API, Runner and Web each have one replica. Public Service `oma-server` selects
  `app=oma-api`. API has no model-config mount or Sandbox service account.
- Execution Deployment updates were gated on zero pending inputs and zero running
  Sessions. Old Runner Pods were allowed to disappear before normal cleanup tests.
- Existing `SANDBOX_IDLE_SWEEP` and its three authorized binding IDs were preserved
  exactly. This release does not expand idle reclamation scope.
- Redis fault injection used a separate staging Redis and PG schema. Production
  Redis was never stopped. The staging workloads and schema were removed after
  verification and cleanup.

## Regression coverage

| Scenario | Environment and result |
| --- | --- |
| Two APIs and two competing Runners | Staging: one promoted input, ordered unique durable events and live chunks on both observers |
| API deletion during real work | Staging: a real 45-second Sandbox command completed; SSE reconnected once without duplicate history and Runner UIDs stayed unchanged |
| Independent API update | Production: Runner UID unchanged across the API update |
| Redis unavailable, including fresh Runner startup | Isolated staging: readiness and PG-backed completion worked; after Redis Pod removal, output had zero live chunks; chunks returned after recovery |
| Interrupt and queued tail | Staging during Redis outage and production: only current Turn aborted, next input preserved, late Interrupt harmless |
| Real model and mounted Workspace | Production and staging: actual model/tool output succeeded; saved bytes remained readable after termination |
| Sync/async delegation | Production and staging: real Child Sandbox tool execution; exactly one consumed background result |
| Loop manual dispatch | Production and staging: completed without changing the scheduled cadence; verification Loop disabled |
| Idle and active termination | Durable terminal status, preserved history/files, and eventual Sandbox binding cleanup; see the fixes and final reruns below |
| Public ingress and Web | Public API readiness reports role `api`; Web responds HTTP 200 |

The protocol-v1 image pairs exercised were API `34db82eee1ce` / Runner
`448f6bbc8247` in staging and API `448f6bbc8247` / Runner `34db82eee1ce` during
production cutover. Production exercised both roles at `448f6bbc8247`, followed by
API `448f6bbc8247` / Runner `4a745042ceaa` for the final termination regression.
These checks do not establish compatibility with arbitrary historical images.

## Problems found and resolved during release

Real active-termination testing found three related settlement paths that unit
fixtures had not exercised:

1. Pi may emit final accounting before its iterator naturally ends. The Runner now
   observes the natural end without publishing revoked output; advisory iterator
   closure cannot conceal settlement evidence (`7fd4e76557ff`).
2. A database failure while recording proven execution exit must not discard that
   proof. Exact settled activities are retained locally and retried by recovery and
   cleanup scans (`448f6bbc8247`).
3. Termination can revoke a durable event write before the heartbeat aborts the
   runtime. The failed fence write now aborts execution and observes iterator exit;
   ordinary write errors retain error semantics rather than becoming user
   Interrupts (`4a745042ceaa`). A focused regression failed before the fix.

Each fix received focused tests and Standards/Spec review. Unknown activity remains
conservatively retained: Session termination or lease age alone is never used as
proof of remote execution exit. Early failed verification fixtures were recovered
only after confirming the owning Pod had exited and the exact remote Sandbox had
zero running commands. Those recoveries are not counted as automatic-cleanup test
passes. An exiting old staging Runner also claimed a fixture during rollout; this
confirmed why normal acceptance must wait for old Pods to disappear.

With Runner `4a745042ceaa`, three consecutive real active-termination reruns
completed cleanup automatically, without manual activity release. Final live-delta
and replay checks passed. All 15 production verification Sessions, including
completed Children, are terminated. Verification pending inputs, activities,
incomplete cleanup rows, live Sandbox bindings, enabled Loops and active API keys
are all zero. The three serving Pods are ready with zero restarts.

## Automated checks and repeatability

The final Router change passed 937 server tests (39 environment-gated skips), all
server package typechecks and the two deployment contracts. The release also passed
412 Web tests, 414 adapter tests, their typechecks, and ten separate-process
acceptance scenarios against real local PostgreSQL/Redis. Details of those local
boundaries are in [the local report](api-runner-split.md).

`deploy/scripts/verify-api-runner-release.mjs` preserves structured evidence across
phases and Pod replacement. It creates an isolated verification tenant, revokes its
temporary API keys, and terminates its own Sessions and disables its Loop during
cleanup. Invocation is documented in the
[operations guide](../api-runner-operations.md#repeatable-release-regression).

Ordinary Runner loss still has the documented recovery limits; this release does
not promise seamless restart of an in-flight Turn. The change isolates API rollout
from execution ownership and preserves durable recovery/cleanup state.
