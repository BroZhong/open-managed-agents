# ADR-0017: Reclaim Sandboxes only after confirmed idle time

## Status

Accepted. Implementation is restricted to explicit root Session bindings. This
supersedes the one-hour Sandbox lifetime assumption in ADR-0002 and ADR-0005
for those bindings. Production-wide activation is a separate release decision.

## Decision

Independent Sessions retain independent Sandbox bindings even when they share a
Workspace. Children inherit their creation parent's binding. The Sandbox Manager
owns lifecycle operations; the Host reports actual execution settlement and its
durable pending input queue. Opening a SandboxSession remains lazy.

A binding becomes eligible for reclamation only after every shared execution has
actually settled and every accepted input has left its queue. Model reasoning,
tools and synchronous waits all protect the Sandbox. All input origins count,
including user messages, Delegation Inputs and Delegation Results. The first
confirmed idle observation starts a full 30-minute period. A new accepted input
invalidates that period, including an input withdrawn before the next sweep.
The periodic sweep can delay reclamation; it must never shorten the period.

Activity records identify the Session, pending input, Host owner and generation.
They do not expire. A missing heartbeat, expired claim, terminated Session,
completed history marker or bounded Interrupt drain is not execution settlement.
An observed runtime end/error and settled remote operations permit release of
that exact activity record. An old Host's callback cannot release another
generation. A lost command stream, uncertain filesystem RPC or abandoned runtime
retains its activity indefinitely. Recovery requires concrete execution-exit
evidence; elapsed time and a successful health probe are insufficient.

PostgreSQL serializes accepted input, activity admission and reclamation through
the environment row. A pending-input INSERT trigger invalidates `idle_since`
within the accepting transaction. Reclamation checks all shared Sessions and
activities under that same lock, commits `reclaiming` before issuing the external
delete, and clears the Sandbox identity only after deletion succeeds. New work
waits behind a committed ticket. A Host restart retries the same ticket; a lost
database connection cannot reopen the binding during an uncertain delete.

Managed Sandboxes use the verified ACK `e2b.agents.kruise.io/never-timeout`
extension. Neither SDK `timeoutMs: 0` nor command timeout disabling establishes
this property. No renewal heartbeat, eight-hour cutoff, maximum connection time
or maximum Sandbox age substitutes for unknown-state retention. Legacy bindings
remain outside the rollout and retain their existing behavior until safely
adopted. The implementation refuses automatic adoption of an existing binding.

Only completed writes within the OSS Workspace survive reclamation. A later tool
operation recreates the Sandbox against the same verified mount. Temporary files,
processes, caches and extra dependencies outside the Workspace are disposable;
there is no full Sandbox snapshot. Detached background work does not prevent
reclamation. History viewing and Workspace file API reads do not renew activity.

## Rollout and recovery

Migration 0014 installs the queue trigger and persistent state. Explicit
`SANDBOX_IDLE_BINDINGS` enables retention for selected root Session IDs and their
children; `SANDBOX_IDLE_SWEEP=true` separately enables deletion. Neither is added
to production manifests. Startup refuses controlled enablement without the
trigger. Rollback pauses sweeping while retaining never-timeout creation and
activity recording; it must not restore short expiry to existing resources.

Existing finite-lifetime resources require an authorized, UID-checked removal of
their gateway deadline before adoption, preserving the running Pod. Every
pre-adoption execution whose settlement cannot be proved receives an unresolved
activity record. An ambiguous create may leave a gateway resource before its ID
commits in PostgreSQL: the persistent `oma.dev/binding`, Tenant and Workspace
metadata permit operator reconciliation. Such resources are retained, never
deleted by an orphan-age policy or silently replaced as part of adoption.

See [rollout and rollback](../sandbox-lifecycle-deployment.md) and
[verification evidence](../verification/sandbox-lifecycle-2026-09-22.md).
