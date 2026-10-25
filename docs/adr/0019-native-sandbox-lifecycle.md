# ADR-0019: Native finite Sandbox lifecycle

## Status

Accepted for #217–#222. Supersedes ADR-0017. The user explicitly accepted on
2026-10-10 that paused retention starts when pause is initiated: roughly 24 hours
including time spent pausing, not a guaranteed 24 hours after completion.
The original gate's delayed-pause evidence remains valid; this is a contract
clarification, not a claim that the platform was fixed.

Partly superseded and revised by [ADR-0023](0023-sandbox-binding-reconciliation.md)
(2026-10-24):

- **Superseded:** "Faults and persistence" — an ambiguous create or binding
  commit no longer blocks automatic replacement and no longer needs an operator.
  The binding records a creation intent with a deadline; past it, OMA lists the
  gateway's Sandboxes by `oma.dev/binding` and adopts, clears or deduplicates.
- **Superseded:** "Decision" — "no … adoption phase" and "no OMA idle clock or
  reclamation scanner": OMA adopts by binding, termination reclaims every
  Sandbox the gateway lists for the binding, and every Runner runs a sweeper.
  There is still no idle clock in OMA; deadlines stay on the platform.
- **Revised:** the 185 s client request budget (slightly longer than ALB's
  180 s) — the Runner calls the gateway in-cluster, and the budgets derive from
  the 150 s claim timeout: wait-ready 135 s < claim 150 s < create request
  170 s < intent deadline 180 s.

## Decision

> **Revised by [ADR-0022](0022-skill-bundles.md):** "refreshes Skills" below
> becomes "verifies the Skill Set version each Turn and installs it when it
> changed"; an unchanged Skill Set on the same Sandbox costs no OSS or Sandbox
> call, and the model request no longer waits for the install. Mount
> verification, the finite lifetime requirements, cold pure chat staying cold
> and "no business operation executes until preparation and binding persistence
> succeed" are retained.

Pi remains in the Runner. The platform owns the only resource lifetime:

- First tool use creates with 24h running timeout, `onTimeout: pause`, automatic
  traffic resume disabled, and `reserve-paused-sandbox-duration: 24h`.
- A new Turn connects/resumes an existing binding and refreshes 24h once, verifies
  the exact OSS mount identity and refreshes Skills. Cold pure chat stays cold.
- Normal tools reuse their prepared handle without health, timeout or mount RPCs.
- Confirmed settlement of all shared business executions with no Queued Input
  shortens the platform timeout to 30 minutes. This is event driven, under the
  existing binding lock. There is no OMA idle clock or reclamation scanner.
- Missing settlement, Runner loss and uncertain remote operations do not request
  idle. Existing finite deadlines still pause and eventually delete the resource.
  Unknown execution is scoped to its admitted generation; a newly admitted Turn
  supersedes abandoned business-use records and refreshes its finite deadline.
  Stale completion callbacks cannot release a newer generation.

The queue INSERT trigger takes the binding lock; Turn admission, idle update and
explicit deletion coordinate on that same row. Existing delegation resource-use
records carry the current business generation; there is no second resource-use
ledger, permanent resource activity lease, gateway never-timeout option, adoption
phase, custom resource probe or fallback policy. Detached background work is not
an independent resource user.

Database ordering is not remote fencing. A previously timed-out 30-minute write
can arrive after a newer 24-hour write and cause early pause. This is accepted;
normal subsequent tools recover the environment without replaying uncertain work.

## Faults and persistence

A failed environment operation preserves partial output. A control-plane query
is made only on an exceptional path. Paused resources are resumed; Running
resources are never replaced; only typed NotFound allows clearing a stale ID.
Unknown network state throws an honest tool error. Recovery attempts and waiting
are bounded. The original operation is not retried. Pi is instructed to inspect
saved files or external effects before deciding whether to request it again;
this is not an exactly-once guarantee and does not mechanically prohibit a model
from requesting another command. It does not change user Interrupt semantics.

Creation reserves `creation_pending` in the binding before the external request.
No business operation executes until preparation and binding persistence succeed.
Known preparation failures retain the known resource for retry. An ambiguous
create or binding commit blocks automatic replacement. Other callers wait for a
bounded period and report uncertainty; Runner restart does not erase the intent.
This binding marker is not a resource renewal and does not keep any Sandbox alive.
If the response cannot be reconciled, operators must inspect the exact binding
metadata before attaching a confirmed resource or clearing an intent; do not
blindly retry create. Platform expiry bounds resources even without OMA recovery.

Only successfully written and closed files in the OSS Workspace are durable.
Temporary files, dependencies, processes, memory and command streams have no
preservation guarantee. Rebuild uses the original immutable Workspace prefix.

## Termination and rollout

Explicit Session termination revokes input and existing execution through the
business coordinator. Shared non-terminated users and their queued inputs retain
the binding. When no legitimate users remain, a committed deletion ticket drives
direct kill by ID, never connect/resume. Failed deletion or confirmation keeps the
pointer/ticket; existing Session cleanup retries across Runners. Completion
matches both binding ID and Sandbox ID, so old callbacks cannot erase replacements.
Interrupt, closing a page and sidebar soft deletion do not release the resource.

Apply migration 0020 with old Runners stopped, then deploy the complete new build
through a separately authorized release. It removes the obsolete activity table,
idle timestamp and trigger, retaining binding/queue/termination coordination. It
does not modify platform resources, adopt old Sandboxes or perform production
cleanup. Mixed old/new lifecycle operation is unsupported.

See `docs/sandbox-lifecycle-deployment.md` and the native lifecycle verification
reports for platform versions, shortened isolated acceptance, and limitations.

## Host tool wait ceiling

On 2026-10-11 the user approved a three-hour maximum Host wait for native tool
execution streams. Every native tool uses this ceiling, including bash without
an explicit timeout. A shorter valid bash timeout retains its five-second response
grace, capped at three hours; larger explicit timeouts cannot extend Host waiting.
Native argument validation and command parameters are preserved. The ceiling
bounds waiting for the execution stream, not the lifetime of a process or an
entire Turn; preparation and bounded exceptional recovery are separate operations.
Expiry follows the existing unconfirmed-result/recovery path, preserves output
and never automatically replays the operation. It is not a user Interrupt.

On 2026-10-24 the user approved a forty-minute default for bash calls without a
timeout. Two 2026-10-13 production Sessions each waited the full three hours on
a command that never exited, and the process group outlived the ceiling. The
Host now passes `timeout: 2400` to native bash when the model omits it and
advertises that default in the parameter description. Pi enforces it like an
explicit timeout: it kills the process group and returns the output so far with
"Command timed out". The Host wait for such a call is 2405 seconds. Explicit
timeouts, including invalid ones left to native validation, and the three-hour
ceiling for other tools are unchanged.
