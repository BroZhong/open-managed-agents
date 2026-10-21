# ADR-0020: One write entry per Turn attempt

## Status

Accepted for #234 (PR-A). The commit barrier landed first (b424238); the
TurnJournal module and its interface tests land in #238; the Router (#241) and
the Adapters (#242–#244) move onto it afterwards. Revises the ADR-0013 commit
barrier, the ADR-0014 context journal snapshot timing and the ADR-0016
Router-side alignment, as listed under "Revised decisions". Resuming a Turn
after Runner loss is left to ADR-0021 (PR-B).

## Context

The event log lagged execution. Pi pushed Complete Events into an unbounded
queue and the Router persisted them later, so a tool could run before its call
reached PostgreSQL; a Runner lost in that window left no trace of the side
effect. The barrier added in b424238 made every native message durable before
Pi proceeds, but durable writes then came from two places (the barrier and the
Router's event-stream loop), which needed a serial chain to keep publication in
seq order and relied on idempotency keys to absorb double writes. Some Router
writes appended without publishing, and the Router aligned Deltas to Complete
Events in two separate places.

## Decision

### A Turn attempt has exactly one write entry

A Turn attempt is one claim generation's execution of a Turn. After claiming the
input, the Router creates one `TurnJournal` for the attempt. Every durable event
of the attempt is recorded there: the Adapter's output, the Router's lifecycle
events (running status, preparation failures, recovery repairs, `turn_aborted`,
`turn_completed`) and the waiting/running state written by delegation
coordination. Events a store writes inside its own transaction, together with
other state (the idle event of acknowledgement, delegation table transactions),
stay with that writer, which also publishes them.

The Adapter receives the `TurnJournalPort` defined in adapter-core and depends
on nothing else for persistence:

- `record(event)` is synchronous, never throws and queues in call order. The
  event is written as it was at that call. Recording it again is a no-op.
- `delta(event, blockIndex)` emits a Delta. It is best effort, never awaited and
  never durable; its failure never affects `record` or `flush`.
- `flush()` resolves once every event recorded before the call is persisted and
  published. After any write failure, every later flush rejects.

The Router owns the journal: it records its own events with explicit
idempotency keys and can revoke the Adapter's port.

Writes happen only inside a flush. There is no background writer: a flush
writes, in order, everything recorded until it runs (group commit), and flushes
from the Adapter and the Router serialize. Each successful append is published
before the next one starts. The journal publishes only rows its own appends
returned, in ascending seq order; a returned row at or below the last published
seq is an idempotent hit on an earlier attempt's row and is not published again.

Idempotency keys come from the Router. Its own events carry explicit keys; the
Adapter's events get theirs from a Router-supplied mapping keyed by event ID.
Within a journal a repeated key is never written twice; across attempts the
event log's idempotency returns the original row.

Any append failure, including a lost claim fence, fails the journal
permanently: every later flush rejects with the original error, and the attempt
stops on the same path as a lost lease, without terminal events.

However an attempt ends, the Router revokes the Adapter's port before it records
closing events. Events recorded before revocation are written at the next flush.
Afterwards the port's `record` and `delta` are dropped and its `flush` rejects
immediately, so an Adapter that is slow to stop cannot write after
`turn_aborted` or `turn_completed`. The Router's own writes are unaffected.

Deltas leave in call order and are dropped once the port is revoked or the
journal has failed. The Adapter assigns the final blockIndex to each Delta and
to each display block of its Complete Events; the Host supplies the numbering
base (the highest blockIndex already committed in the Turn plus one, or 0 for a
new Turn).

Each flush that writes logs one JSON line, `turn_journal_flush`, with Session,
Turn, event count, bytes (UTF-8 JSON of the written event data) and the duration
the caller waited, plus the error message when it failed. Flush latency p50/p99
come from these lines.

### Every native message is committed before Pi proceeds

The Pi Adapter flushes in an awaited Agent `message_end` listener registered
after AgentSession's own. Pi awaits Agent listeners in registration order and
AgentSession's listener appends the native entry, so the entry is in the
snapshot, and the flush finishes before tools execute or the next request
starts. Tools therefore start only after the assistant entry requesting them is
durable, and the next model request only after their results and any steering
are. The model request gate also flushes, including summary requests.
Compaction checks for Interrupt before writing and flushing its boundary, which
remains the commit evidence of ADR-0013.

A failed flush stays sticky, with a fixed message that Pi neither retries nor
treats as context overflow; `prompt` and `continue` report the original error.
Every Adapter flushes before executing a tool and before each model request.

### Persistence components are injected by the Host

The journal works through three ports injected by the Router: a fenced,
idempotent append that returns the stored row (the Router composes Delegation
Result consumption into it), publication to the event stream hub, and Delta
output (Redis stream and hub). The Router also supplies the mapping that gives
each Adapter event its durable form and key, which is where Turn identity and
Child Session caller fields are added. The journal depends on no PostgreSQL,
Redis, claim or delegation code, and the Adapter sees none of them.

## Revised decisions

- ADR-0013 "Commit barrier and failure": the barrier covers every native
  message, not only a prepared compaction, and the Adapter commits through the
  journal port instead of `persistContext`, which standalone Adapter users no
  longer provide. Events are no longer delivered a second time through the
  Adapter's event queue or a Delegation checkpoint (#239, #244).
- ADR-0014 "Context persistence through public hooks": durability no longer
  comes from snapshots at model-request, `tool_call` and settlement boundaries.
  Extensions and AgentSession listeners still see `message_end` before Pi's
  append, but an Agent listener registered after AgentSession's own sees it
  afterwards; that awaited listener snapshots and commits each native message.
  After #244 the context journal is only this barrier.
- ADR-0016: the Adapter, not the Router, aligns projected completions with their
  stream blocks. Interrupt draining under a renewed fence is replaced by
  revocation of the Adapter's port.

## Consequences

Each tool round and each model request waits for one more PostgreSQL round trip,
milliseconds against model latency in seconds. A lost Runner loses at most the
Deltas of the output being streamed; every native message before it is durable.
Until #244, Adapters that still return an event stream are written by the
Router through the same journal, and an event recorded through both paths is
written and published once. The Adapter-side event queue, checkpoint buffer and
`persistContext`, and the Router's event-stream iteration, post-Interrupt type
filter and alignment logic, are then removed. A brief window where in-flight
Turns are logged behind execution during rollout is accepted.
