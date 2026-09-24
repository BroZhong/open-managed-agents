# ADR-0018: Separate API ingress from Runner execution

## Status

Accepted for #197–#203. Implementation and local verification only; production
cutover is a separate operation. Extends ADR-0007, ADR-0010, ADR-0016 and ADR-0017.

## Decision

The same server image exposes `src/api-server.ts` and `src/runner-server.ts`.
`src/index.ts` and `src/dev-server.ts` retain the combined role as a migration
bridge. All three use the same infrastructure assembly. API startup does not
load SessionRouter, Pi, CLI adapters, Sandbox clients, Kubernetes Sandbox Secrets,
Loop timers or reclamation timers. Runner owns those execution dependencies.
Web remains a separate application and Deployment.

Tenant-owned provider configuration adds on-demand Pi discovery/connection probes
to authenticated API requests. They do not start Sessions or load the managed Pi
catalog; SDK loading remains lazy. API and Runner share only the provider-record
encryption key for this feature, while Turn execution remains Runner-owned.

PostgreSQL owns accepted input, FIFO claims, leases and generations, execution
and delegation state, Loop dispatch, Complete Events and termination cleanup.
Only a committed ingress transaction authorizes HTTP acceptance. A Runner always
claims from PG, including when a wake arrives. No Redis pending queue is used.

Redis owns temporary Turn streams and active-Turn projections, and carries
best-effort Session signals. A durable signal contains only the Session ID;
receiving APIs read the ordered authoritative PG log. Delta signals carry transient
content and the original Turn, block and Redis entry identity. There is no second
durable history. The process-local hub only fans out a received Redis signal to
that API's sockets; it is never a cross-process fallback.

Runner subscribes to wake hints and independently scans PG every five seconds
(`PENDING_SCAN_INTERVAL_MS`). Loop dispatch retains its own fifteen-second timer
(`LOOP_POLL_INTERVAL_MS`). A Session's existing drainer immediately consumes its
next input. Delegation wakes use the same signals; synchronous waits also poll
the durable execution record. Both modes retain ADR-0010's ownership, model,
budget and result-consumption rules.

An API subscribes before replay, then follows the durable sequence cursor.
Catch-up queries are shared per watched Session, bounded to ten pages of 1,000
canonical rows per tick, and run every two seconds (`SSE_CATCHUP_INTERVAL_MS`),
also on durable signals. Complete Events are projected using ADR-0016. Durable
sequences and per-Turn Delta IDs are deduplicated, and completed blocks/Turns
reject late Deltas. Disconnecting the last subscriber stops its catch-up timer.
Auth, Tenant/Session isolation and the share SSE prohibition are unchanged.

Redis connection/command failures do not abort execution or fail already committed
acceptance. Offline commands are not buffered; a command times out after 250 ms.
A reconnect resubscribes automatically. During an outage, PG scanning executes
work and PG catch-up delivers complete answers, errors and lifecycle events to
already-open pages. Missing transient Deltas are not reconstructed. Redis is
not a readiness prerequisite. PG failures do not count as accepted input.

Interrupt ingress writes the existing PG marker for the current FIFO input and
claim generation. The owner observes it on its heartbeat. Acceptance never means
an external command has actually stopped, and an old generation cannot interrupt
a later one. A local AbortController is not required on the accepting API.

Session termination revokes the queue and records a cleanup outbox request and
an idempotent `session.status_terminated` Event in the same transaction. Runners
claim cleanup rows with `FOR UPDATE SKIP LOCKED`; failed or deferred cleanup stays
pending with a retry time. Cleanup reconstructs the Sandbox from its durable
binding, coordinates child outcomes, and preserves saved Workspace files/history.
Gateway cleanup cannot block the independent pending-input scan.

Runners record actual Sandbox execution activities for termination safety even
outside the controlled idle-reclamation allowlist. These records do **not** adopt
a legacy Sandbox, set never-timeout, or enable idle sweeping. Only observed
execution settlement releases them; owner expiry and termination do not. Cleanup
checks resource users and these activities, retains unknown execution indefinitely,
and rechecks whether disposal actually cleared the binding before completing its
outbox request. Managed bindings still use ADR-0017's committed deletion tickets.

## Release boundary

Migration 0015 is additive and precedes either new role. Protocol-v1 combined,
API and Runner commands from this implementation can overlap. Pre-split Hosts
lack cross-process notifications and cleanup discovery and are not a supported
mixed rolling fleet. First prepare a compatible combined bridge release, then
move ingress and execution separately. Ordinary Turn restart recovery remains
bounded by the existing recovery rules; this decision does not introduce graceful
pause-at-next-input, general Turn checkpoint recovery or automatic scaling.

See [operations and cutover](../api-runner-operations.md) and
[local verification](../verification/api-runner-split.md).
