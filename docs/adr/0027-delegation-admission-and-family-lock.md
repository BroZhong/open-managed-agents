# ADR-0027: A parent admits at most four unfinished Delegation Executions, and delegation transactions lock only their Delegation Family

## Status

Proposed 2026-11-05 for #323 (parent #322): drafted from the decisions settled
with the maintainer on 2026-11-04; awaits the maintainer's review. Implemented
by #324 (admission) and #327 (family lock).

Revises [ADR-0010](0010-durable-delegation.md) §1 (one database row lock
serializes every coordination transaction) and §2 (excess Delegation Inputs
stay queued until a slot frees). Revises [ADR-0021](0021-resumed-turn.md)
"Child executions" and its "Revised decisions" entry for ADR-0010 §2: a parent
has no execution slots any more, only a limit on what it may accept.

## Context

ADR-0010 §2 lets a parent run four children at once and queues the rest. The
limit is checked when a child's claimed input starts its Delegation Execution
(`startExecution` counts the parent's running executions). A child over the
limit releases its claim and waits for a slot (`waitingForSlot`); the execution
that ends wakes its queued siblings, and the pending scan covers a lost wake.

[ADR-0026](0026-runner-capacity-and-autoscaling.md) changes what a claim means.
A claimed Child Session must run, because its parent may be waiting for it
with no timeout: Child Sessions bypass Runner Capacity for exactly that reason.
A child claimed only to be released again breaks that, and while it waits for
a slot it is ready demand that no Runner can execute, so it scales the fleet
for nothing. Each wake and each scan claims it, counts its siblings and
releases it again.

In the 7 days to 2026-11-04 no parent had more than 3 children running at once:
the queue was never used.

ADR-0010 §1 serializes every coordination transaction, across all Tenants and
Sessions, on one row (`delegation_lock`, id `coordination`), and notes it "can be
partitioned after measuring load". Those transactions include each sandboxed
Turn's resource-use registration, so every Turn's start and end on every
Runner waits for that row, and a transaction holds it while it appends events,
whose payloads may be uploaded to OSS (ADR-0015). With 2,000 Sessions starting
at once, the row becomes the queue. The invariants it protects all concern one
parent and its children: none needs to order two unrelated parents.

## Decision

### The fifth `Agent` call is refused

A parent admits at most `SUBAGENT_MAX_CONCURRENT` (default 4) **unfinished**
Delegation Executions: accepted and not yet ended, `queued` or `running`, in
any mode and any of its Child Sessions. `Agent` counts them when it accepts the
input, in the accept transaction:

- With four unfinished, a new delegation, a background one and a `resume` alike
  create nothing and return a tool error to the model: the parent already has
  four unfinished subagents; wait for one to end (`get_subagent_result` with
  `wait=true`) and call `Agent` again. The parent's Turn continues.
- The same calling tool ID returns its existing execution and is not counted
  again, so a repeated call never becomes the fifth.
- An execution counts from its acceptance until it ends, also while its owner
  is lost: its own Session's takeover continues it (ADR-0021).

Once accepted, an execution starts as soon as a Runner claims its input.
Starting it checks no limit; nothing releases a claimed child, wakes siblings
when an execution ends, or retries a slot from the scan. `queued` now means
only that no Runner has claimed the input yet. Executions accepted under the
old queue and still `queued` at the rollout start when claimed, even if that
puts their parent above four for a while.

`SUBAGENT_MAX_CONCURRENT` keeps its default of 4. Its meaning changes from
"more are queued" to "more are refused".

### A Delegation Family is locked, nothing wider

A **Delegation Family** is a parent Session and its Child Sessions. Nested
delegation is unsupported, so the parent is the family's root; its Session ID
names the family, the same ID that names the Sandbox Binding they share.

Every coordination transaction takes a transaction-scoped PostgreSQL advisory
lock (`pg_advisory_xact_lock`) on its family as its first statement, before any
row lock, and commit or rollback releases it. The key is derived from the
schema and the family's root Session ID: production (`oma`) and test
(`oma_test`) share the database `supabase_db`, and advisory locks are
database-wide. Two families whose keys collide only wait for each other.

The family lock orders, within one family:

- accepting a Delegation Input, with its admission count and its idempotency
  by calling tool ID;
- starting and finishing an execution, and updating its effective
  configuration;
- publishing a result (the parent notification and asynchronous input that
  finishing commits) and consuming it, and marking a notification processed;
- saving and cancelling waits;
- accepting steer and Interrupt commands and applying them;
- each Turn's Sandbox resource-use registration and release, and the
  judgment whether the family's Sandbox still has users;
- reconciling executions whose Session was terminated.

A transaction finds its family before it locks, from identity that never
changes: a Child Session's creation parent, an execution's calling Session,
the calling Session of a wait or command. Reading it without the lock is safe.

No transaction waits for a second family's lock while it holds one, so family
locks cannot deadlock each other. Work over many families, the reconciliation
batch say, runs one transaction per family; were a transaction ever to need
two, it would take them in ascending key order. Taking the family lock before
any row lock keeps the order with the row locks those transactions already take.

What the global lock guaranteed within a family still holds, because each of
these concerns one family only:

- a parent never has more than four unfinished executions, also under
  concurrent `Agent` calls;
- one calling tool ID creates one Child Session and one execution;
- a result is published before it is consumed, and consumed once;
- the number of users of a shared Sandbox is right when its reclamation is
  decided.

Different families never wait for each other. Migration
`0031` drops the `delegation_lock` table, with rollback SQL that recreates it
and its `coordination` row, and schema creation no longer creates it. The
table is dropped only once no Runner of the previous release is left, and the
rollback runs before a previous release is deployed again.

## Consequences

- The model can meet a new tool error. A parent can no longer hand out five or
  more background tasks to run one after another; it waits for one and
  delegates again. No production parent needed more than three.
- A claimed child always runs, so the Router keeps no waiting-for-slot state
  and a Runner's claims are all work it executes.
- Coordination scales with the number of families instead of serializing the
  platform. Within one family it is as serial as before.
- A family's lock shows in `pg_locks` as an `advisory` lock while a transaction
  holds it.

## Rejected alternatives

- **Keep the queue and exempt it from Runner Capacity.** Released children
  would still churn through claims and count as demand that cannot run.
- **Lock the parent's `sessions` row.** Ingress, acknowledgement and
  termination already lock that row; coordination would contend with every
  message the parent receives.
- **Per-Tenant locks.** A Tenant's Sessions are independent families as well;
  one Tenant submitting 2,000 Sessions would still serialize on one lock.
