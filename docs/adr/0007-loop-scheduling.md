# ADR-0007: Transactional Loop dispatch

## Status

Accepted.

## Context

A Loop periodically asks one Agent to perform the same instruction. Each
occurrence must appear as an ordinary durable Session beneath that Loop, retain
its own Workspace, survive a Host restart, and not be duplicated when several
Hosts poll the same PostgreSQL database. Timer callbacks alone cannot provide
those guarantees: a process may stop between creating the Session, recording its
first input, advancing the schedule, and waking the Session Router.

Loop Turns are also unattended. They cannot rely on a human being present to
approve an MCP tool after the schedule fires.

## Decision

### 1. A Loop owns a cadence; every occurrence creates a Session

A Loop belongs to one Tenant and one Agent and stores its name, optional
description, prompt, positive integer interval in minutes, enabled state, and
last/next run timestamps. The API currently enforces a minimum five-minute
interval.

Every occurrence creates a fresh Workspace and a fresh Session whose `loop_id`
points at the Loop. The Session still belongs to the Loop's Agent and uses the
Agent configuration captured when that occurrence is dispatched. Its title is
the Loop name and its first pending `user.message` is the Loop prompt. Loop
Sessions are nested beneath the Loop in the Agent sidebar rather than duplicated
among loose Sessions or Workspace navigation.

### 2. PostgreSQL owns the dispatch boundary

Each scheduler tick opens one transaction and selects due, enabled Loops in
`(next_run_at, id)` order using `FOR UPDATE SKIP LOCKED`. For every selected row
it re-reads the tenant-matching Agent and, in the same transaction:

1. creates the Workspace;
2. creates the Loop-linked Session;
3. inserts its pending `user.message`; and
4. sets `last_run_at` to the dispatch time and `next_run_at` to one interval
   after that time.

The transaction commits before the scheduler asks Session Router to promote the
pending input. A crash before commit leaves no partial occurrence and no cadence
advance. A crash after commit, or an ambiguous client error after the commit,
leaves a durable pending input that startup recovery or the scheduler's
every-tick recovery scan can claim. Multiple Hosts skip one another's locked
rows, so one due state cannot create competing Sessions. If an Agent was deleted,
its soft-linked Loop is disabled under the same row lock instead of failing every
later poll.

Manual `run now` dispatch locks the same Loop and creates the same durable
Workspace/Session/pending-input unit, but does not modify `last_run_at` or
`next_run_at`; it does not move the recurring cadence.

### 3. Delayed ticks coalesce

The next run is calculated from the actual dispatch time, not by repeatedly
adding intervals to a stale timestamp. If the Host is down across several
intervals, recovery creates one occurrence and schedules the next interval from
that recovery time. This avoids an unbounded catch-up burst.

### 4. Unattended capability policy is enforced outside the prompt

A Loop receives no special tool power. It can use only the Agent's normal tools,
Sandbox, Skills, and Host-managed MCP Connections. Because there is no human in
the dispatch path, mutation-capable external tools require a Host-enforced
allowlist, approval-independent authorization, or credentials whose downstream
policy makes the operation safe. A request such as "only query data" is useful
task instruction but is not an authorization boundary. ADR-0006 defines the
additional constraints for Host-resident MCP connections, including the managed
Supabase facade whose tenant is Host-bound and whose only tool executes a fixed,
bounded `SELECT` over recent Sessions and events. Its deployment credentials are
available only when that Loop's Tenant is explicitly listed in
`OMA_SUPABASE_ALLOWED_TENANTS`; a missing allowlist fails closed before dispatch
can resolve the MCP connection.

## Consequences

- PostgreSQL, not an individual Host timer, is the source of truth for due work
  and cross-Host exclusion.
- The production migration conditionally grants `oma_app` schema usage plus
  `SELECT`, `INSERT`, and `UPDATE` on `oma.loops`; it grants neither table
  deletion nor schema creation.
- Polling may start a Session up to one poll interval late, but cannot lose the
  Session/input pair after the cadence is advanced.
- A long outage produces one recovery occurrence rather than one occurrence per
  missed interval.
- Loop history is queryable through `sessions.loop_id`; each occurrence consumes
  one Workspace and one Session.
- The Session Router and pending-event recovery path remain the sole Turn
  execution mechanism; the scheduler does not invoke an Adapter directly.
