# Turn activity and live subagent results — 2026-09-16

## Release

Production: https://agentry.welltop.tech, Kubernetes `agent-platform/oma-infra`.

- Web: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web:8d7e0409dcfb`.
- Server: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server:ca5fdc6d2848`.
- Both images built with the repository `build.sh --push` on `vfs-dev`; deployed through `deploy/scripts/deploy-app.sh` using its image-only rollout.
- The deployed baseline was `b185d01de549`, which includes the Skill workbench. Web includes that baseline; Server release branch `codex/turn-activity-production` adds only the result-stream fix to that baseline. Unrelated Server changes from main were not deployed.
- Before the Server rollout, the database contained 78 idle and 36 terminated Sessions, with none running/waiting. Both Deployments became ready and the external health check returned `{"status":"ok"}`.

Implementation is on `codex/turn-activity-collapse`: frontend `cbd62ad`, integration with deployed baseline `8d7e040`, live notification fix `9bae450`. The narrow production branch contains equivalent frontend commit `01f6d9f` and Server fix `ca5fdc6`.

## Real test setup

Tests were submitted through the authenticated production browser, using real `openai-codex/gpt-6-astra` Agent calls and Sandbox bash execution. The commands only sleep and print distinct verification markers. No mock events or manually fabricated model responses were used.

- [Parent Session](https://agentry.welltop.tech/sessions/sess_hjEeoyNmv10TgvEJKRmao)
- Agent: `agent_Gm9zOmeyCQ6seu0O0XEwI` (`test-gpt6`)
- Workspace: `ws_oZF6pRemO4D6IQ-QqnVL7`
- Synchronous child: `sess_l-2MWIQgPT1KIHWGByAl0`
- Asynchronous child: `sess_GHqnzevcnIAGMHMywMviW`

Browser evidence records actual DOM text, `aria-expanded`, process visibility, notification counts and the Stop button. Read-only PostgreSQL queries independently verify event ordering, child identity and execution state. Times in the JSON evidence are UTC.

## First pass and the bug found

The first pass ran four parent Turns: synchronous child creation; asynchronous child creation; another user Turn while the child ran; an automatically started result-consumption Turn.

- Active processes expanded automatically. On final response completion the parent Turns collapsed independently, with `Worked for 40s`, `12s`, `1m 11s`, and `9s`; final answers remained visible.
- Async `subagent.result` arrived at parent seq 39 during `turn_33_a1`. It was claimed at seq 46 only after that Turn completed at seq 45, starting a separate `turn_46_a1`.
- Manual expansion showed compact subagent result rows alongside tool rows. Expanding the row rendered `ASYNC_CHILD_OK` as Markdown strong text.
- Opening the Agent call displayed the actual Child Session, including its own completed Turn (`Worked for 26s`).
- A real defect was found: `finishExecution` persisted `subagent.result` inside its transaction without publishing it to the live event hub. The synchronous result was absent from the connected browser until reload. Async claim processing still appeared because that later event used the normal Router stream path.

The Server fix publishes the committed parent notification before waking the parent. Two regression tests cover both synchronous and asynchronous arrival while the parent Turn is still running; they assert one stream publication matching the durable event, before a claim or parent completion.

## Post-fix verification

- A later parent Turn resumed the same synchronous child using `Agent.resume`. The child's execution sequence advanced to 2 and its Turn changed from `turn_1_a1` to `turn_13_a1`; no replacement child was created.
- Parent seq 65 persisted the resumed result at `15:44:48.188Z`. At `15:44:49.559Z` the continuously connected browser already showed one subagent result in the active expanded process, without reloading. The parent then ran another real bash command before completing at seq 77. Its Turn automatically collapsed to `Worked for 1m 1s`, preserving the final `RESUME_PARENT_OK`.
- The same asynchronous child was also resumed in a later parent Turn (execution sequence 2), then another user Turn was started while that child remained running.
- Async result seq 96 arrived at `15:46:29.943Z` during parent `turn_90_a1`. The continuously connected browser showed it inside that still-running Turn at `15:47:14.448Z`. Parent completion seq 102 occurred at `15:47:17.718Z`; claim seq 103 followed at `15:47:17.725Z`, referencing notification seq 96.
- The new `turn_103_a1` automatically expanded. The preceding Turn automatically collapsed to `Worked for 1m 23s`. Its transient notification moved into the consuming Turn: the DOM held exactly one row for that result. The automatic Turn ran its requested bash check and collapsed to `Worked for 22s`, with `LIVE_ASYNC_PARENT_OK` visible.
- All eight completed parent Turns were collapsed automatically. Reload produced exactly the same eight duration labels and per-Turn notification counts `[1, 0, 0, 1, 1, 0, 0, 1]`. Manual expansion of the final Turn and its result row rendered `LIVE_ASYNC_CHILD_OK` as Markdown strong text.
- Final read-only database assertions passed: 8 parent Turns, 2 child Sessions, 4 completed delegation executions, 4 result-arrival records, 2 async claims; both children retained their IDs on resume. All three test Sessions are idle, with their history retained for inspection.

`subagent.result` means the result has arrived and been durably recorded. `subagent.result_claimed` means the queued async result has been promoted into a new parent model Turn. They describe different lifecycle points, especially when the parent is busy. The trajectory keeps both records for diagnosis; Conversation projects them to one result row. Synchronous results are consumed within the calling Turn and do not require a separate async claim Turn.

## Automated checks

- Integrated Web suite: **337 tests passed**, 46 files; production build passed.
- Session Router on the integration branch: **99 tests passed**; typecheck passed.
- Exact Server production baseline plus fix: **98 tests passed**, 6 files; typecheck passed. The count differs because main includes an unrelated newer test.
- The first parallel Web build/test run encountered two test timeouts; their targeted rerun and the complete suite with two workers passed. Full Web lint still reports the previously existing errors; changed frontend files passed targeted lint.

## Evidence

- [Browser state snapshots](turn-activity-2026-09-16/ui-evidence.json)
- [Event ordering and database assertions](turn-activity-2026-09-16/events.json)
- [Live resumed result screenshot](turn-activity-2026-09-16/live-resumed-result.png)
- [Automatic result-consumption Turn](turn-activity-2026-09-16/live-overlap-result.png)
- [Completed and collapsed](turn-activity-2026-09-16/completed-collapsed.png)
- [Completed and expanded, including Markdown result](turn-activity-2026-09-16/completed-expanded.png)
