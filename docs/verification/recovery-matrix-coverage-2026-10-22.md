# Recovery matrix coverage audit (2026-10-22, #234)

The user requires that every way a Session can be restarted or recovered is tested. This audit maps
every row of the recovery scenario matrix (`RECOVERY-MATRIX.md`, shared by the #234 tickets) to the
automated tests that cover it, after reading each test's body rather than trusting its name, and adds
the cases the matrix missed. Base: `feat/stateless-runner-resume` at 3705095 (all of #235-#254 merged,
plus the #247 follow-ups). Branch: `wt/recovery-audit`.

## Summary

| | Rows | Covered before the audit | Covered after |
|---|---|---|---|
| Original matrix | 60 | 57 (E9 partial, G1 none, G3 partial) | 60 |
| Added by the audit | 19 | 3 already covered by existing tests (B6, C15, G7) | 19 |
| Total | 79 | 60 | 79 |

- 9 rows are also LIVE rows, to be run against real Runners on oma-test by the orchestrator:
  A7, C1, C4, C7, D1, E1, F1, F6, G4. Each of them is covered by automated tests as well.
- E11 runs only against a real PostgreSQL (`PG_TEST_URL`); pg-mem's clock is the test process's
  clock. It passed against the throwaway PostgreSQL 17.
- 476 new test cases: 465 crash-injection executions (real Pi SDK), 2 Router tests, 5 PostgreSQL store
  tests, 4 in-memory store tests. Two universal assertions are now checked by every crash-injection
  execution (about 1,150 of them), not only by single tests.
- Two bugs found and fixed (see "Bugs found").

Levels: **CI** crash injection through real Routers and the real Pi SDK
(`server/packages/api/test/crash-injection/`); **R** Router level with a scripted Adapter
(`server/packages/session-router/test/`); **P** the pure `planResume` table
(`session-router/test/plan-resume.test.ts`); **S** store contract (`server/packages/store/test`,
`server/packages/store-memory/test`); **U** other unit tests (redis, RunnerDispatch, graceful
shutdown); **Pi** Pi adapter SDK tests (`adapter/packages/pi-agent/test`); **W** web tests (`web/src`).

A **sweep** loses the Runner after each durable write of a scenario, one execution per write, and
names each execution after the matrix row its crash point exercises (`harness.ts` `rowOf`): "sweeps @A4"
means the executions of every sweep labelled A4. The sweeps are single-bash, parallel-tools,
final-answer (two queued inputs), failed-requests (retried / always failing), compaction (threshold /
overflow), pinned-config E5, child-sessions C1/C7/C8/C9/C11/C12, and the audit's D1, D7, G1, G3, G5,
C13 and C14. The handoff sweeps (`handoffSweep`, labelled `F@<row>`) shut the Runner down after each
write instead.

Statuses: **covered** (existing tests assert the expected outcome), **covered-by-new-test** (the audit
wrote the test), **LIVE-pending** (also to run on oma-test). No row is not-applicable.

## Universal assertions

`expectResumed` (`crash-injection/harness.ts`) runs after every crash-injection execution, in every
Session it ran (Child Sessions included):

| Universal assertion | Where it is checked |
|---|---|
| Turn finishes under the original turnId | each input's events name exactly one Turn, and its completion names it |
| exactly one `session.turn_completed` per input | completions = inputs, one per input |
| every tool_use has exactly one result | per call, displayed results counted |
| "outcome unknown" only on calls dangling at the crash | set equality with the calls each loss left dangling, minus those a delegation record or an applied Interrupt answers |
| no `recovery_*` error | errors other than the scenario's own fail |
| model-step count continuous | each attempt's `resume.completedModelSteps` equals the steps its log holds; it continues exactly when its input is in the native history; span ids unique |
| one `session.turn_resumed` per takeover, correct reason and dangling ids | per loss, at most one marker of the next generation with the loss's reason and dangling calls; the takeover that drained the input marked itself |
| dead attempt's Deltas not stitched onto the new attempt | **new**: every Delta names a Turn that completed and, as its attempt, the generation of a claim of that Turn's input. The console behaviour itself is W (session-event-stream, use-session-events) |
| queued inputs run afterwards, in order | **new**: the Session's queued inputs are promoted once each, in queue order (previously only the final-answer sweep's own check) |
| no write from the dead attempt after the takeover | every row of the log was written by a live Runner's durable write |
| (also) no tool runs twice; no double billing | tool call ids unique; billed model-request ends at most the non-summary requests |

## A. Crash point within an ordinary Turn

| # | Situation | Expected | Covering tests | Level | Status |
|---|---|---|---|---|---|
| A1 | claim taken, input not promoted | run from scratch; promotion idempotent | sweeps @A1 (lost after `claim`); plan-resume "A1/A2 nothing after the promoted input…"; repro-drain-stall "keeps input pending when the process dies before the Adapter starts…" | CI, P, R | covered |
| A2 | promoted, no status_running | run | sweeps @A2 (`append user.message`, `updateStatusIfClaimed`); plan-resume "A1/A2…"; repro-drain-stall "retries after a crash that committed the user Event but happened before pending acknowledgement" | CI, P, R | covered |
| A3 | status_running, no context_start | run (same turnId) | sweeps @A3; plan-resume "A3 only the running status: prompt the input"; same-turn-across-attempts "A3 a rerun of an input no attempt named…"; repro-drain-stall "A3 reruns an input its lost attempt left without output…". Nothing durable names the first attempt's Turn at this point, so the takeover's id names it (ADR-0021); one Turn per input is asserted | CI, P, R | covered |
| A4 | context_start, native user message not committed | re-prompt, same turnId | sweeps @A4 (`context_usage`, `context_start`, model/thinking entries); plan-resume "A4 context_start committed…" | CI, P | covered |
| A5 | user message committed, request in flight | continue; dead Deltas hidden | explicit-rows "A5 lost while the model streams its answer…" (Deltas tagged with attempts 1 and 2); sweeps @A5; plan-resume "A5…"; resume-shapes-sdk "A5 the input itself"; session-event-stream "replaces a crashed attempt's partial Delta…" | CI, P, Pi, W | covered |
| A6 | tool calls committed, tool not started | unknown result, continue | sweeps @A6; plan-resume "A6/A7…"; repro-drain-stall "A6 answers a durable tool_use as of unknown outcome…"; resume-shapes-sdk "A6/A7 the unknown result the Host wrote…" | CI, P, R, Pi | covered |
| A7 | single long bash running | unknown result, continue | explicit-rows "A7 lost while a long bash command runs…"; same-turn-across-attempts "A7 lost mid-tool…" | CI, R | covered; LIVE-pending |
| A8 | parallel tools, some results committed | only the uncommitted ones unknown | parallel-tools sweep @A8; explicit-rows "A8 lost while one of three parallel calls still runs…"; plan-resume "A8…"; resume-shapes-sdk "A8…" | CI, P, Pi | covered |
| A9 | all results committed, next request not sent | continue, no unknown | sweeps @A9; plan-resume "A9…"; resume-shapes-sdk "A9 a native tool result" | CI, P, Pi | covered |
| A10 | final answer committed, no turn_completed | complete without a model call | sweeps @A10 and @releaseResourceUse (final-answer sweep: no answer twice); plan-resume "A10…" (4 rows); repro-drain-stall "A10 completes a Turn whose final answer is durable…" | CI, P, R | covered |
| A11 | assistant stopReason error/aborted last | continue | failed-requests "retried" sweep; overflow and C11 sweeps @A11; plan-resume "A11…" (2 rows); resume-shapes-sdk "A11 a failed model request", "A11 a request aborted…", "A11 a retryable failure again" | CI, P, Pi | covered |
| A12 | terminal event committed, no turn_completed | repair dangling, complete | failed-requests "keeps failing" sweep (one error); plan-resume "A12…" (8 rows); same-turn-across-attempts "A12 a terminal event the lost attempt committed…"; delegation "does not restart a consumed-wait parent after a durable turn_aborted…" | CI, P, R | covered |
| A13 | turn_completed, not acked | ack only | sweeps @A13; plan-resume "A13…" (3 rows); repro-drain-stall "does not rerun or duplicate durable Events when completion committed before the ack crash"; turn-idle-lifecycle "recovers completion before acknowledgement…"; pending-event-store "recovers a completed but unacknowledged Turn…" | CI, P, R, S | covered |
| A14 | acked | next queued input runs | sweeps @A14 (final-answer, D1, G5 and others with two inputs) | CI | covered |
| A15 | MCP call dangling | unknown result with serverName | same-turn-across-attempts "A15 lost during an MCP call…"; router-journal "A15 answers dangling MCP calls under their server…"; plan-resume "A15…" | R, P | covered |
| A16 | crash inside a journal flush | resume from what is durable | explicit-rows "A16 lost in the middle of a flush…"; every sweep loses after each single append, also between two appends of one flush | CI | covered |
| A17 | crash while writing the resume repairs | idempotent repairs, no duplicates | takeover-lost "Runner 0 lost after write %i, Runner 1 after its write %i…" (two first losses × every takeover write); delegation-tools "C4/A17…" (2); takeover-limit "E1/A17…"; interrupt-at-loss D6; plan-resume "A17…" (2) | CI, P | covered |
| A18 | budget near exhaustion across resumes | steps from the log; budget error at the right step | child-sessions "C11…" + C11 sweep; the steps check of every execution; plan-resume "A18…" (4); durable-execution "retains the same Turn's consumed budget after recovery" | CI, P, Pi | covered |
| A19 | usage/context_usage around the crash | no double billing | billing checks of every execution at the points labelled A19; repro-drain-stall "aborts on heartbeat lease loss…" (stale usage not charged) | CI, R | covered |
| A20 | **new**: the takeover's Adapter run() throws | adapter_error; Turn completed under its original turnId after its dangling calls were answered; queue continues | takeover-faults "A20 the takeover's Adapter run() throws…" | R | covered-by-new-test |
| A21 | **new**: the model the Turn is pinned to is gone from its provider at takeover | error naming the model; no other model runs it; next Turn uses the Agent's current model | configuration-changes "A21 the takeover fails the Turn with an error that names the model…" | CI | covered-by-new-test |

## B. Compaction

| # | Situation | Expected | Covering tests | Level | Status |
|---|---|---|---|---|---|
| B1 | threshold summary request in flight | continue; uncommitted summary never used | compaction threshold sweep @B1 with `expectCommittedSummariesOnly`; plan-resume "B1…", "A10/B1…" | CI, P | covered |
| B2 | boundary committed, next request not sent | continue with the compacted context | threshold sweep @B2; plan-resume "B2…", "A10/B2…" | CI, P | covered |
| B3 | overflow compaction then crash | continue; no second overflow loop | overflow sweep (overflows per attempt at most one, Turn answered); plan-resume "B3…"; resume-shapes-sdk "B3 a compaction boundary after a failed request", "B3 an overflow again: Pi compacts once…" | CI, P, Pi | covered |
| B4 | Interrupt during compaction then crash | Interrupted Turn, no boundary | explicit-rows "B4 an Interrupt accepted during a compaction, then the Runner is lost…" | CI | covered |
| B5 | **new**: SIGTERM around a compaction | handoff; a summary reaches the model only once committed | compaction "B5 handoff sweep: threshold…", "B5 handoff sweep: overflow…" (84 executions), "B5 the compaction completes on the Runner that shuts down…"; shutdown-handoff "F3 SIGTERM while a final answer streams that fills the context…" | CI | covered-by-new-test |
| B6 | **new**: the takeover's first request overflows the context window | compact once, retry, answer | overflow sweep @A4/@A5 of the second input: the takeover's first request gets the 413, Pi compacts once and the Turn is answered | CI | covered |

## C. Delegation

| # | Situation | Expected | Covering tests | Level | Status |
|---|---|---|---|---|---|
| C1 | parent lost while waiting on a running sync child | wait resumed, result consumed in the same parent Turn | child-sessions "C1 crash injection: the parent's Runner is lost after each of its writes…" (`expectDelegated`); plan-resume "C1/C5…"; delegation "continues the original Turn from the event log when the Runner is lost after acceptance…" | CI, P, R | covered; LIVE-pending |
| C2 | parent waiting, child completed, result not consumed | consume, continue | child-sessions "C2 the parent's Runner is lost while it waits and the child completes before any Runner takes the parent over…"; sweeps @C2; plan-resume "C2…" | CI, P | covered |
| C3 | Agent tool_use committed, accept not | unknown result; no child | delegation-tools "C3 Agent call committed, Runner lost before the delegation was accepted…"; dangling-delegation-calls "C3…"; plan-resume "C3…" | CI, R, P | covered |
| C4 | background Agent accepted, result not committed | real result from the record; no second child | delegation-tools "C4 background Agent accepted…", "C4/A17…" (2), "C4 synchronous Agent accepted…"; dangling-delegation-calls "C4…" | CI, R | covered; LIVE-pending |
| C5 | get_subagent_result dangling | current status / resumed wait | delegation-tools "C5 … committed, Runner lost before it recorded anything" (wait=false/true), "C5 … lost after it recorded its wait" (2); dangling-delegation-calls "C5…" (3) | CI, R | covered |
| C6 | steer_subagent dangling | accepted command status | delegation-tools "C6 steer_subagent accepted…", "C6 … before the command was accepted…"; dangling-delegation-calls "C6…" (2) | CI, R | covered |
| C7 | child's own Turn lost mid-tool | child resumes in the same Turn; parent gets the real result | child-sessions "C7 the child's Runner is lost while its bash runs…", "C7 crash injection: the child's Runner is lost after each of its writes…"; delegation-concurrency "C7 rejects an expired owner at commit…" | CI, S | covered; LIVE-pending |
| C8 | parent and child Runners both lost | both resume; result delivered once | child-sessions "C8 both Runners are lost…", "C8 crash injection: one Runner runs parent and child…" | CI | covered |
| C9 | child steering instruction last in its log | continue | child-sessions "C9 lost right after the instruction was applied…", C9 sweep; plan-resume "C9…"; resume-shapes-sdk "C9 steering applied at the request gate" | CI, P, Pi | covered |
| C10 | siblings with expired owners | not recovery_required; cap enforced | child-sessions "C10 one slot, two synchronous children…"; delegation-concurrency "C10 keeps a sibling with an expired owner in its slot…" | CI, S | covered |
| C11 | child budget across takeovers | continues from the log | child-sessions "C11 the child's Runner is lost at its second step…", C11 sweep | CI | covered |
| C12 | parent interrupted while waiting, then crash | child interrupted, parent Interrupted Turn | child-sessions "C12 the child's Runner is lost before it applied the parent's Interrupt…", C12 sweep; plan-resume "C12…" (3), "D1/C12…"; router-journal "C12 publishes the Interrupt…" | CI, P, R | covered |
| C13 | **new**: parent waits on two sync children, lost at any write | each recorded wait resumed, each result consumed once, no child twice; an unaccepted call is unknown | parallel-children "C13 crash injection: the parent waits on two synchronous children…" (36); exposed bug 1 | CI | covered-by-new-test |
| C14 | **new**: a background result starts a parent Turn of its own, lost at any write | delivered once, answered once, notification processed | delegation-result-turn "C14 crash injection…" (66) | CI | covered-by-new-test |
| C15 | **new**: child budget exhausted exactly at a takeover | budget_exhausted, no further request | C11 sweep: losses right after the last budgeted step's records; `expectExhausted` (requests at most the budget, one budget error) | CI | covered |

## D. Interrupt

| # | Situation | Expected | Covering tests | Level | Status |
|---|---|---|---|---|---|
| D1 | Interrupt accepted, Runner lost before it took effect | Interrupted Turn on takeover, no new model request | **new** interrupt-at-loss "D1 crash injection: an Interrupt accepted right before the Runner is lost, at every crash point" (42); prior-interrupt "D1/D5…", "D1 ends a Turn interrupted before it committed output…"; plan-resume "D1…" (7); pending-event-store "D1 reports an Interrupt its predecessor accepted…"; stores "D1/D4…" | CI, R, P, S | covered; LIVE-pending |
| D2 | Interrupt under the current generation | unchanged | prior-interrupt "D2…"; pending-event-store "a fresh Interrupt targets a reclaimed generation…" (PG); multi-runner "sees an Interrupt accepted on another Host at once…" | R, S | covered |
| D3 | crash during interrupt cleanup (turn_aborted written) | row 2 completion | prior-interrupt "D3 completes a Turn whose Runner was lost after writing turn_aborted…"; plan-resume "A12/D3…", "D3…" (2); interrupt-at-loss D6 | R, P, CI | covered |
| D4 | Interrupt after the takeover | normal interrupt of the resumed attempt | prior-interrupt "D4 an Interrupt that arrives after the takeover…", "D4 an Interrupt the takeover accepted outlives the takeover's own loss"; stores "D1/D4…" | R, S | covered |
| D5 | queued inputs behind an interrupted, crashed Turn | run afterwards | prior-interrupt "D1/D5…"; stores "D5 reports no Interrupt to the claim of the input queued behind…"; D1 sweep (the queued input is answered) | R, S, CI | covered |
| D6 | **new**: the takeover applying a prior Interrupt is lost after each of its writes | Interrupted Turn ended once, no model request | interrupt-at-loss "D6 crash injection…" (25) | CI | covered-by-new-test |
| D7 | **new**: Interrupt requested after the lost Runner's lease ran out, before the takeover | accepted; takeover ends the Turn as Interrupted | interrupt-at-loss "D7 crash injection…" (42); interrupt-acceptance (store-memory, PostgreSQL); exposed bug 2 | CI, S | covered-by-new-test |
| D8 | **new**: Interrupt while the takeover prepares the resumed attempt | no model request; Interrupted Turn | interrupt-at-loss "D8 the user stops the Turn while the takeover prepares it…" | CI | covered-by-new-test |
| D9 | **new**: Interrupt accepted while the Turn is handed over (SIGTERM) | next Runner ends it as Interrupted without a model request | interrupt-at-loss "D9 an Interrupt accepted while the Turn is handed over…"; interrupt-acceptance "D7 accepts an Interrupt for a head whose claim was released…" | CI, S | covered-by-new-test |

## E. Takeover policy

| # | Situation | Expected | Covering tests | Level | Status |
|---|---|---|---|---|---|
| E1 | fourth expired takeover without progress | recovery_limit_exceeded, complete, queue continues | takeover-limit "E1 a poison Turn…", "E1/A17 the takeover that ends the Turn is lost after each of its writes…"; child-sessions "E1/C7…"; plan-resume "E1…" (9) | CI, P | covered; LIVE-pending |
| E2 | progress between takeovers | counter resets | takeover-limit "E2 progress between takeovers resets the count…", "E2 a long Turn that commits progress before each loss…"; plan-resume "E2…" (5) | CI, P | covered |
| E3 | released claims | not counted | takeover-limit "E3 handoffs are not counted…", "E3/F7…"; plan-resume "E3…" (4); same-turn-across-attempts "a Turn handed over by a released claim resumes for a handoff…" | CI, P, R | covered |
| E4 | persistence-failure stop | counted | takeover-limit "E4 a Runner stopped by a failed write counts as lost…" | CI | covered |
| E5 | model/thinking changed mid-Turn, then loss | resumed requests keep original; next Turn uses new | pinned-config "E5 the Agent's model and the Session's thinking edited mid-Turn…", E5 sweep; same-turn-across-attempts "E5/E6…"; plan-resume "E5…" (5) | CI, R, P | covered |
| E6 | system prompt/Skills/MCP changed mid-Turn | resumed attempt uses current config | pinned-config "E6…"; same-turn-across-attempts "E5/E6…" (MCP servers) | CI, R | covered |
| E7 | stale generation updates the projection / deletes the stream | refused | turn-stream-store "E7 refuses an attempt whose input a later generation took over", "refuses every attempt of an earlier input…"; same-turn-across-attempts "E7 a stale generation cannot overwrite the projection…", "a lost attempt leaves the Turn's Delta stream…"; repro-drain-stall "a late stale generation cannot clear or idle a newer Host's active turn" | U, R | covered (see residual 1) |
| E8 | two Runners race for an expired claim | one wins, the loser stays quiet | multi-runner "E8 two Runners race for an expired claim…"; shutdown-handoff (R) "E8 the Runners woken for a handed-over Turn race for it…" | R | covered |
| E9 | zombie Runner (alive, lease lost) | its writes fail on the fence; it stops; no terminal events | **new** takeover-faults "E9 a zombie Runner, its heartbeat paused past the lease, is fenced out…" (late writes after the takeover completed the Turn); repro-drain-stall "aborts on heartbeat lease loss…"; router-journal "stops without terminal events when an interrupted Adapter's write finds the lease lost"; turn-journal "fails for good once its claim fence is lost"; sandbox-tool-cancellation "sends nothing to the running execution after the lease is lost"; event-log-store "checks a pending owner+generation fence…" | R, S | covered-by-new-test (before: no takeover running alongside the zombie) |
| E10 | **new**: Agent/Session edited while the Turn waits on a sync child, parent lost | resumed wait and rest of the Turn keep the original model+thinking; next Turn uses the edit | configuration-changes "E10…" | CI | covered-by-new-test |
| E11 | **new**: Runner clocks skewed against PostgreSQL | every lease decision follows `clock_timestamp()` | lease-clock "E11 a Runner whose clock runs an hour ahead cannot take a live claim…", "E11 a claim whose lease PostgreSQL says expired is taken over…" (PostgreSQL only) | S | covered-by-new-test |

## F. Graceful shutdown handoff

| # | Situation | Expected | Covering tests | Level | Status |
|---|---|---|---|---|---|
| F1 | SIGTERM while a tool runs, finishes before the deadline | result committed, stop before next request; tool not rerun | shutdown-handoff (CI) "F1 SIGTERM while a tool runs…"; (R) "F1…"; handoff sweeps @F@A6–A9 | CI, R | covered; LIVE-pending |
| F2 | tool still running at the deadline | detach, claim released, unknown result; not killed | (CI) "F2 SIGTERM, and the tool still runs at the deadline…"; (R) "F2…"; sandbox-tool-cancellation "F2 sends nothing…"; graceful-shutdown "waits for the claims of Turns detached at the deadline…" | CI, R, U | covered |
| F3 | SIGTERM while the model streams | stop at the next request gate, handoff | (CI) "F3…" (3); (R) "F3…" | CI, R | covered |
| F4 | SIGTERM while the parent waits on a sync delegation | handoff; wait resumed elsewhere | child-sessions "F4 SIGTERM while the child's bash runs…", "F4 handoff sweep…"; (R) "F4 shut down while a parent waits on a synchronous delegation…" | CI, R | covered |
| F5 | SIGTERM while idle | no claims after SIGTERM, retry timers stopped | (R) "F5 an idle Runner that shuts down claims nothing more…"; runner-dispatch "F5 once stopped it claims nothing…" | R, U | covered |
| F6 | rolling restart of every Runner | every running Turn continues | (CI) "F6 a rolling restart…"; (R) "F6…" | CI, R | covered; LIVE-pending |
| F7 | handoff, then the new owner crashes | counter per E1–E3 | (CI) "F7…", takeover-limit "E3/F7…"; (R) "F7…"; plan-resume "F7…", "E3/F7…" | CI, R, P | covered |
| F8 | **new**: the takeover of a lost Turn is shut down at any of its writes | markers expired then released; completes; no rerun | shutdown-handoff "F8 the takeover of a lost Runner's Turn is shut down after each of its writes" (34) | CI | covered-by-new-test |
| F9 | **new**: SIGTERM, then SIGKILL before the handoff ends | claim lapses, counts as a loss; unknown result | shutdown-handoff "F9 SIGTERM while a tool runs, then SIGKILL before the handoff ends…" | CI | covered-by-new-test |

## G. Session-level

| # | Situation | Expected | Covering tests | Level | Status |
|---|---|---|---|---|---|
| G1 | Session terminated while its Runner is lost | not resumed; queue cleared; sandbox cleanup | **new** session-level "G1 lost while its bash runs, terminated before the takeover…", "G1 crash injection: terminated after the Runner is lost after each of its writes" (41); repro-drain-stall "deduplicates Session ids and clears pending input for … terminated Sessions"; session-store "termination atomically removes a remote Host claim and fences all later writes" | CI, R, S | covered-by-new-test (before: no lost Runner) |
| G2 | several queued inputs, crash mid-first | first resumes, rest follow in order | final-answer sweep (two inputs, every write of both); shutdown-handoff (CI, R) "G2…"; the new input-order check of every execution | CI, R | covered |
| G3 | Redis unavailable during resume | Turn completes (Deltas best effort) | **new** session-level "G3 to the Runner that takes the Turn over…", "G3 crash injection: Redis is down for every Runner…" (production `BestEffortTurnStreamStore` over a failing Redis); turn-idle-lifecycle "completes PG-owned work when Redis reads fail…"; turn-stream-store "appends stay best-effort…" | CI, R, U | covered-by-new-test (before: not during a takeover) |
| G4 | browser connected during takeover | one Turn, no stitched Deltas, backfill correct | session-event-stream "Delta attempts of one Turn" (5), "replaces a crashed attempt's partial Delta…"; use-session-events "shows only the highest attempt's output when a reconnect replays two attempts…"; conversation-turns "shows a Resumed Turn as one finished Turn…"; router-journal "tags live Delta frames and Redis records with the claim generation…"; the new Delta check of every execution | W, R, CI | covered; LIVE-pending |
| G5 | **new**: user message sent while the Runner is lost | runs after the resumed Turn, in order | session-level "G5 sent while the Turn's Runner is lost…", G5 sweep (42) | CI | covered-by-new-test |
| G6 | **new**: Session terminated while the takeover runs | takeover stops at its next write, no terminal event; queue cleared; Sandbox released | session-level "G6 terminated while the takeover's model request is in flight…", "G6 terminated while the takeover's own bash runs…" | CI | covered-by-new-test |
| G7 | **new**: wake/check hints lost | takeover by the pending scan; waits by the fallback poll; Interrupt within one renew interval | multi-runner "takes a crashed owner's Turn over within the lease plus one scan", "sees an Interrupt within one renew interval when its hint is lost"; delegation "still receives the result through its fallback poll when the hint is lost"; crash injection with Child Sessions apart (a wake sent to a lost Runner is lost; the pending scan finds the input) | R, CI | covered |
| G8 | **new**: parent terminated while its child's Runner is lost | child's takeover ends the child Turn as Interrupted without a model request; no parent Turn runs; queues cleared | session-level "G8 the child's takeover stops the child's Turn as an Interrupted Turn…" | CI | covered-by-new-test |

## Bugs found

1. **In-memory delegation transactions undid other writers' changes** (`store-memory`, fixed in
   5a18ec5). A failed transaction restored whole-store snapshots taken when it started, so it also
   reverted what others wrote meanwhile. C13 hit it: a lost Runner's in-flight second `accept` failed its
   fence after the lease lapsed and restored the live claim, so no Runner could take the parent's Turn
   over. PostgreSQL is not affected; the in-memory stores back local development and every Router and
   crash-injection test. Every writing transaction asserts its fence before it writes, so a transaction
   that wrote nothing now restores nothing. A transaction that fails after writing still restores its
   snapshot (residual 2).
