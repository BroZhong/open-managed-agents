# Sandbox lifecycle: controlled rollout, adoption and rollback

This is the release procedure for #172–#176 and ADR-0017. Tests do not authorize
production deployment. No production policy flag is enabled by this change.

## Preconditions

1. Verify the gateway/manager image digests and isolated never-timeout probe on
   the target deployment. The tested ACK gateway is v0.3.0, manager v0.6.11 and
   E2B JS SDK 2.24.0. Upstream documentation alone is insufficient evidence.
2. Before deploying the new Host binary, apply `deploy/migrations/0014_sandbox_lifecycle.sql` using the normal authorized
   database release process. Its default schema is `oma`. Install the trigger
   before enabling any binding. Tables and columns alone are insufficient.
   Production has `PG_ENSURE_SCHEMA=false`; even disabled Hosts need the additive
   environment columns. The trigger updates only already-managed bindings.
3. Deploy the implementation to every Host that can execute a selected binding.
   Mixed old/new Hosts must not execute those bindings: old Hosts do not record
   the new non-expiring activities. Gate their admission or drain the old Hosts;
   never kill user Sandboxes merely to switch code.
4. First select new, cold Sessions via `SANDBOX_IDLE_BINDINGS=<root-session-id>,...`.
   Children inherit protection automatically. Workspace and Agent IDs are not
   selectors, and `*` is rejected. Leave `SANDBOX_IDLE_SWEEP` unset until retention
   and the complete acceptance matrix have been verified.
5. Enable `SANDBOX_IDLE_SWEEP=true` only for the selected bindings. The Manager
   samples every 30 seconds. Idle starts when absence of activity and inputs is
   confirmed, so reclamation can occur slightly later than 30 minutes.

## Inventory and safe adoption of existing resources

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

For each explicitly authorized existing binding:

1. Record the Sandbox UID, Pod UID, existing `shutdownTime`, pending inputs,
   resource users and unresolved executions. Stop legacy lifecycle writers for
   this binding without destroying its environment. If ownership cannot be
   coordinated before its existing expiry, the release is blocked; a heartbeat
   is not the final protection mechanism.
2. Use a Kubernetes JSON patch containing a `test /metadata/uid` followed by
   `remove /spec/shutdownTime`. This removes the deadline in place. Adding the
   never-timeout **annotation** to an already-created Sandbox is not a verified
   update mechanism: that key is interpreted at E2B creation.
3. Read back the absent deadline and unchanged UID, reconnect through E2B, and
   verify the running command/Pod identity. Do not use `setTimeout(0)`: creation
   with zero selected a five-minute default in the actual gateway probe.
4. While coordinating admission, seed `sandbox_activities` for every unresolved
   pre-adoption attempt, including resource leases that expired. If an exact
   attempt cannot be reconstructed, insert a distinct operator-owned adoption
   uncertainty record. Never infer settlement from Session status or history.
5. Under the environment row lock, mark `lifecycle_managed=true` and clear
   `idle_since`. Then admit selected work through the new Host. A binding whose
   existing Sandbox has not been verified is rejected by `begin()`.

Do not rebuild a running, queued or unknown Sandbox to apply this policy. A
gateway that cannot remove the deadline in place blocks adoption of active
resources. New never-timeout Sandboxes may still be tested independently.

An ambiguous create can leave a resource whose E2B response never reached the
Host. Reconcile the durable gateway binding/Tenant/Workspace metadata with the
database under the binding lock. Preserve an uncertainty token before attaching
the verified identity. Multiple matching Sandboxes or mismatched mount metadata
require investigation; they are not candidates for automatic age-based deletion.

## Evidence and diagnostics

Inspect only lifecycle metadata, not secret environment values:

```sql
SELECT e.id, e.sandbox_id, e.lifecycle_managed, e.idle_since, e.reclaiming,
       (SELECT count(*) FROM oma.sandbox_activities a WHERE a.binding_id=e.id) AS activities,
       (SELECT count(*) FROM oma.pending_events p JOIN oma.sessions s ON s.id=p.session_id
        WHERE COALESCE(s.delegation->>'sandboxSessionId',s.id)=e.id) AS inputs
FROM oma.delegation_environments e WHERE e.lifecycle_managed;
```

Success means a selected resource has no gateway deadline, stays bound throughout
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

Set `SANDBOX_IDLE_SWEEP=false` and stop/delete no user Sandbox. Keep the selected
binding allowlist, never-timeout creation, input trigger and activity recording.
Do not drop lifecycle tables, remove unknown records, revert to a pre-lifecycle
binary on selected bindings, or restore a finite deadline. A committed
`reclaiming` ticket must finish its idempotent cleanup before work can resume;
never clear it merely because the deleting Host is unavailable.

Full production enablement remains blocked until the complete verification matrix
passes on the actual release configuration and an explicit deployment is
authorized. This implementation deliberately provides no wildcard global switch.

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
