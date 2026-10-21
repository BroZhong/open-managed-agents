# ADR-0021: A lost Runner's Turn continues on another Runner

## Status

Accepted for #234 (PR-B). #248 lands the resume rows of the plan, outcome-unknown
results, the takeover marker and the crash-injection tests. #249 (an Interrupt
the lost Runner accepted), #250 (the takeover limit), #251 (delegation tool
results), #252 (Child executions), #253 (the Turn's original model and
thinking) and #254 (shutdown handoff) complete it.

Supersedes ADR-0010 §7. Revises ADR-0010 §4, ADR-0013 ("without adding
automatic recovery of uncertain executions"), ADR-0014 "Structured
continuation", ADR-0016 on Host-generated results, ADR-0018 "Release boundary"
("does not introduce ... general Turn checkpoint recovery") and ADR-0020 "One
stop path", as listed under "Revised decisions".

## Context

A Runner can disappear in the middle of a Turn: OOM, kill -9, a liveness
restart, a deployment. Until now its Turn ended on the next claim with
`recovery_partial_turn_aborted`, or, beside a resumed delegation wait, with
`recovery_required`: the Host did not know what had happened after the last
row it wrote. ADR-0020 removed that ignorance. Every native message is
committed before Pi runs a tool or sends the next request, so the log is an
exact prefix of the Turn. What a lost Runner can leave uncertain is narrow: the
model output being streamed (Deltas, never durable) and the outcome of tool
calls whose results were not committed.

## Decision

### A Turn is not bound to one Runner

A claim whose predecessor expired (the Runner holding it was lost) or was
released (a handoff, a Turn left waiting) takes the input's Turn over and
continues it as a **Resumed Turn**. It is the same Turn: its turnId is the one
the first attempt named (#247), its input is not prompted again once Pi
committed it, its model steps are counted from the log and its output blocks
are numbered after the committed ones (`resume.completedModelSteps`,
`resume.blockBase`). Committed work is never executed again.

### The plan

`planResume` decides, without I/O, from the events after the promoted input,
the Turn's delegation waits, the claim and, for a Child Session, its execution.
The first row that applies decides:

1. `session.turn_completed` is committed: acknowledge the input.
2. The Child execution the input runs has ended: complete the Turn. One that
   still runs is this claim's now and continues like any Turn (#252, "Child
   executions" below).
3. The log ends the Turn (`session.status_idle`, `session.error`,
   `session.turn_aborted`): repair the dangling calls and complete it.
4. An earlier generation accepted an Interrupt that never took effect, or the
   parent asked to stop the Child execution before this claim: end the Turn as
   an **Interrupted Turn** (#249, #252).
5. This claim is the fourth expired takeover since the Turn last committed
   progress: repair the dangling calls, record `recovery_limit_exceeded`, stop
   the synchronous children and complete the Turn (#250, "The takeover limit"
   below).
6. The Turn waits on synchronous delegations: resume the waits, give every
   other dangling call an outcome-unknown result, continue.
7. The input is not in the Turn's native history yet (Pi claims it with
   `agent.context_start` and commits it as its user message): prompt it again in
   the same Turn, on top of what the Turn committed (a compaction, say).
8. The Turn's last message is the Agent's final answer (an assistant message
   that requests no tool and whose request did not fail): complete the Turn
   without a model request.
9. Otherwise (the input, a tool call, a tool result, steering, a failed or
   aborted request): give each dangling call an outcome-unknown result and
   continue.

There are no other rows: an ordinary Turn is never ended because it was taken
over, unless it keeps losing its Runner without progress (row 5). A
compaction boundary is not a message. Pi compacts after a final answer
(threshold) and after a failed request (overflow), and the message before the
boundary says which: the first completes, the second continues on the
compacted context. A runtime without a native chain (the mock) commits display
rows, which classify the same way.

### Outcome unknown, never rerun

A dangling call gets an `isError` tool result whose text is:

> The agent runtime restarted while this tool call was in progress, so its
> outcome is unknown. It may not have run, may have partially completed, or may
> have finished, and a process it started may still be running. Inspect the
> current state before deciding whether to retry. Do not assume it succeeded.

No tool is rerun automatically. The Agent decides whether to repeat the call;
a repeated side effect is accepted, and business operations stay idempotent.
A process the lost Runner started is not killed in this phase. The Router
writes the result as the display row of the call's kind (an MCP call keeps its
`serverName`) under one key per call, so a takeover lost while writing repairs
leaves the next one only the rest. Pi replays it as the call's toolResult.

The result comes from a resolver registered for the call's tool when there is
one: the delegation tools answer from their durable records (#251), and a
Sandbox execution ledger could later answer bash. The plan knows no tool. The
dangling calls of an Interrupted Turn keep the Interrupt's text instead.

### Delegation calls answer from their records

Told that an `Agent` call's outcome is unknown, the Agent delegates again under
a new tool call id, which the (calling Turn, tool use) idempotency key of
ADR-0010 cannot recognise: a second child doing the same work. So a dangling
delegation call is answered with what the tool would have returned, read from
the record the call left (#251):

- `Agent`: the Delegation Execution accepted for the call, with its Child
  Session and current status. A synchronous call's wait is accepted with it,
  so it resumes instead and the resolver never answers it beside the wait.
- `get_subagent_result`: the selected execution as it is now. A call that
  recorded its wait (to wait, or to consume an ended execution's result)
  resumes that wait instead. One lost before it recorded one reads the current
  status, whether or not it asked to wait; the Agent can ask again. It
  consumes nothing, so an asynchronous result is still delivered later.
- `steer_subagent`: the command the call issued, with the status it reached
  (`accepted`, `applied` or `not_applied`).

A call that left no record (the Runner was lost before the delegation store
accepted it) is of unknown outcome like any other. The resolvers only read,
and only on a takeover, through the delegation store's indexed lookups.

### The takeover marker

Each takeover records `session.turn_resumed { turnId, generation, reason,
danglingToolUseIds }` before anything else it writes for the Turn, once per
generation; a lost takeover's marker stays and the next takeover adds its own.
`reason` is the claim's previous state, `expired` or `released`, which the
claim reports: PostgreSQL reads the previous owner from the row the claim
already locks, so it costs no statement. `danglingToolUseIds` lists every call
of the Turn that had no result when it moved, delegation waits included. The
conversation view leaves the marker out; the trace lists it. The takeover
limit counts the `expired` markers.

### The takeover limit

A Turn that loses its Runner at the same point every time, a request whose
answer exhausts the Runner's memory say, would take the Runners down one after
another. The plan therefore counts the Turn's expired takeovers since it last
made progress, this claim's included, from the markers and the claim; when
this claim is the fourth, the Turn ends instead of being continued once more.

- Progress is a native message that moves the Turn on: a tool result, or an
  assistant message whose request did not fail. A failed or aborted request, a
  compaction boundary, steering and the results a takeover writes for dangling
  calls are none: a Turn whose every attempt fails its request and loses its
  Runner is the case the limit exists for. Progress resets the count, so a
  long Turn survives any number of losses that each let it commit something.
- Only `expired` takeovers count. A released claim (a handoff, a Turn left
  waiting for a delegation or a slot) proves its Runner was not lost to the
  Turn: it neither counts nor resets the count.
- A stop after a failed write counts. The stop path (ADR-0020) does not
  release the attempt's claim, whose lease then lapses, so the next claim
  reports it `expired`. A write the event log refuses every time, a row
  PostgreSQL cannot store, thus ends the Turn like a Runner lost every time.
- A takeover lost before it recorded its marker is not counted: the count is
  the log's.

The Turn ends like a Turn whose log ends it: every dangling call gets its
result (delegation tools from their records), `session.error` records
`recovery_limit_exceeded`, the synchronous children it waits on are
interrupted, and the input is acknowledged, so queued input runs next. A
takeover lost while it writes these leaves the rest to the next claim: by row
3 once the error is written, by this row before. A Child execution that ends
this way gives its parent a `recovery_required` result, whose reason is the
error's message. The limit outranks a resumed wait: a parent whose Runner is
lost four times while it waits on a child ends its Turn.

### Child executions

A Child Session's Turn is resumed like any other (#252). Starting the
Delegation Execution under a claim that takes its input over makes that claim
its owner: the execution keeps running, takes the claim's owner and
generation, and names the Turn the takeover continues, the one an earlier
attempt named or, when none named it in the log, this attempt's. It keeps the
configuration its first attempt recorded and the slot of the parent's
concurrency limit it occupies. A running execution holds its slot until it
ends, also while its owner is lost: a queued sibling does not start in its
slot before its own Session's takeover continues it, and counting the running
siblings reads no claim. The step budget counts the steps the log records, as
every Turn's model steps do, so the count continues across takeovers; a step
recorded right before a loss counts though its request may not have reached
the model. The parent's synchronous wait receives the execution's outcome
when the takeover completes the child's Turn.

The parent stops a synchronous child with an Interrupt command, which the
child's owner applies on its heartbeat. A command accepted before the child's
takeover, or one its lost owner applied without the Turn stopping, never took
effect. Starting the execution on a takeover reads its commands; when one is
there, the takeover applies it (`session.interrupt_requested`, after its
marker) and ends the Turn as an Interrupted Turn without a model request
(row 4). A first start reads no commands: an execution that never ran had no
owner to miss one.

Starting an execution no longer ends it as `recovery_required` ("execution
lease expired; external tool effects may be uncertain"), nor its running
siblings whose owner was lost. The parent sees `recovery_required` only for a
Child execution the takeover limit ends.

### Continuing in Pi

The Adapter is handed every committed event but the input itself, and
`resume` when the plan continues. Pi continues through the `oma.continuation`
control message (ADR-0014), which makes one request from the committed context
under Pi's own retry and compaction. Pi refuses to continue from an assistant
message and the provider requires a result for every tool call, which is why
every dangling call is answered first and a final answer is not continued.

A resumed Turn can end in the failed request the lost attempt committed. When
the resumed attempt's own request fails as well, Pi's retry and overflow
recovery drop one failed request before they continue and then refuse the one
left. The Adapter drops every trailing failed or aborted request from the
agent's context before Pi continues; such requests never reach the provider,
and the session tree, so the durable history, keeps them.

The lost attempt's Deltas carry its attempt; consoles keep the highest attempt
of a Turn (#246), and the Turn's Delta stream is deleted only when the Turn
completes (#247).

### The Turn's model and thinking

Pi names the model (`provider/id`) and thinking level it resolved for an
attempt in `agent.context_start`, which it writes when it claims the input,
before its first model request. The plan runs every later attempt with the
ones the Turn's first `agent.context_start` names (`RunPlan.config`): the
Router hands the model as the Agent's and the level as the execution's
thinking. Editing the Agent's model or the Session's thinking mid-Turn
therefore changes only later Turns, as changing thinking always did, whether
the takeover continues the Turn or prompts its input again. A delegation
wait's configuration (ADR-0010) and a Child execution's own model and thinking
keep precedence. Everything else is assembled from the configuration current
when the attempt starts: the system prompt, Agent Files, Skills, MCP servers
and tools. A Turn whose input no attempt claimed yet made no model request, so
it starts with the current configuration.

### What a loss costs

The Deltas being streamed and the model request in flight: the takeover asks
again. Tool results that were not committed: reported as unknown. Pi 0.83 runs
a message's tool calls in parallel and appends their results only after every
call of the batch has finished, so a Runner lost while one call of a batch runs
reports every call of the batch as unknown, including those that had finished.

### A Runner that shuts down hands its Turns over

On SIGTERM (a rollout, a scale-down) a Runner hands its running Turns to the
other Runners instead of draining them (#254), within the grace period it
already had (20 s, of Kubernetes' 30 s):

1. It claims nothing more. The pending scan stops, wakes are ignored, its claim
   retries are cancelled and a drain takes no next input. A claim it took as
   the shutdown began is released once its takeover marker is written, before
   any Sandbox preparation. Check hints still reach the Turns it runs.
2. It asks each running Adapter to stop (`AdapterInput.stopRequest`). Pi stops
   only at its model request gate, once the gate's flush has made everything
   it recorded durable; never at `message_end`, where the results of parallel
   tools still running could not be committed yet, and never by cancelling
   anything. A running tool finishes and its result is committed; a request
   in flight completes, and an answer that ends the Turn completes it on this
   Runner. At the gate Pi aborts the request it was about to send, so it
   neither retries nor compacts, records nothing more and returns
   `"stopped"`. Summary requests pass the same gate: a compaction not started
   yet is left to a later attempt.
3. At the deadline a Turn still running is detached on the one stop path
   (ADR-0020): its write entry is revoked and its Turn signal aborted. Its
   executor refuses the SIGTERM Pi then sends the tool wrapper, so the
   Sandbox process keeps running, and the next owner reports the call as of
   unknown outcome. A synchronous delegation wait is detached the same way and
   resumes on the next owner.
4. Every claim a handoff leaves is released, never left to expire, and no
   terminal event is written. The other Runners are woken (`wake`) and the
   first to claim takes the Turn over at once, marked `released`; the
   takeover limit (#250) does not count it. A Turn that completed during the
   shutdown leaves the input queued behind it to them the same way.

A handoff costs a Turn nothing it committed: the next owner continues from the
log as after any takeover. The Runner holds a claim only while the Turn still
runs on it, so the Turn moves when it reaches its next request gate, or at the
deadline at the latest, not a lease after the process exits. Releasing the
claims of detached Turns may take up to 5 s of the 10 s Kubernetes reserves.
A Runner killed before it released keeps its claims until their lease
expires, as a lost Runner does.

## Verification

The crash-injection tests (`server/packages/api/test/crash-injection`) run a
Session through real Routers, the real Pi SDK, a scripted model and scripted
Sandbox tools over one in-memory store. A Runner is lost as kill -9 loses it:
right after its Nth durable write, everything it awaits from then on never
settles and its claim lapses; the next Runner takes over from its pending scan.
A sweep loses the Runner after each write of a scenario and checks the
assertions of every resumed Turn: each input completes once, in its original
Turn and in order; no recovery error but the takeover limit's, where a
scenario expects it; one result per call; outcome unknown exactly for the
calls a lost Runner left dangling; no tool runs twice; model steps continue
from the log; one marker per takeover with its reason and dangling calls; no
row written by a lost Runner. A scenario can also make the event log refuse a
write. The takeover limit is tested
on a Turn that loses its Runner at the same point every time, and on losses
between which the Turn makes progress, handoffs and refused writes. Later
tickets add their scenarios to the same harness.

The harness shuts a Runner down as SIGTERM does (#254): the Router's handoff
runs, and the process exits once it is done. A handoff sweep shuts the first
Runner down after each write of a scenario; scenarios shut it down while a
tool runs, past the deadline of one, while the model streams, while parallel
tools run with input queued behind the Turn, once per Runner of a rolling
restart, before a new owner is lost, and, for the takeover limit, as a Runner
takes the Turn over. A handoff's marker says `released`, and only a deadline
leaves calls of unknown outcome.

A delegation scenario runs its Child Sessions on their parent's Runner, so a
loss loses both, or on Runners of their own, and every Session's log meets
the assertions (#252). Sweeps lose the child's Runner while the parent's waits
on, the parent's while the child runs on, and the one both run on, after each
of their writes; the cases add a parent lost after its child completed, a
child steered right before its loss, two children sharing one slot, a child's
step budget across takeovers, a parent interrupted while its child's Runner
is lost, a poison child, and a child's Runner shut down. Session Router tests run
several Routers over one store, waking each other as the Redis signal does,
for the same cases, a synchronous delegation wait and Runners racing for a
released claim.

## Consequences

`recovery_partial_turn_aborted`, the `recovery_required` of a resumed wait
beside an uncertain call and that of a Child execution whose owner was lost
no longer exist. A rollout, a liveness restart or an
OOM costs a Turn at most a repeated request and the results it had not
committed, not the Turn, unless the Turn itself keeps losing its Runner: four
losses without progress end it with `recovery_limit_exceeded`. An Agent may
repeat a call whose effect already happened. Each takeover that writes results
reads the log once more. The mock runtime has no history to continue: a
taken-over mock Turn runs its script again, and since it commits no native
message, four losses of one mock Turn end it. A shutdown no longer waits for
running Turns to finish: a rolling restart moves each to another Runner at its
next model request, and one that is still in a tool at the deadline costs that
tool's result.

## Revised decisions

- ADR-0010 §7 is superseded: an ordinary Turn whose Runner was lost continues;
  its uncertain calls are reported to the Agent, which inspects before it
  repeats. So does a Child execution, in its slot, under the claim that takes
  it over (#252).
- ADR-0010 §2: only an execution that ends frees a slot; the pending scan
  covers a lost wake, and frees no slot of a lost owner.
- ADR-0010 §4: the Host, not the Adapter, guarantees that a continued history
  has a result for every call (#245); the plan answers dangling calls first.
- ADR-0013 "Decision": uncertain executions are recovered automatically, by
  reporting their outcome as unknown and continuing the Turn.
- ADR-0014 "Structured continuation" serves every takeover, and trailing failed
  requests leave the agent's context before Pi continues.
- ADR-0016: Host-written results for calls without a native result, takeover
  repairs as well as recovered waits, continue the native chain on replay.
- ADR-0018 "Release boundary": general Turn recovery is introduced; the
  committed log is its checkpoint. A Runner shutting down pauses each running
  Turn before its next model request and hands it over (#254) instead of
  draining it.
- ADR-0020 "One stop path": the recovery rules the next claim applies are this
  ADR's. A `"stopped"` result and a handoff's deadline take that path and then
  release the claim, so the input goes to the next claim at once instead of
  after its lease. Pi returns `"stopped"` (ADR-0020 "The Adapter contract").