2. **An Interrupt was refused while no Runner held the running Turn's claim** (`store`, `store-memory`,
   fixed in f644b7f; behaviour change). `requestInterrupt` required a live claim. After a lost Runner's
   lease ran out and before the next pending scan took the input over (up to one 5 s scan), and between
   a handoff's release and the next claim, the API answered `requested: false`, and the takeover then
   continued the Turn the user had stopped. It now accepts an Interrupt for the head any claim started
   whose Turn has not completed; the next claim sees it as `priorInterrupt` and ends the Turn as an
   Interrupted Turn (D7, D9). Please confirm this is the intended semantics; the commit is self-contained.

## Decisions to confirm

- A21: a Resumed Turn whose pinned model has been removed from its provider fails with the Pi error that
  names the model (`pi_agent_error`, "Pi model scripted/scripted-model is not configured…") instead of
  falling back to the Agent's current model. The test asserts this, following #253 (the Turn keeps its
  model) and the model resolver's rule that an unknown model fails rather than running another one.

## Residual risks

1. E7: `endTurnStream` deletes the Turn's Delta stream without a generation check. If an attempt's lease
   lapses between its last fenced flush and that delete, while a takeover already streams the same Turn,
   the takeover's earlier Deltas are lost from Redis. Reconnect backfill could then miss them until the
   Complete Events arrive; durable state is unaffected. The window is a few milliseconds.
