# Native Sandbox lifecycle deployment

ADR-0019 and #217–#222 define the only maintained policy: 24 hours running, pause
on expiry, approximately 24 hours retained from pause initiation, then platform
deletion. Confirmed shared idle shortens the running deadline to 30 minutes.
Pi stays in the Runner. No OMA resource sweeper is required.

## Release prerequisites

Implementation and tests do not authorize release. For a separately authorized
cutover, stop old Runners before applying `0020_native_sandbox_lifecycle.sql`,
then start the complete new build. Do not run mixed policies or roll back to a
build requiring `sandbox_activities` after this migration. The migration removes
`idle_since`, the old activity table and its trigger. `reclaiming` remains the
explicit termination ticket; `creation_pending` records ambiguous allocation.
The new trigger serializes queue acceptance with binding decisions; startup checks
that it is installed. API/Runner split migrations remain required.

This change does not migrate existing platform resources or remove their old
never-timeout settings. No production Sandbox cleanup is authorized or performed.
Plan any handling of old resources separately; no compatibility branch or adoption
controller is included in the application.

## Runtime budgets and state

The official SDK receives 150-second claim and readiness budgets and the existing
185-second client request budget (slightly longer than ALB's 180 seconds). These
are bounded failure budgets, not a promise of cold-start latency. Native create
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

## Recovery

Use the explicit Shanghai kubeconfig for read-only diagnosis:

```sh
kubectl --kubeconfig "$HOME/.kube/agent-platform-config" -n sandbox-system get sandboxes
```

An ambiguous create leaves `creation_pending=true`. Do not clear it merely because
an SDK call failed, or start a replacement blindly. Reconcile exact
`oma.dev/binding`, `oma.dev/tenant` and `oma.dev/workspace` metadata against the
known request and control-plane state. Any allocated resource has finite native
expiry even if the Runner never returns. A known failed mount/projection retains
its bound ID so subsequent preparation can retry without duplicating resources.

Explicit termination uses `session_cleanup` and a committed `reclaiming` ticket.
Kill is direct by ID and deletion is confirmed through the control plane before
clearing the pointer. Network/confirmation failures leave the ticket retryable.
Shared non-terminated children and queued input prevent deleting their binding.
Saved Workspace files and history are retained.

There is no instruction to remove unknown activity records, no recurring Sandbox
scan and no rollback that reinstalls infinite lifetime.

## Verification

`verify-native-sandbox-lifecycle.mjs` and its 2026-10-10 evidence document the SDK,
Gateway and Manager versions and the isolated native platform tests. The original
strict retention gate failed; the later user-approved approximate contract accepts
that observed behavior. Retain the original observations rather than rewriting
history. See the integration report for the application changes and final checks.
