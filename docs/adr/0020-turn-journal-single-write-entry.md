# ADR-0020: One write entry per Turn attempt

## Status

Accepted for #234 (PR-A). The commit barrier landed first (b424238); the
TurnJournal module and its interface tests land in #238; the Router (#241) and
the Adapters (#242, #243) move onto it afterwards, and #244 makes it the
Adapter contract. Revises the ADR-0002 Adapter contract, the ADR-0013 commit
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
permanently: every later flush rejects with the original error. The journal
tells its owner at the first failure, and the attempt stops on the same path as
a lost lease (see "One stop path" below).

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

### The Adapter contract

`run(input)` returns `Promise<"finished" | "stopped">` and nothing else: there
is no event stream. `input.journal` is required, and the Adapter records every
Complete Event and emits every Delta through it. `"finished"` means the Adapter
is done with the Turn, including an error it recorded or an Interrupt it obeyed.
`"stopped"` is reserved for a stop the Host asks for (#254): the Adapter stopped
before the Turn finished, and the Router takes the stop path below. In PR-A both
Adapters return only `"finished"`. A rejection is an Adapter failure: unless the
Turn was aborted or the attempt stopped, the Router records `adapter_error`.

A Turn that an earlier attempt started continues with `input.resume`:
`completedModelSteps`, which count against the step budget, and `blockBase`,
the numbering base of its output blocks. Its presence is what makes Pi continue
the Turn from its history instead of prompting the input; a new Turn has none
and starts at step 0 and blockIndex 0.

### Revocation timing

The Router awaits `run()`. Once the Turn is aborted by an Interrupt it waits at
most `interruptedAdapterDrainTimeoutMs` (2 s by default), then revokes the port
and writes `turn_aborted` and `turn_completed`. Whatever the Adapter recorded
until then lands: the message the Interrupt cut short, its usage, results of
tools that stopped in time. The Router does not filter by event type; an
Adapter does not record what it does not stand behind (Pi drops the error the
Interrupt causes, and compaction checks for Interrupt before its boundary). A
tool whose cancellation outlasts the wait, or an Adapter that never settles,
cannot write after the closing events and no longer holds the Session.

A run the Router stopped waiting for has not settled. A Sandbox activity is
finished only once its runtime is observed to end (ADR-0019), so the Router
keeps observing such a run in the background.

### One stop path

A lost lease, a failed journal write, the Session's termination and a
`"stopped"` result end the attempt the same way: the port is revoked and the
Turn signal aborted at once, the heartbeat stops, no terminal event is written
and the input stays pending, for the next claim to handle by the recovery rules
in force. The Router does not wait for the Adapter. A lost lease and a failed
write are reported through `onDrainError`; `handleNewEvent` does not reject for
them. Termination stops the attempt even after an Interrupt has already fired
the Turn signal.

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
An Adapter does not record the error an Interrupt causes; the Router's
`turn_aborted` ends the Interrupted Turn.

Pi records `agent.context_start`, which claims the input for the native chain,
right before it prompts or continues the Turn. A session that fails to start has
written no native entry of the Turn, so its input remains a display message that
later Turns replay.

### Persistence components are injected by the Host

The journal works through three ports injected by the Router: a fenced,
idempotent append that returns the stored row (the Router composes Delegation
Result consumption into it), publication to the event stream hub, and Delta
output (Redis stream and hub). The Router also supplies the mapping that gives
each Adapter event its durable form and key, which is where Turn identity and
Child Session caller fields are added. The journal depends on no PostgreSQL,
Redis, claim or delegation code, and the Adapter sees none of them.

## Revised decisions

- ADR-0002 §1: the Adapter contract is no longer `run(input):
  AsyncIterable<SessionEvent>`; `run()` settles with its result and writes only
  through the injected journal (#244).
- ADR-0013 "Commit barrier and failure": the barrier covers every native
  message, not only a prepared compaction, and the Adapter commits through the
  journal port instead of `persistContext`, which standalone Adapter users no
  longer provide. Events are no longer delivered a second time through the
  Adapter's event queue or a Delegation checkpoint (#239, #244).
- ADR-0013 "Decision": `agent.context_start` is recorded right before
  prompting, no longer before SDK initialization (#242).
- ADR-0014 "Context persistence through public hooks": durability no longer
  comes from snapshots at model-request, `tool_call` and settlement boundaries.
  Extensions and AgentSession listeners still see `message_end` before Pi's
  append, but an Agent listener registered after AgentSession's own sees it
  afterwards; that awaited listener snapshots and commits each native message.
  The context journal is only this barrier (#244).
- ADR-0016: the Adapter, not the Router, aligns projected completions with their
  stream blocks. Interrupt draining under a renewed fence, which accepted only
  accounting, is replaced by the revocation timing above.

## Consequences

Each tool round and each model request waits for one more PostgreSQL round trip,
milliseconds against model latency in seconds. A lost Runner loses at most the
Deltas of the output being streamed; every native message before it is durable.
The Adapter-side event queue, checkpoint buffer and `persistContext`, the
`continuation` field, and the Router's event-stream iteration, post-Interrupt
type filter, event-count cap and alignment logic are gone (#244). After an
Interrupt the heartbeat no longer renews the claim; the drain wait is short
against the lease, and the append fence still rejects a write once the claim is
lost, which stops the attempt. A later attempt's journal publishes the
idempotent hits it meets first (the promoted input, the running status) again;
subscribers keep events by seq. A brief window where in-flight Turns are logged
behind execution during rollout is accepted.
