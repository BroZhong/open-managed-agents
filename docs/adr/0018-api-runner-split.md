# ADR-0018: Separate API ingress from Runner execution

## Status

Accepted for #197–#203. Implementation and local verification only; production
cutover is a separate operation. Extends ADR-0007, ADR-0010 and ADR-0016.
ADR-0019 supersedes the original ADR-0017-based Sandbox lifetime portion.
#234 amends how a running Turn's owner learns of an Interrupt: from its claim
renewal every renew interval, and at once on a `check` hint (below). It also
stops Runners from contending for input another Runner owns, and a synchronous
delegation wait from polling.

[ADR-0021](0021-resumed-turn.md) revises the "Release boundary": a Turn whose
Runner exits is continued by the next Runner instead of ending by the earlier
recovery rules; general Turn recovery now exists, its checkpoint being the
committed log.

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

Session thinking controls use a read-only capability endpoint on Runner's internal
HTTP service. API authenticates the Session lookup and requests managed model
metadata via `OMA_RUNNER_URL`; only supported/canonical levels are returned.
API still does not load the managed Pi catalog or receive its credentials.
Tenant model metadata is resolved lazily and without decrypting its stored key.
This metadata lookup does not create a Turn or make an inference request.
Agent creation uses the same resolver through `/v1/model-thinking-options` without
requiring a Session. BYOK previews and capability-reference lists use the SDK's
bundled, credential-free catalog on demand; this is separate from the Host's
managed catalog and never substitutes for the Tenant endpoint's discovery list.

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
next input. The scan lists only Sessions whose head no live claim holds, and a
Runner schedules a claim retry only after a failed drain or for a head it can
take (a released claim, input queued behind an Interrupt), never for a head
another Runner's live claim holds. A wake still makes every Runner try once. A
lost owner's input is listed again when its lease expires, so another Runner
takes it over within the lease plus one scan (35 s).

Delegation wakes use the same signals. A synchronous wait wakes its child once,
when the wait starts or a takeover resumes it. The child's Runner sends the
parent a `check` when the execution ends, and the parent's owner reads the
execution at once; a 2 s poll of the durable execution record covers a lost
hint. The wait does not poll ownership: a lost lease aborts the Turn, which ends
the wait. Both modes retain ADR-0010's ownership, model, budget and
result-consumption rules.

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
claim generation. The owner's claim renewal returns the marker of its own
generation, so the heartbeat needs no separate query and renews only every renew
interval (10 s of a 30 s lease). The API then publishes a `check` signal for the
Session. Every Runner receives it, and only the Turn's owner acts: it renews at
once. A `check` is not deduplicated like a wake, because a drain started from a
wake holds its Session for the whole Turn. With Redis an Interrupt therefore takes
effect within about a second, and within one renew interval without it.
Acceptance never means an external command has actually stopped, and an old
generation cannot interrupt a later one. A local AbortController is not required
on the accepting API. Delegation Interrupt commands for a child, including the
one that reconciling a terminated parent records, are hinted the same way.

Session termination revokes the queue and records a cleanup outbox request and
an idempotent `session.status_terminated` Event in the same transaction. Runners
claim cleanup rows with `FOR UPDATE SKIP LOCKED`; failed or deferred cleanup stays
pending with a retry time. Cleanup reconstructs the Sandbox from its durable
binding, coordinates child outcomes, and preserves saved Workspace files/history.
Gateway cleanup cannot block the independent pending-input scan.

Runners coordinate current business execution generations and shared queued input
under ADR-0019. Only observed settlement may shorten a resource's native deadline;
unknown execution does not request idle. There is no permanent resource activity
table or Sandbox sweeper. Native finite deadlines bound resources after Runner
loss. Explicit cleanup directly kills only when legitimate shared users are gone,
or clears a pointer after control-plane NotFound confirms native deletion. The
existing committed deletion ticket and cleanup outbox remain retryable across
Runners. Saved Workspace files and history are unaffected.

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
