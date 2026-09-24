# Sandbox lifecycle: default activation and rollback

This is the release procedure for #172–#176 and ADR-0017. Lifecycle management
applies to every durable Sandbox binding by default.
Tests do not authorize production deployment.

## Preconditions

1. Verify the gateway/manager image digests and isolated never-timeout probe on
   the target deployment. The tested ACK gateway is v0.3.0, manager v0.6.11 and
   E2B JS SDK 2.24.0. Upstream documentation alone is insufficient evidence.
2. Before deploying the new Host binary, apply `deploy/migrations/0014_sandbox_lifecycle.sql`
   and then `deploy/migrations/0017_remove_sandbox_lifecycle_mode.sql` using the
   normal authorized database release process. Its default schema is `oma`.
   Install the trigger before running the lifecycle controller. Tables and
   columns alone are insufficient.
   Production has `PG_ENSURE_SCHEMA=false`; even disabled Hosts need the additive
   environment columns. The trigger updates only already-managed bindings.
3. Deploy the implementation to every Host that can execute a Sandbox. Mixed
   old/new Hosts must not execute these bindings: old Hosts do not record the
   new non-expiring activities. Gate their admission or drain the old Hosts;
   never kill user Sandboxes merely to switch code.
4. There is no lifecycle configuration. Every binding is managed after startup
   and the 30-second sweeper is always enabled.
5. The Manager samples every 30 seconds. Idle starts when absence of activity and
   inputs is confirmed, so reclamation can occur slightly later than 30 minutes.

## Existing resources

Use the explicit Shanghai kubeconfig for all cluster operations:

```sh
kubectl --kubeconfig "$HOME/.kube/agent-platform-config" -n sandbox-system \
  get sandboxes -o json | jq '[.items[] | {
    name: .metadata.name, uid: .metadata.uid,
    binding: .metadata.annotations["oma.dev/binding"],
    tenant: .metadata.annotations["oma.dev/tenant"],
    workspace: .metadata.annotations["oma.dev/workspace"],
    shutdownTime: .spec.shutdownTime
  }]'
```

Match PostgreSQL `delegation_environments.sandbox_id` to the E2B identity
`<namespace>--<name>`. Legacy resources may lack `oma.dev/binding`; the persisted
binding, Tenant and Workspace must agree before any modification. Warm-pool
resources without a claimed identity are not OMA orphaned executions.

Existing bindings are included automatically. No per-binding adoption is needed
in this test environment. The Runner marks all durable environment rows as
managed at startup and on each sweep; a newly created binding is included on the
next sweep as well.

For a live Sandbox that still has a gateway deadline, remove that deadline before
the next 30-minute idle window. In this environment it is acceptable to interrupt
the test workload and let the Runner recreate the Sandbox with `neverTimeout`.
Do not treat a missing Sandbox ID as a reason to retain a stale database row; the
reclamation delete is idempotent and clears the binding after the gateway call.

The lifecycle checks remain:

1. Keep all running Turns, queued inputs and unresolved executions protected by
   their activity records.
2. Let the next confirmed idle sweep start the 30-minute clock.
3. If a live Sandbox deadline must be removed in place, use a UID-checked patch
   and verify the unchanged identity. Rebuilding is also allowed for this test
   environment; the new Sandbox is created with `neverTimeout`.

The database marker is a lifecycle-controller state, not a second eligibility
allowlist. A stale Sandbox ID is safe to clear after the idempotent destroy path
returns; the Workspace remains the persistent source of files.

## Evidence and diagnostics

Inspect only lifecycle metadata, not secret environment values:

```sql
SELECT e.id, e.sandbox_id, e.idle_since, e.reclaiming,
       (SELECT count(*) FROM oma.sandbox_activities a WHERE a.binding_id=e.id) AS activities,
       (SELECT count(*) FROM oma.pending_events p JOIN oma.sessions s ON s.id=p.session_id
        WHERE COALESCE(s.delegation->>'sandboxSessionId',s.id)=e.id) AS inputs
FROM oma.delegation_environments e WHERE e.sandbox_id IS NOT NULL;
```

Success means a managed resource has no gateway deadline, stays bound throughout
running/queued/unknown work, becomes idle only after confirmed settlement, then
is deleted after a full idle period and rebuilt with saved Workspace files.
`reclaiming=true` is a committed deletion ticket, not permission to reuse that
resource. Failed database reads produce no deletion. Failed deletes retain the
ticket and are retried. Sweep failures are logged by the Host.

An unresolved activity deliberately has no expiration. To release one after a
Host loss, record concrete evidence that the exact runtime and its issued remote
operations have ended (for example, traced PID exit and completed native tool
results), then delete only that activity ID and set `idle_since=NULL` under the
same environment-row transaction. Preserve any other generation and all queued
inputs. The next confirmed idle observation starts a new full 30-minute period.
If evidence is unavailable, retain the resource indefinitely.

## Rollback

Rollback requires a new Host build. Stop the lifecycle-enabled Runner before
deploying that build and delete no user Sandbox. Keep lifecycle activity
recording and the input trigger. Do not drop lifecycle tables, remove unknown
records, or restore a finite deadline.
A committed
`reclaiming` ticket must finish its idempotent cleanup before work can resume;
never clear it merely because the deleting Host is unavailable.

The test deployment enables this policy by default. A production rollout would
still require its own deployment authorization.

## Repeatable verification

`deploy/scripts/verify-sandbox-release.mjs` runs against the deployed Host and
public API using a dedicated verification tenant. `init` creates three cold root
Sessions; select those exact IDs before releasing the Host. Run `exercise` for
real model, shared-child and independent-Sandbox checks, `inspect` for read-only
observations, then `rebuild` after 30 real idle minutes and `cleanup` after
successful acceptance. Copy the evidence out before replacing the Host and back
before continuing. Each phase revokes its temporary API key in `finally`.
If a verification process is forcibly stopped, revoke its exact run/phase key
before retrying. Failed attempts remain in the evidence.

For the current OpenAI Responses gateway, Pi 0.83 needs the selected model's
`compat.supportsStrictMode=true` so ordinary function tools explicitly send
`strict:false`. Without that compatibility setting, the SDK omits `strict` and
the upstream can turn optional tool fields such as `Agent.resume` into required
fields. This was reproduced against the live gateway by
`deploy/scripts/verify-responses-optionals.mjs`; its explicit-false case checks
that a new child call omits `resume`. The setting describes support for the
wire field, not a request to enable strict tools. Preserve all other model
settings and credentials when updating the deployment-owned model catalog.
See the [OpenAI function calling documentation](https://developers.openai.com/api/docs/guides/function-calling#strict-mode).

`deploy/scripts/verify-sandbox-lifetime.mjs` creates uniquely annotated probes and
records new creation, finite/zero lifetime controls, no-heartbeat execution,
in-place deadline removal and explicit deletion. It never selects user resources.

`deploy/scripts/verify-sandbox-idle.mts` uses a disposable PostgreSQL port-forward,
an isolated schema and a unique mounted Workspace prefix. `init` creates idle,
queued-child and unknown-execution cases, then exits. After at least 30 real
minutes, `check` starts a fresh Host-side Manager, verifies retention/reclamation
and Workspace rebuild, and records evidence. Run `cleanup` afterwards to delete
only the recorded test resources, files and schema. Retain the JSON evidence.
