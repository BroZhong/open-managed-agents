# Resumed Turn after a killed Runner on oma-test (2026-10-22)

Interim live check of #248 before #250–#254 land. Test environment only; production untouched.

## Setup

| Item | Value |
| --- | --- |
| Image | `oma-server:c71860d544fb` / `oma-web:c71860d544fb` (`feat/stateless-runner-resume`: PR-A, #240, #245, #247, #248, #249, DB-load fixes) |
| Runners | 2 replicas, Recreate, lease 30 s, renew every 10 s, pending scan every 5 s |
| Script | `deploy/scripts/verify-resumed-turn.mjs` (`init`, `kill-start`, `mark-disrupted`, `kill-finish`) run in the API Pod |
| Turn | real `openai-codex/gpt-5.6-sol`; one bash call `printf START > f; sleep 120; printf DONE >> f`; the prompt asks the model to inspect `f` if an outcome is unknown and never repeat the sleep |

## Runs

| Run | Disruption | Takeover after disruption | Checks |
| --- | --- | --- | --- |
| 1 | `kubectl delete pod --force --grace-period=0` | 45.9 s | all Turn checks passed; latency check failed (> 35 s) |
| 2 | same, with a health probe on the Pod | 43.9 s (HTTP refused after 1.7 s) | as run 1 |
| 3 | `kill -9` of the Runner's node process (exit 137), `shareProcessNamespace: true` | **31.0 s** | **13/13** |

Every run, including 1 and 2:

- one Turn under one turnId (`turn_1_a1`), exactly one `turn_completed`, no `recovery_*` error;
- one `session.turn_resumed { reason: "expired", generation: 2, danglingToolUseIds: [the bash call] }`;
- the bash call answered by the "outcome unknown" result, not rerun (one `sleep` call in the Turn);
- the model then ran `cat` on the marker file, about 35 s into the 120 s sleep, and answered
  `RESULT:START`, which was the file's content at that moment;
- the orphaned Sandbox command kept running and finished: read after 120 s, the file holds
  `STARTDONE` in all three runs. This matches #234 (no orphan kill in this phase) and the "outcome
  unknown" text, which warns that a process the call started may still be running;
- the other replica took over (run 3: `oma-runner-…-9l8b5`), every tool call has exactly one result.

## Finding: a forced Pod delete is a graceful shutdown here

On this virtual-kubelet, deleting a Pod with `--force --grace-period=0` still delivers SIGTERM. The
Runner then ran its pre-#254 graceful shutdown: it closed HTTP at once (probe: refused after 1.7 s),
waited up to 20 s for running Turns while its heartbeat kept renewing the claim, and only then exited.
The claim expired 30 s after the last renewal, which explains 44–46 s. #254 replaces that path with a
handoff that releases the claim; a real `kill -9` needs `shareProcessNamespace` because node as PID 1
ignores signals sent from inside its namespace. The test overlay now sets it (commit 60ed3a6).