2. In-memory delegation transactions that fail after writing still restore whole-store snapshots
   (bug 1). No current transaction does this except on an unexpected error.
3. G8: `finishExecution` appends the child's `subagent.result` record to a parent that is already
   terminated (no Turn runs for it). Harmless, but the parent's history gains a row after termination.
4. The in-memory `requestInterrupt` does not check for a completed Turn the way PostgreSQL's does. The
   plan acknowledges such an input anyway (row 1), so no behaviour differs.

## Verification

Commands, run from the worktree root on the rebased branch (3705095 + the audit's commits):

| Command | Result |
|---|---|
| `cd server/packages/session-router && npx tsc --noEmit && npx vitest run` | typecheck clean; 20 files, 393 tests passed |
| `cd server/packages/api && npx tsc --noEmit && npx vitest run` | typecheck clean; 65 files passed, 2 skipped (env-gated); 1,651 tests passed, 11 skipped |
| `cd server/packages/api && npx vitest run test/crash-injection` | 17 files, 1,153 tests passed (about 2.5 minutes) |
| `SPLIT_TEST_PG_URL=postgres://postgres:oma-test-only@127.0.0.1:55433/oma_local SPLIT_TEST_REDIS_URL=redis://127.0.0.1:56379 npx vitest run test/split-process.test.ts --testTimeout 30000` in `server/packages/api` | 8 passed, 1 skipped, 1 failed: "Interrupt from a different API affects only the active Turn…" reads the Session's status right after the second `turn_completed` is visible, before the acknowledgement commits `idle`. It fails the same way with the Interrupt change reverted, and passes when it waits for `idle`; a pre-existing race of the test, widened by the tunnel's latency |
| `cd server/packages/store-memory && npx tsc --noEmit && npx vitest run` | 5 files, 72 tests passed |
| `cd server/packages/store && npx tsc --noEmit && npx vitest run` (pg-mem) | 21 files passed, 6 skipped; 171 passed, 35 skipped |
| `PG_TEST_URL=postgres://postgres:oma-test-only@127.0.0.1:55433/postgres PG_TEST_SCHEMA=oma_taudit_<ts> npx vitest run` in `server/packages/store` (PostgreSQL 17.11) | 26 files passed, 1 skipped (pg-mem only); 204 passed, 2 skipped |
| `pnpm --dir adapter typecheck && pnpm --dir adapter test` | typecheck clean; 38 files, 445 tests passed |

The new tests' files are also typechecked with a temporary tsconfig that includes them (the
packages' tsconfigs cover `src` only).

LIVE rows for the orchestrator on oma-test: A7, C1, C4, C7, D1, E1, F1, F6, G4.
