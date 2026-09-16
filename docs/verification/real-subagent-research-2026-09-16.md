# Real subagent research verification — 2026-09-16

## Scenario

A real production parent Agent received a natural-language engineering research task, with no forced tool arguments or canned success token. It independently launched two background Child Sessions:

1. Download the immutable Open Managed Agents source archive, inspect actual implementation paths, and write a code exploration report with paths and line numbers.
2. Fetch two official Claude subagent documentation sources, retain original responses and HTTP metadata, and write an evidence-based research report.

The parent then read both reports, cross-checked sources, wrote a combined assessment, and read it back. All work used the real Pi runtime and managed Sandbox at `https://agentry.welltop.tech`.

## First run and findings

Release `e4860c5bc43d`; parent `sess_QGponXvNIwxx-p79BDRj_`; Workspace `ws_MkifaKFLdmw6_HGemNWEz`.

- Two children were observed running simultaneously. Both completed: code exploration used 61 Sandbox tool calls and 22 model requests; documentation research used 41 tool calls and 15 model requests. Neither invoked a delegation tool or owned a nested execution.
- Three saved reports were retrieved independently through the Workspace API: code exploration 33,060 bytes, official research 19,631 bytes, assessment 21,010 bytes. Canonical parent events show separate reads of both child reports and a read-back of the assessment.
- Independent review matched five groups of code references against `git show e4860c5:path`. Four retained HTML/Markdown responses matched their recorded sizes and SHA-256 hashes; curl output and response headers supported HTTP 200 and the recorded URLs/timestamps.
- Report quality still requires review: the first official research report generalized a default concurrency of 20 and omitted documented exceptions. This is recorded as a research-summary limitation, not a product failure.
- The initial 15-minute observation window expired while the parent was still writing its assessment. Observation resumed without interrupting the task; it completed at 03:19:43 UTC. This monitoring timeout was not an execution failure.
- Normal tool failures also occurred: a parent ambient skill path was unavailable in the Sandbox, and an attempted `apply_patch` command was unavailable; the parent continued using working tools. These are not presented as error-free first attempts.

The realistic run exposed two implementation defects:

1. **Cross-Session delta replay.** Turn IDs derive from Session-local event sequence/generation, but Redis previously keyed streams only by Turn ID. Concurrent child tabs could display another Session's transient output, and completion could reclaim another Session's stream. All append/read/count/reclaim operations now require Session identity. SSE and execution traces use the authorized owning Session; ambiguous legacy global streams are never replayed. Canonical PostgreSQL history is unchanged.
2. **Budget contract mismatch.** The Agent tool advertised up to 1,000 steps while the deployed Host allowed 30. The parent received two rejected calls before autonomously retrying with 30. The tool schema, description and validation now use the Host's actual bound.

## Model inheritance

Following the user's additional requirement, general-purpose children no longer accept a freely selected `model` tool parameter. New and resumed executions snapshot the calling parent Turn's resolved `provider/model`, and retain it through queueing, Agent configuration edits and recovery. Both tool validation and the Host reject model overrides. Existing accepted executions keep their persisted configuration.

There is currently no predefined-subagent configuration feature. A future predefined model exception requires explicit Host-owned configuration; this change does not introduce that feature.

Implementation commits: `ccaf39aa155a` (stream/budget fixes), `738c128bf426` (model inheritance).

## Automated verification

- Server: **846 passed**, 7 optional integration tests skipped.
- Adapter: **389 passed**.
- Server and Adapter typechecks passed.
- A separate real PostgreSQL regression verified parent-model persistence; its isolated schema was removed and the local test container stopped.
- Web: **256 passed**, with production build passing. A supplemental hook regression mounts parent and child concurrently with identical event/Turn/block/delta IDs, completes and closes one without affecting the other, then reopens the child from its own history cursor. An earlier focused 22-test UI review also passed.
- New regressions cover concurrent Sessions with identical Turn/block IDs, cross-tenant Session isolation, reclaim/resume isolation, SSE reconnect, delegation traces, Host bounds 7/30/250, and model inheritance on create/resume during an Agent configuration change.
- Independent code review found no blocking issues.

## Final release and repeated live scenario

Server and Web both run `738c128bf426` in `agent-platform/oma-infra`; rollout and external health checks passed. At release time, remote `main` was `cf47dc83ada9`, which is an ancestor of the release.

The repeated real scenario used parent [sess_QRZ0rqEAJHpiVJphEDhHy](https://agentry.welltop.tech/sessions/sess_QRZ0rqEAJHpiVJphEDhHy), Workspace `ws_5CPCFTbUdNgl0ByOwtQmG`:

- Two first-level children ran concurrently, both with `turn_1_a1`. The documentation child completed; the code child truthfully recorded one `pi_agent_error: stream_read_error`. The parent autonomously resumed the same Child Session, whose next execution completed. This was a recovered failure, not an error-free run.
- All three executions, including resume, recorded `openai-codex/gpt-5.6-sol` and `modelSource: parent`. The parent never supplied a model tool argument.
- **112 nonempty live replay snapshots** were matched against canonical events. All **35** documentation tool IDs and **78** code/recovery tool IDs belonged to their own Child Session; zero unmatched IDs. Neither child called nested delegation tools or owned nested executions.
- The parent actually read both saved reports and read back its assessment. Saved artifacts: code exploration **6,676 bytes**, official research **3,686 bytes**, assessment **1,535 bytes**. The second official report explicitly retained the concurrency exceptions missed in the first report.
- Browser verification covered parent-only sidebar results, peer child tabs, running spinners, repeat-open deduplication, close/reopen, reuse of the same tab from the resume call, and preservation of the parent's unsent draft. At completion there were zero running indicators, zero `terminated` labels and zero delegated-execution headers. The temporary draft was cleared without sending it.
- **21 final API/assertion and cleanup checks passed.** The first validator assumed every individual execution must complete, which correctly rejected the intermediate failed attempt. Final acceptance instead requires the latest execution of each Child Session to complete, while retaining the earlier failure. Delta sampling also follows the trace API's last-history-page rule. Both harness adjustments and earlier results are retained in the JSON; no execution result was changed.
- Verification Sessions were terminated only after they were idle with no pending input; history and Workspace artifacts remain available. All temporary API keys for both research runs were revoked. Other API keys were untouched.

### Retained artifacts

These are copies of the final production Workspace files. Their `/home/user/workspace` references refer to the production research Workspace, not the local repository.

- [Code exploration report](research-2026-09-16/code-exploration.md)
- [Official-source research report](research-2026-09-16/official-research.md)
- [Combined assessment](research-2026-09-16/assessment.md)

Machine-readable assertions, recovered failure details, artifact SHA-256 hashes and deployed image IDs are in [real-subagent-research-2026-09-16.json](real-subagent-research-2026-09-16.json).
