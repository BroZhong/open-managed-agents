# Native Sandbox lifecycle deployment

ADR-0019 and #217–#222 define the only maintained policy: 24 hours running, pause
on expiry, approximately 24 hours retained from pause initiation, then platform
deletion. Confirmed shared idle shortens the running deadline to 30 minutes.
Pi stays in the Runner. ADR-0023's resource sweeper is not enabled yet (#291).

## Release prerequisites

Implementation and tests do not authorize release. For a separately authorized
cutover, stop old Runners before applying `0020_native_sandbox_lifecycle.sql`,
then start the complete new build. Do not run mixed policies or roll back to a
build requiring `sandbox_activities` after this migration. The migration removes
`idle_since`, the old activity table and its trigger. `reclaiming` remains the
explicit termination ticket. `creating_since` (migration 0024, which replaced
`creation_pending`) records a creation intent; see Recovery.
The new trigger serializes queue acceptance with binding decisions; startup checks
that it is installed. API/Runner split migrations remain required.

This change does not migrate existing platform resources or remove their old
never-timeout settings. No production Sandbox cleanup is authorized or performed.
Plan any handling of old resources separately; no compatibility branch or adoption
controller is included in the application.

## Runtime budgets and state

Creation budgets derive from the gateway's 150-second claim timeout
([ADR-0023](adr/0023-sandbox-binding-reconciliation.md)): create sends a
135-second readiness wait inside the 150-second claim, its client request times
out at 170 seconds, and a creation intent's deadline is 180 seconds. The Runner
calls `sandbox-manager.sandbox-system.svc:8080` directly (`E2B_API_URL`); no ALB
or proxy is on that path, so the budgets are code constants
(`server/packages/sandbox/src/sandbox-client.ts`), not configuration. The other
control-plane calls have shorter fixed client timeouts: connect, which resumes a
Paused Sandbox, 60 seconds; getInfo 20 seconds; kill and setTimeout 30 seconds.
These are bounded failure budgets, not a promise of cold-start latency. Native create
requests include `reserve-paused-sandbox-duration: 24h`; `connect` refreshes 24h;
`setTimeout` shortens to 30m without changing expiry action. No renewals happen
between normal tools. Control-plane queries occur only during recovery/deletion,
not as data-plane health probes.

The platform's Paused state can precede completed pause. Its condition timestamp
was also observed to remain stale. Do not claim process/memory recovery from ID
stability or infer a full post-completion retention window. The user accepted
pause operation time being included in the approximate retention period.

A failed or absent settlement callback leaves the existing finite deadline.
Abandoned execution generations are superseded only by new Turn admission, not
by an idle scanner. Ordinary background processes do not extend deadlines.

A timeout update can complete remotely after the caller received an error; a DB
lock cannot fence it. If a late idle update pauses a new Turn early, recovery
restores the environment for a subsequent tool and reports the original operation
as uncertain. No implicit command replay or exactly-once guarantee is provided.

## Environment failures in a Turn's events

