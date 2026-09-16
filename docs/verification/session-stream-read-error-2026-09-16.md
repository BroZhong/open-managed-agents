# Session stream failure investigation — 2026-09-16

Session: [sess_Pruf9rh4wgqH_BJG9H514](https://agentry.welltop.tech/sessions/sess_Pruf9rh4wgqH_BJG9H514), “拉取小说 74032 制作旁白故事片”. All times below are Asia/Shanghai.

## Findings

Two durable `session.error` events carry `code=pi_agent_error`, `message=stream_read_error`. The immediate transport failure is in Sub2API's upstream response stream. A separate, deterministically verified retry-classification gap converts the transient failure into a terminal model failure.

The precise reason the upstream HTTP/2 peer resets the stream remains unresolved. The available evidence does not distinguish provider/edge behavior from an upstream proxy problem. It does not establish a browser SSE, sandbox, context-limit, or skill failure as the cause of this error.

## Evidence and deployment

- Read the authenticated console's Conversation, Trajectry (982 events), expanded tool results, and Workspace `novel-74032/run.json`.
- Cluster: Shanghai agent-platform, explicitly selected with `~/.kube/agent-platform-config`.
- Host: namespace `oma-infra`, pod `oma-server-7997cc76d5-z4bz6`, container `server`, image tag `b185d01de549`; no container restarts at inspection.
- Gateway: namespace `sub2api`, pod `sub2api-567bb65775-flgq8`, container `sub2api`, image version `0.2.4`.
- Host model configuration: `openai-codex/gpt-6-astra`, API `openai-responses`, base URL `http://sub2api.sub2api.svc.cluster.local:8080/v1`.
- Runtime: `@earendil-works/pi-ai` and `pi-coding-agent` 0.80.10. Read the installed JavaScript, not an assumed latest version.
- Code checkout: current local worktree. Read-only remote checkout check: `~/workspace/yuzhong/open-managed-agents` on `vfs-dev`, HEAD `def855e0`.
- Read bounded Host logs (4 hours/12,000 lines), gateway logs (up to 12 hours/30,000 lines), and a short proxy log tail. No database records were retrieved; Supabase discovery did not expose the production database.

| Event | Evidence | Outcome |
| --- | --- | --- |
| 18:53:39.807 | Gateway request `af056cc2-08eb-475e-8d18-d9eb8057e224`: `stream read error: stream error: stream ID 397; INTERNAL_ERROR; received from peer` | Request had streamed for about 60.4 seconds; access status remains HTTP 200 despite failure inside the stream. |
| 18:53:39.850 | Session error, `turn_1_a1`; one `write` call has incomplete arguments and `Tool was not executed: argument stream failed.` | Turn stopped. A later subagent result was claimed at 18:56:22 and work resumed; this is not evidence that the failed request was automatically retried. |
| 19:58:28.652 | Gateway request `4b1c2118-f8eb-4c66-a0cf-59105d4adf2c`: `stream read error: stream error: stream ID 821; INTERNAL_ERROR; received from peer` | Corresponds closely to the session model span ending at 19:58:28.580. Gateway categorizes the log as `openai.client_disconnected`; its error field still records the upstream read failure. |
| 20:02:42.882 | Session error, `turn_289_a1`; idle at 20:02:44.681 | Execution ended while review revisions were incomplete. The delay between model span end and durable error is observed, not attributed to a specific cleanup operation. |

Other gateway failures occurred at 11:30:01, 14:28:32 and 17:01:08 with HTTP/2 connection loss/reset errors. They demonstrate recurrence at the gateway but are not attributed to this Session.

## Retry gap reproduction

Sub2API v0.2.4 `handleScanErr` sends `sendErrorEvent("stream_read_error")` after an upstream read failure once output has started. The underlying error is retained in gateway logs. See [versioned gateway implementation](https://github.com/Wei-Shaw/sub2api/blob/v0.2.4/backend/internal/service/openai_gateway_response_handling.go#L413).

The installed Pi classifier at `pi-ai/dist/utils/retry.js` matches `internal.?error` and `connection.?lost`, but not `stream_read_error`. `pi-coding-agent` delegates its retry decision to that classifier. A read-only Node invocation importing the production installation returned:

```text
stream_read_error                                                        -> false
stream read error: stream error: stream ID 397; INTERNAL_ERROR; received from peer -> true
http2: client connection lost                                             -> true
503 Service unavailable                                                  -> true
```

The seed settings do not override retry defaults; the installed defaults enable retry with three attempts and a 2-second exponential-backoff base. The missing classification prevents that retry policy from handling this normalized error.

OMA retains the final provider error in `adapter/packages/pi-agent/src/translator.ts:319` and emits it as `pi_agent_error` at finalization (`:394`); the adapter calls finalization after the model operation settles (`pi-agent-adapter.ts:383`).

## Other obstacles in the skill workflow

| Obstacle | Observed evidence and recovery |
| --- | --- |
| Novel-fetch dependency/setup | Initial fetch produced 0 chapters and 1 outline. Installing ossutil into `/home/user/.local/bin` failed with PermissionError. Using `/tmp/novel-tools/ossutil` and `OSSUTIL_BIN` recovered: 30 chapters and 1 outline downloaded. |
| Audio prompt length | `submit_audio.py` asserted at 3007 characters against a 3000-character limit. Prompt was edited and the 120-second audio was generated. |
| Missing subtitle timings | Audio service returned no timing data. Subsequent transcription and acoustic alignment produced a 247/247-word match; the child report explicitly preserves timing uncertainty. |
| Image risk rejection | `assets_tick.py` received `risk_control_rejected`, `[baidu/gpt-image-2] nsfw`. Revised nightgown reference v002 was later generated and selected. |
| Video review upload | `google.genai` upload failed while HTTPX encoded a header: `UnicodeEncodeError: 'ascii' codec can't encode characters in position 4-7`. An ASCII symlink recovered the same native review workflow. The successful G02 review reported seven paired processing calls/results. |
| Delegation budgets | Multiple results report `Model step budget exhausted` with limits 20, 8, 6 and 6. Work continued through later delegation/resume or parent handling. These are distinct from model transport errors. |
| Missing OS utility | `ps: command not found` interrupted a process-inspection command near render completion. Later technical verification completed. |
| Generated content quality | Repeated people, dissolves/ghosting, unstable contract text and an incorrectly placed cellar latch required reselection or reshoots. The final review additionally found reversed phone ownership at 49–53 seconds. |

## Current completion state

The console's current `novel-74032/run.json` says:

```json
{
  "current_stage": "review_revision",
  "stages": {
    "video": "running",
    "edit": "needs_revision",
    "review": "needs_revision",
    "delivery": "pending"
  }
}
```

An initial 120-second, 720×1280, 30 fps film exists. The recorded technical check passed full decode and found no black/freeze events at its configured thresholds; these are recorded tool outcomes, not an independent playback in this investigation.

Final native review returned `needs_minor_revision`, including a major story-logic issue at 49–53 seconds: the husband appears to give the phone to the protagonist instead of taking it away. A correction task, `d3457b0e-5f0b-4e9a-879b-cda288a2a061` (`wan3.0-video`), and `scripts/revise_film.py` were recorded before the last interruption. The state file still lists the correction task as waiting. Its live upstream status was not independently queried. The revised export and acceptance are not established.

## Recommended repair order

1. Cover the exact `stream_read_error` transient error in Pi's model-step retry classification, with bounded backoff and a regression test using the production error shape. Retry the failed model step while retaining completed tool results; do not blindly replay the whole Turn or paid media submissions.
2. Preserve structured provider errors and correlate gateway request IDs with Session/Turn/model spans. Investigate upstream resets using the two request IDs above; current evidence does not justify assuming that increasing an HTTP timeout will fix them.
3. Harden skill preflight: ossutil and process inspection availability, writable dependency paths, prompt-length validation, ASCII upload aliases and appropriate delegation budgets.
4. Resume from the saved review-revision stage, check the existing correction task before submitting another, then re-export and review the film.

Investigation only: no production configuration changes, restarts, new generation requests, or Session continuation were performed. This report is the only repository change.
