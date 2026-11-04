# ADR-0026: Each Runner admits at most N executing Turns, and KEDA sizes the Runner fleet to the demand

## Status

Proposed 2026-11-05 for #323 (parent #322): drafted from the decisions settled
with the maintainer on 2026-11-04; awaits the maintainer's review. Implemented
by #325, #326, #328–#332 and accepted on oma-test by #333.

Supplements [ADR-0021](0021-resumed-turn.md) "A Runner that shuts down hands its
Turns over": a scale-down is a handoff, with the deadlines below instead of
20 s of 30 s, and a Turn that only waits for synchronous delegations is handed
over when the handoff starts. Revises [ADR-0023](0023-sandbox-binding-reconciliation.md)
"The sweeper" ("Every Runner runs a sweeper … There is no lock between
Runners") and reopens its rejected alternative "One sweeper per environment
behind a PG advisory lock". [ADR-0027](0027-delegation-admission-and-family-lock.md)
removes the waiting-for-slot queue this ADR's claim rules would otherwise have
to account for.

## Context

The goal is 2,000 new Sessions submitted within a short time, each sending its
first message at once, on a Runner fleet that keeps only a few Runners in quiet
hours, grows for the burst, and shrinks without interrupting an Agent.

Runners are competing consumers of one PostgreSQL queue (ADR-0018): each claims
the head of a Session's pending input under a lease, woken by a Redis signal
broadcast to every Runner, and a 5-second scan covers a lost wake. Nothing
bounds what one Runner takes. Facts, 2026-11-04:

- Claims skew. In the 11-04 load test two Runners claimed 151 and 49 of the
  burst, in a second run 289 and 111. The broadcast wake and the scan of every
  claimable head let the Runners already running take the whole burst; a Runner
  added later finds nothing left to claim. Adding Runners adds no capacity
  unless a Runner stops claiming before it is overloaded.
- A claim waits for the head's row lock (`FOR UPDATE`). With N Runners woken
  for one Session, N − 1 queue behind the winner's transaction and then find
  its live lease.
- Production ran 5 Runners (2 vCPU, 8 GiB) with a 30-second termination grace
  period, of which `SHUTDOWN_GRACE_MS` gives the handoff 20 s.
- Over the 7 days to 11-04: bash took p99 181 s, p99.9 942 s, at most 3,605 s;
  137 calls asked for a timeout above 2,400 s, the largest 5,500 s (the default
  is 40 minutes, the Host ceiling 3 hours). A model request took p99 62 s. A
  synchronous `Agent` wait took p99 782 s. At most 141 Turns were live at once:
  98 running and 63 waiting synchronously for a child. No parent had more than
  3 children running at once. RDS served about 92 connections of a
  `max_connections` of 3,220; each Runner held 2–4 of its pool of 30.
- A parent's synchronous wait (`waitForResult`) has no timeout: it polls every
  2 s until its child ends, and holds the parent's claim in the Runner process
  meanwhile. Nested delegation is unsupported, so a child never waits.
- ack-keda 2.21.0, the KEDA release whose compatibility table covers Kubernetes
  1.36, is installed in `kube-system` of agent-platform, watching `oma-test`
  and `oma-infra`. ACS honoured a 50-minute termination grace period in a
  throwaway Pod on oma-test (2026-11-04: Terminating for 46 minutes, exit 0).
  Once a Pod is being deleted ACS stops its liveness probe, as upstream
  Kubernetes does, and keeps running its readiness probe.

## Decision

### Runner Capacity

A Runner executes at most **N** Turns at once: `RUNNER_CAPACITY`, an integer of
at least 1, default 50. A Runner configured with any other value refuses to
start.

- **Only executing Turns count.** A Turn counts from its claim until its input
  is acknowledged or released. While every tool call it has in flight is a
  synchronous delegation wait (`Agent` with `run_in_background=false`, or
  `get_subagent_result` with `wait=true`), it does not count. When its wait
  ends it counts again and continues, also when that takes the Runner above
  N: a Turn is never stopped or refused to bring the count back. A Turn with a
  wait and any other call in flight, a bash beside the wait say, counts.
  There is no second limit on the Turns a Runner holds, waiting or not.
- **Top-level Sessions are admitted below N.** A Runner claims the input of a
  Session that is not a Child Session only while it executes fewer than N
  Turns. It reserves the place before the claim and returns it when the claim
  takes nothing.
- **Child Sessions are always claimed, and count.** A Child Session's input is
  claimed whatever the count. Its parent may be waiting for it with no
  timeout, holding its own claim; were children admitted only below N, Runners
  full of waiting parents would admit none of the children that end the waits,
  and at the fleet's maximum nothing would ever move. A parent has at most four
  unfinished children ([ADR-0027](0027-delegation-admission-and-family-lock.md)),
  which bounds how far children take a Runner above N.
- **A full Runner ignores wakes** for top-level input, and its scan claims no
  top-level head. Another Runner, or one KEDA adds, takes them. The moment a
  place frees, the Runner claims the next top-level head itself, without
  waiting for its scan.

### Claiming never waits for a lock

A claim takes the head of one Session's pending input, the earliest Queued
Input, or nothing:

- It locks the head without waiting. A head another transaction has locked is
  skipped: the claim takes nothing, returns its reserved place and schedules no
  retry. It then judges the lease of the row it locked, as before: lock first,
  then compare `claim_expires_at` with the clock, so no lease predicate is
  evaluated before a lock wait.
- It never claims past the head. A skipped head does not let the claim take
  the Session's second input, which would run it out of order.
- The scan lists the claimable heads in arrival order and claims them in that
  order, top-level heads only while a place is free.

Skipping loses no input, because whoever holds the head's lock deals with it:

- the head's current owner holds it: the head is that owner's to run;
- a Runner handing the Turn over holds it while it releases the claim, and
  wakes every Runner once it has released it (ADR-0021);
- another Runner's claim transaction holds it: it commits a live lease, and
  the head is that Runner's; or it rolls back, and the next scan finds the
  head claimable.

Of the Runners one wake reaches, each that does not win makes one claim
attempt and waits for no lock.

### What a Runner reports

A Runner's claim owner id is `${POD_NAME}_${random suffix}`, `POD_NAME` from the
Kubernetes downward API. The claims each Pod holds can be read from
`pending_events.claim_owner`, and the suffix keeps a restarted container apart
from the one before it, whose leases may still be live. Each Runner
periodically logs one structured line with its executing Turns and free places.

### Demand and autoscaling

KEDA scales the `oma-runner` Deployment through a ScaledObject whose trigger is
the Metrics API scaler, reading the API's internal demand endpoint:

- **Demand** D = executing + ready. *Executing* counts the Sessions whose head
  holds a live lease and is not in a synchronous delegation wait, Child
  Sessions included. *Ready* counts the Sessions whose head holds no live
  lease, Sessions with several inputs once, terminated Sessions not at all.
  *Sync waiting*, a live head with a `delegation_waits` row of status
  `waiting` for that input, is reported but is not demand: it holds no place.
  The database does not record the Turn's other in-flight calls, so a Turn
  that waits while it also runs another tool (bash beside an `Agent` call)
  counts as sync waiting although its Runner counts it as executing: a small
  under-count accepted for a demand read in one statement, which the place
  between C and N absorbs.
  `sessions.status` is not used; it does not say whether a Turn is running.
- **Target** C = 40 per Runner, below N = 50: the place between them absorbs
  claim skew and the children that bypass N. Replicas = ⌈D / C⌉, at least 2,
  at most 50. A render test asserts C < N for every environment.
- **Scale-up** adds at most 10 Pods per 15 s, with no stabilization window.
- **Scale-down** waits for a 600-second stabilization window and removes at
  most 2 Pods per minute.
- **Fallback.** With `failureThreshold: 3`, KEDA uses its fallback once more
  than 3 consecutive metric queries have failed, with behaviour
  `currentReplicasIfHigher` and fallback replicas equal to the minimum. Before
  that the HPA has no metric and keeps the replicas it has, so an unreadable
  demand never scales the fleet in.

The endpoint is `GET /internal/runner-demand` on the API process, registered
outside `API_BASE_PATH`. The public Ingress routes only `/api` to the API, so
the endpoint is reachable only inside the cluster. It requires
`Authorization: Bearer <RUNNER_DEMAND_TOKEN>` (Secret `oma-runner-demand`, key
`token`; the Secret is shared with KEDA's TriggerAuthentication), and with no
token configured it is not served. The token is read trimmed of surrounding
whitespace; one a Bearer header cannot carry is logged and not served, and
the API starts regardless. It answers
`{ demand, executing, syncWaiting, ready, observedAt }` from a query run for
each request, never cached, with a 5-second database timeout. A failed query
answers 503 and never 0: a 0 would read as no demand and scale the fleet to its
minimum. Each environment counts only its own schema. A single API replica is
acceptable: while it is down every query fails, and the fallback holds the
fleet.

### Scaling down is a handoff, one Pod at a time

A Pod KEDA removes receives SIGTERM and hands its Turns over as ADR-0021
describes. There is no coordinator that waits for the whole fleet to be idle,
and no pool of Runners outside the Deployment. Which Pod goes is the
ReplicaSet's choice; `controller.kubernetes.io/pod-deletion-cost` is not used.

- `SHUTDOWN_GRACE_MS` is 45 minutes (2,700,000 ms) and
  `terminationGracePeriodSeconds` 45 minutes + 60 s (2,760): the 60 s are for
  releasing the claims the deadline leaves and for exiting. The 40-minute
  default bash timeout ends within the deadline, so a default bash finishes and
  its result is committed before the Turn moves.
- When the handoff starts, a Turn whose in-flight calls are all synchronous
  delegation waits is handed over at once: its claim is released, the other
  Runners are woken, and the one that claims it waits for the same child from
  the durable wait record (ADR-0010 §4) and consumes its result. A Turn with
  other calls in flight moves at its next model request, as before.
- A bash the model asked to run longer than the deadline is accepted as
  lost: at the deadline its Turn is detached, its outcome is reported as
  unknown to the next owner, and its process keeps running in the Sandbox. The
  timeout the model asked for is not shortened.
- Liveness stops when the Pod is deleted, so a long handoff is not restarted.
  `server.close()` fails the Runner's `/health` from the start of the shutdown,
  which matters only for probes that still run.

### One Runner sweeps

Each sweeper period, one Runner runs the SandboxSweeper (ADR-0023): the one
holding a PostgreSQL advisory lock whose key names the schema, because
production (`oma`) and test (`oma_test`) share the database `supabase_db` and
advisory locks are database-wide. When that Runner stops, by shutdown or by
losing its connection, the lock is released, and in the next period another
Runner takes it and sweeps. With up to 50 Runners, a sweeper on every one would
list the gateway and read every binding 50 times a period.

ADR-0023's objection to this lock stands as a constraint: the connection that
holds it must never be one the round's own queries wait behind in the same
pool, the pattern of the 2026-10-14 Runner pool deadlock. Its other point also
stands: correctness does not need exclusivity. Each action is still decided
under its binding's row lock just before it is taken, and the lock only keeps
the rounds from multiplying.

### Operation

- The base `oma-runner` Deployment declares no `replicas`. The production
  overlay pins its replica count until production has a ScaledObject.
  Removing the field from a manifest `kubectl apply` already applied would
  reset the replicas to 1 through `last-applied-configuration`; the release
  procedure in `deploy/README.md` handles it.
- Rolling updates use `maxSurge: 25%`, `maxUnavailable: 0`: an old Runner
  begins its handoff only once its replacement is ready. With the long
  deadline a rollout keeps old Pods Terminating while their tools finish.
- `PG_POOL_MAX` stays 30: 50 Runners could open 1,500 connections of 3,220,
  and use 2–4 each.
- Manual intervention changes only the ScaledObject: its `minReplicaCount` and
  `maxReplicaCount`, or the annotations `autoscaling.keda.sh/paused-replicas`
  and `autoscaling.keda.sh/paused-scale-in`. Never `kubectl scale` or the
  console's replica count: the HPA overrides them.
- KEDA's installation values and runbook live in `deploy/keda/`.
- The rollout has three phases: ① Runner Capacity and the other code ship to
  production with fixed replicas; ② KEDA drives oma-test, accepted by the
  matrix V1–V14 of #322 and a 2,000-Session load test; ③ production gets its
  ScaledObject. PR-1 holds the code and the manifests, PR-2 only the production
  ScaledObject. Each production change is approved on its own.

### Not decided here

Scaling the Warm Pool or the API, an advance-reservation API, cron
pre-scaling, a RunnerPool, the RDS whitelist (unchanged) and the value of
`SUBAGENT_MAX_CONCURRENT` (stays 4). Alerts (#336) and two transactions that
hold locks across slow work (#337, #338) are separate issues.

## Consequences

- A burst queues instead of piling onto the Runners that happen to be up: each
  takes up to N top-level Turns, the rest stay ready in arrival order, and the
  demand they add scales the fleet out. A new Runner takes ready work as soon
  as it starts its scan.
- A Runner can execute more than N Turns: children it claimed while full, and
  waiting parents that resumed. Both are bounded, by four children per parent
  and by the Turns it holds.
- A waiting parent costs a Runner memory but no place. #333 measures that
  memory; nothing limits it.
- A Turn a Terminating Runner still finishes counts in the demand while its
  Pod no longer counts in the Deployment, so the fleet runs a little above
  ⌈D / C⌉ during scale-down and rollouts.
- A scale-down or rollout can keep a Pod for 46 minutes. Each costs a Turn
  at most a repeated model request, or the result of a bash longer than 45
  minutes.
- An unclaimed head locked by a claim that rolled back waits for the next scan,
  up to 5 s, instead of being retried at once.

## Rejected alternatives

- **Scale down only once the whole fleet is idle.** The ADR-0021 handoff already
  makes removing a busy Pod safe; the gap was its 20-second deadline, not the
  mechanism. An idle fleet rarely occurs under steady load.
- **A cap on the Turns a Runner holds, waiting ones included.** Waits have no
  timeout, so at the fleet's maximum parents would hold every place their
  children need: a deadlock, not a slowdown.
- **A RunnerPool or pod-deletion-cost to choose the Pod that goes.** The handoff
  makes any Pod safe to remove, and the cost annotations would need updating on
  every claim.
- **KEDA's PostgreSQL scaler on a SQL view.** KEDA, in `kube-system`, would
  hold each environment's database credentials and reach RDS, whose whitelist
  this change leaves alone. The API already has both, and the definition of
  demand stays in application code next to the claim rules it mirrors.