A Turn prepares its environment beside the model, never before it
([ADR-0023](adr/0023-sandbox-binding-reconciliation.md), #287). For a Ready
binding, the Turn starts connecting to its Sandbox, verifying the Workspace
mount and deciding the Skill Install while the model's first request runs; the
first tool call waits for them. A Cold binding stays cold until a tool call
creates its Sandbox; a Creating one is waited for or reconciled by that call. A
Turn that answers before its connect returns waits for it at its end.

Each preparation is a pair of spans with the same `prepareId`:
`span.sandbox_prepare_start {turnId, prepareId}` and
`span.sandbox_prepare_end {turnId, prepareId, outcome, durationMs, sandboxId?,
code?, reason?}`. `outcome` is `ready` (connected or created, mount verified,
`sandboxId`), `deferred` (the Turn-start connect found the recorded Sandbox
gone, or the binding moved on; the first tool call prepares again), `failed`
(`code` and `reason` below) or `aborted` (the Turn stopped waiting first: an
Interrupt, a terminated Session, a lost Runner whose span the takeover ends, or
the Turn's end). A Cold binding's pure-chat Turn writes none.

An environment failure is a tool error, not the end of the Turn. The tool call
did not run. Its native result (`agent.context_entry` whose `entry.message` has
role `toolResult` and `isError: true`) carries `details.code`
`sandbox_unavailable` and `details.reason`: `rejected` (the gateway refused the
create with 400, 403 or 409), `unknown` (the call's creates did not complete,
after one more create once an unknown outcome was reconciled), `mount` (the
Workspace mount failed verification) or `unreachable` (connect, the gateway's
list or the binding's database row failed, or the row refused the call while
the binding is reclaimed). The text the model reads is stable
and carries no gateway diagnostics. The model may call the tool again; the next
call prepares again. A tool's own failure (an exit code, a missing file) has no
such code. ADR-0023 also names `sandbox_creating`; no call fails with it,
because a call waits out a Creating binding until its intent deadline and then
reconciles it.

**How to tell from events whether a Turn failed because of its environment:**
it did exactly when the Turn has a `session.error` whose `error.code` is
`sandbox_unavailable`. The Turn writes it once, after its answer and before
`session.turn_completed`, when a preparation of the Turn failed and none
ended `ready` after it, counting every attempt of the Turn: a takeover starts
from the spans its predecessors wrote. A Turn with environment tool errors but
no such `session.error` recovered within the Turn. The error keeps the answer,
like `workspace_storage_error`. A `session.error` is never written in the middle
of a Turn, because a takeover's plan treats any `session.error` in a Turn as its
end; a Runner lost after an environment failure therefore leaves a Turn its
takeover continues. The same code also ends a Turn of a sandboxed Agent on a
Runner with no Sandbox configured, before its Adapter runs. Skill Install
failures keep their own code, `skills_install_failed` (ADR-0022).

## Recovery

Use the explicit Shanghai kubeconfig for read-only diagnosis:

```sh
kubectl --kubeconfig "$HOME/.kube/agent-platform-config" -n sandbox-system get sandboxes
```

Creation commits `creating_since = now()` (database clock) before calling the
gateway, and the successful create writes `sandbox_id` and clears it
([ADR-0023](adr/0023-sandbox-binding-reconciliation.md)). A create the gateway
rejects with HTTP 400, 403 or 409 returns the binding to Cold and fails the
tool call. Any other outcome (a 5xx, the gateway's claim timeout included, a
create timeout or lost connection, a lost Runner, a lost binding write) leaves
the intent. A Turn that finds it (a Child Session sharing the binding, a Turn
resumed after a takeover) waits: it reads the row again when the creator's
`environment` hint arrives on the Redis control channel and every 2 seconds
regardless, so it continues at once when the creator records the Sandbox and
within 2 seconds without Redis. A Turn starting while the binding is reclaimed
waits the same way for the reclaimer's hint. Past `creating_since` + 180
seconds it reconciles the binding itself: it lists the gateway's running and paused
Sandboxes labelled `oma.dev/binding=<root Session id>`, adopts the one it finds
(a running one, else the earliest claimed, killing any others), or returns the
binding to Cold and creates. The tool call whose create had the unknown outcome
does so itself and creates once more at most, so it fails after about six
minutes at worst. No operator action is needed, and none should clear the
column by hand. A creator whose binding write finds the row moved on kills its own
Sandbox. Every created Sandbox also carries `oma.dev/environment`, the Runner's
`OMA_ENVIRONMENT` (`production` or `test`, required). A known failed mount
keeps its bound ID so subsequent preparation can retry without duplicating
resources.

Migration `0024_binding_creating_since.sql` runs with the Runners scaled to 0:
rows that were `creation_pending` become Creating since the epoch and are
reconciled on first use. `0024_binding_creating_since.rollback.sql` restores
`creation_pending` (true for every intent) for the previous image.

Explicit termination uses `session_cleanup` and a committed `reclaiming` ticket.
It kills the Sandbox the binding records, then every Sandbox the gateway lists
with the binding's `oma.dev/binding`, whether the binding records a Sandbox, a
creation intent or neither, and clears the binding to Cold only once deletion
is confirmed through the control plane. Network/confirmation failures leave the
ticket retryable. A binding whose creation intent is within its 180 s deadline
stays claimed until a retry past it, so a create still in flight is killed too.
Shared non-terminated children and queued input prevent deleting their binding.
Saved Workspace files and history are retained.

There is no instruction to remove unknown activity records and no rollback that
reinstalls infinite lifetime. The recurring sweeper of ADR-0023 is not enabled
yet (#291); until then a Sandbox no binding records runs to its platform
deadline unless its Session's termination reclaims it. Sessions whose cleanup
completed before termination reclaimed by binding are not revisited.

## Verification

`verify-native-sandbox-lifecycle.mjs` and its 2026-10-10 evidence document the SDK,
Gateway and Manager versions and the isolated native platform tests. The original
strict retention gate failed; the later user-approved approximate contract accepts
that observed behavior. Retain the original observations rather than rewriting
history. See the integration report for the application changes and final checks.

All native tool execution streams now have a three-hour Host wait ceiling.
Shorter explicit bash timeouts retain five seconds of response grace within that
ceiling. Commands may still have effects after the caller stops waiting: expiry
is unconfirmed execution, not a successful kill or permission to replay.
