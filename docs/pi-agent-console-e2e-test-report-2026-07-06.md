# Pi Agent Console E2E Test Report

Date: 2026-07-06 Asia/Shanghai

Scope: frontend end-to-end testing for `https://console.sandbox.brozhong.com/`.
Boundary: test and record only; no fixes were attempted.

Cluster correction: the deployment verification in this report uses the `brozhong`
Aliyun account and the Hong Kong ACK cluster. An earlier local kubectl context
pointed at a different Shanghai cluster; conclusions from that context were
discarded.

## Summary

The main Pi Agent console flow is partially working:

- User login works.
- Pi Agent creation works with runtime `pi-agent` and model `openai-codex/gpt-5.4`.
- Agent Files are saved and injected into the Pi Agent prompt.
- Workspace artifacts can be listed, previewed, and downloaded after a turn completes.
- Local `vfs-cli` works end to end for the provided VFS project: health check, 10-shot storyboard creation, video generation, and resource query.
- The brozhong Hong Kong deployment is connected to PostgreSQL, Redis, S3 workspace storage, and sandbox execution.
- PostgreSQL contains the tested Agent, Agent Files, Session, event log, and event counter.
- Redis active-turn and per-turn delta stream keys were observed while a probe turn was running, then cleaned up after turn completion.
- The session event log contains enough structured data to reconstruct Pi Agent history in principle: user messages, assistant messages, tool calls, tool results, model metadata, and matching `toolUseId` values are present.

However, several acceptance criteria fail in the current deployed environment:

- Equipped Skills are persisted on the Agent but are not visible to Pi Agent at runtime.
- The Pi Agent sandbox becomes unavailable across turns, breaking later tool calls and workspace sync.
- A fresh sandbox probe also failed to run a simple shell command because `/workspace` was missing as the requested cwd.
- The frontend does not live-update the second turn until page reload.
- Workspace artifacts appear after turn completion, not while the turn is still running.

## Test Entities

- Console URL: `https://console.sandbox.brozhong.com/`
- Test user: `brozhong`
- Agent: `agent_y_nj1FyuvTVI1md7L5h1m`
- Agent name: `E2E Pi Agent 2026-07-05T15-52-31-805Z`
- Runtime: `pi-agent`
- Model: `openai-codex/gpt-5.4`
- Session: `sess_afR0j3IPYa5d0nuIYPEym`
- Uploaded/equipped Skill: `skill_JWy7c-wMVMIC2RCAY4D2W`
- Skill name: `oma-e2e-marker`
- Redis probe session: `sess_X_Br58dATzJeFIvUFqAAA`

## Deployment Verification

Verified with Aliyun profile `brozhong`, region `cn-hongkong`.

- ACK cluster: `cloud-agent-hk`
- Cluster ID: `c2626526892cf4a0592b4bc06660ae047`
- Kubernetes context: `207189382891364128-c2626526892cf4a0592b4bc06660ae047`
- API server: `https://8.217.40.193:6443`
- Namespace: `oma-infra`
- Deployments: `oma-server`, `oma-web`, `redis`, `sing-box`
- Server image: `crpi-egv1p3qc9sh5spft.cn-hongkong.personal.cr.aliyuncs.com/brozhong/oma-server:be5a721`

`oma-server` startup logs confirmed:

```text
Connected to PostgreSQL (pgm-j6cwo1dku533bqbs.pg.cnhk.rds.aliyuncs.com:5432, schema=oma)
Connected to Redis (pending queue + delta streams + active-turn map)
Workspace artifact store enabled (S3 at http://172.17.108.247:80/storage/v1)
Sandbox ToolExecutor enabled (e2b SDK, hydrate from S3)
Adapters: claude-code, codex, pi-agent
```

Relevant non-secret config:

```text
PG_DATABASE=supabase_db
PG_HOST=pgm-j6cwo1dku533bqbs.pg.cnhk.rds.aliyuncs.com
PG_SCHEMA=oma
PG_USER=oma_app
REDIS_HOST=10.0.56.147
REDIS_PORT=6379
S3_BUCKET=workspace
S3_ENDPOINT=http://172.17.108.247:80/storage/v1
SANDBOX_ENABLED=true
SANDBOX_TEMPLATE=code-interpreter
```

## Passed Checks

### Login

Login with the provided test user succeeded and redirected to the console overview.

### Agent Creation

Created a Pi Agent successfully.

Observed configuration:

- `runtime`: `pi-agent`
- `model`: `openai-codex/gpt-5.4`
- `sandbox.enabled`: `true`

API verification showed:

```json
{
  "id": "agent_y_nj1FyuvTVI1md7L5h1m",
  "model": "openai-codex/gpt-5.4",
  "runtime": "pi-agent",
  "skills": ["skill_JWy7c-wMVMIC2RCAY4D2W"],
  "sandbox": { "enabled": true }
}
```

### Agent Files

Saved all four Agent Files through the frontend:

- `IDENTITY`
- `SOUL`
- `USER`
- `MEMORY`

The Agent later echoed all four markers, proving the files were injected:

- `AF_IDENTITY_ACTIVE_20260705155231`
- `AF_SOUL_ACTIVE_20260705155231`
- `AF_USER_ACTIVE_20260705155231`
- `AF_MEMORY_ACTIVE_20260705155231`

### Workspace Artifacts

The Agent created three files during the first turn:

- `workspace/agent-file-markers.txt`
- `workspace/e2e-summary.md`
- `workspace/skill-e2e-result.txt`

After the turn completed, the Workspace tab showed `3 files`.

Preview worked for all three files. Download worked for `skill-e2e-result.txt`; the file appeared at:

```text
/Users/zhangyuzhong/Downloads/skill-e2e-result.txt
```

### vfs-cli Local End-to-End

Local `vfs-cli` health check passed:

- `VFS_TOKEN`: set
- OSS credentials: set
- command gate: open
- environment: `dev`
- pixel-director: reachable
- yjs-server: reachable

For the provided project URL:

```text
https://pre-pixel-director.creativefitting.cn/studio3/projects/details/?id=1783266288721&twid=0e8a6b4567844a75be51cd334f387735
```

The project initially had `0` shots.

Created 10 E2E shots:

- `E2E-20260705155231-01` -> `6a4a8030a093a87ee5ed6679`
- `E2E-20260705155231-02` -> `6a4a8032a093a87ee5ed667a`
- `E2E-20260705155231-03` -> `6a4a8032a093a87ee5ed667b`
- `E2E-20260705155231-04` -> `6a4a8033a093a87ee5ed667c`
- `E2E-20260705155231-05` -> `6a4a8035a093a87ee5ed667d`
- `E2E-20260705155231-06` -> `6a4a8036a093a87ee5ed667e`
- `E2E-20260705155231-07` -> `6a4a8037a093a87ee5ed667f`
- `E2E-20260705155231-08` -> `6a4a8038a093a87ee5ed6680`
- `E2E-20260705155231-09` -> `6a4a8038a093a87ee5ed6681`
- `E2E-20260705155231-10` -> `6a4a8039a093a87ee5ed6682`

Video generation succeeded:

```json
{
  "resource_id": 93447,
  "task_id": "6a0f9120-1b2f-481b-a617-cebd4e760bd4",
  "type": "video",
  "url": "https://pre-pixel-director.creativefitting.cn/video_gen_sse/65beff926a004f8a93f2e64d7d912b26.mp4"
}
```

`resource query --resource-id 93447` also succeeded.

### PostgreSQL Storage

Queried the Hong Kong RDS through the running `oma-server` pod.

The original E2E session is stored in PostgreSQL:

- Session: `sess_afR0j3IPYa5d0nuIYPEym`
- Tenant: `c912f882-3c5c-4355-8b7e-ca6aaccf58bc`
- Agent: `agent_y_nj1FyuvTVI1md7L5h1m`
- Workspace: `ws_uTpqKSh7KpI2B-htTS-26`
- Status: `idle`

The tested Agent is stored in PostgreSQL:

- Runtime: `pi-agent`
- Model: `openai-codex/gpt-5.4`
- Sandbox: `{ "enabled": true }`

All four Agent Files are stored in `agent_files`, and each contains the expected
marker:

- `IDENTITY`: `AF_IDENTITY_ACTIVE_20260705155231`
- `SOUL`: `AF_SOUL_ACTIVE_20260705155231`
- `USER`: `AF_USER_ACTIVE_20260705155231`
- `MEMORY`: `AF_MEMORY_ACTIVE_20260705155231`

At the time of the DB check, the original E2E session had continued past the
initial test because a later user message was sent in the same conversation.
Current DB state:

- `events` rows for original session: `61`
- `event_counters.seq`: `61`
- Redis probe session `event_counters.seq`: `36`
- Additional later message at seq `53`: `sandbox 不可用是什么意思`

For the original E2E acceptance window, seq `1` through `43` are the relevant
events from the first two test turns.

### Redis Runtime Probe

Redis is used for transient turn state, not durable post-turn storage. After a
turn finishes, `session:active-turn:*`, `stream:turn:*`, and `pending:session:*`
are reclaimed.

To verify runtime Redis behavior, a probe session was created:

- Probe session: `sess_X_Br58dATzJeFIvUFqAAA`
- Probe prompt: ask Pi Agent to call `exec` with `sleep 25 && echo OMA_REDIS_PROBE_DONE`

Observed while the probe turn was running:

```json
{
  "activeKey": "session:active-turn:sess_X_Br58dATzJeFIvUFqAAA",
  "targetActive": { "turnId": "turn_1", "status": "running" },
  "streamKey": "stream:turn:turn_1",
  "streamLengthProgression": [1, 42, 119, 182, 270, 308, 372],
  "pendingLength": 0
}
```

Observed after the probe completed:

```json
{
  "active": [],
  "streams": [],
  "pending": []
}
```

This confirms Redis has the expected runtime data while a turn is active and
cleans it up after completion.

## Bugs

### P0: Equipped Skill Is Not Visible to Pi Agent Runtime

Expected:

- Uploading a Skill to the library and equipping it on an Agent should materialize that Skill into the Pi Agent runtime.
- The Agent should follow the Skill instructions.

Observed:

- Skill upload via API succeeded.
- Frontend displayed the Skill.
- Equipping the Skill updated the Agent `skills` array.
- The Agent still reported that it could not see any `SKILL_E2E_*` marker.
- The file `workspace/skill-e2e-result.txt` contains:

```text
No visible SKILL_E2E_* marker found in current system prompt, Agent Files, or equipped skill instructions.
```

Impact:

- Skill Library and Agent equipment appear to persist correctly, but equipped Skills do not affect runtime behavior.
- Users can believe a Skill is active when it is not.

Evidence:

- Skill ID: `skill_JWy7c-wMVMIC2RCAY4D2W`
- Immediate Agent `skills` after equip included `["skill_JWy7c-wMVMIC2RCAY4D2W"]`
- Agent response: no `SKILL_E2E_*` marker visible.
- Later PostgreSQL check showed the Agent still references `skill_JWy7c-wMVMIC2RCAY4D2W`, but the `skills` table no longer has a row for that skill ID. Current referenced skill rows exist only for `teach` and `ljg-read`.

### P0: Pi Agent Sandbox Becomes Unavailable Across Turns

Expected:

- A session's sandbox-backed executor remains usable across turns.
- Later tool calls should run in the same workspace context or a correctly rehydrated sandbox.

Observed:

On the second turn, the Agent attempted:

```sh
command -v vfs-cli || true
vfs-cli version --format json || true
vfs-cli doctor --format json --timeout 20s || true
```

All sandbox tool calls failed before process execution:

```text
Sandbox is probably not running anymore
```

Writing `/workspace/vfs-cli-sandbox-check.txt` also failed:

```text
API Error: healthy sandbox sandbox-system--code-interpreter-tz8wx not found
```

The event log recorded:

```json
{
  "type": "session.error",
  "data": {
    "error": {
      "code": "workspace_sync_error",
      "message": "SandboxNotFoundError: Sandbox is probably not running anymore"
    }
  }
}
```

Impact:

- Multi-turn Pi Agent tool use is unreliable.
- Workspace sync can fail after the model has already produced a response.
- `vfs-cli` cannot currently be validated inside the Agent sandbox.

### P0: Fresh Sandbox Probe Cannot Use `/workspace` as cwd

Expected:

- A fresh Pi Agent sandbox should have a usable workspace directory for tool execution.

Observed:

- A new probe session `sess_X_Br58dATzJeFIvUFqAAA` asked the Agent to run `sleep 25 && echo OMA_REDIS_PROBE_DONE`.
- The Agent responded:

```text
已调用，但执行环境的默认工作目录 `/workspace` 不存在，命令未能实际运行。
```

Impact:

- Even when the turn starts and Redis/SSE streaming work, basic sandbox command execution can fail before the intended command runs.
- This blocks validating `vfs-cli` from inside the Agent sandbox.

### P1: Frontend Does Not Live-Update Second Turn Events

Expected:

- After sending a second message, the session page should show new events as they arrive.
- Timeline count should update without a full reload.

Observed:

- The second user message was accepted and processed by the backend.
- Backend event log reached 43 events.
- Frontend remained at `Timeline (21)` until reload.
- After reload, the page showed `Timeline (43)` and rendered the second turn.

Impact:

- Users can think a turn was not processed or that the Agent is stuck.
- Realtime SSE/live merge behavior is inconsistent with history replay.

Evidence:

- Before reload: frontend `Timeline (21)`
- API event log: `count = 43`
- After reload: frontend `Timeline (43)`

### P1: Workspace Files Are Not Visible During Generation

Expected:

- Workspace artifacts should become visible while they are generated, especially after file-change events.

Observed:

- During the first running turn, Workspace tab showed `0 files`.
- Timeline count increased while the Agent was using tools.
- Only after the turn completed did Workspace show `3 files`.

Impact:

- Does not satisfy "see artifacts being generated during the conversation".
- Users cannot inspect in-progress outputs.

### P2: Browser File Upload Could Not Be Tested Through Chrome

Expected:

- The frontend Skill Library folder upload should be testable through Chrome automation.

Observed:

- Chrome file chooser was blocked by the Codex Chrome extension permission:

```text
fileChooser.setFiles failed: Not allowed
```

Workaround:

- Uploaded the same Skill via authenticated API fallback.
- Frontend list and equip behavior were still tested after API upload.

Impact:

- This is a test-environment limitation unless reproduced manually in a Chrome profile with file URL access enabled.

## Event Log / Pi History Notes

The observed session event log is structurally suitable for Pi Agent history reconstruction:

- Original E2E acceptance window: seq `1` through `43`
- Two E2E `user.message` events: seq `1`, `23`
- Two E2E `agent.message` events: seq `18`, `39`
- Six `agent.tool_use` events
- Six matching `agent.tool_result` events
- All model requests used `gpt-5.4`
- Assistant messages include:
  - `provider`: `openai-codex`
  - `api`: `openai-codex-responses`
  - `model`: `gpt-5.4`

The `toolUseId` values match between each `agent.tool_use` and its corresponding `agent.tool_result`, which is required for structured Pi history and provider-layer tool-call normalization.

Code expectations from the repository:

- `SessionRouter.buildAdapterInput()` builds `history` from prior event log entries.
- `eventLogToAgentMessages()` maps:
  - `user.message` -> Pi user message
  - `agent.message` + same-turn `agent.tool_use` -> Pi assistant message with `toolCall`
  - `agent.tool_result` -> Pi `toolResult`
- Same-model turns should keep tool IDs byte-stable, which is the intended KV-cache-friendly path.

Direct provider KV-cache hit/miss metrics were not exposed by the current
surface, so this test can validate request construction shape but not prove a
provider-side KV-cache hit. Based on the code and stored data, the deployed
path rebuilds Pi Agent history from canonical events and ignores transient
streaming chunks, which is the intended KV-cache-friendly construction.

## Recommended Follow-Up

1. Investigate why equipped Skill materialization does not reach Pi Agent runtime.
2. Investigate stale Skill references: the Agent can reference a Skill ID that no longer exists in `skills`.
3. Investigate sandbox lifetime/timeout and cross-turn executor reuse.
4. Ensure a fresh Pi Agent sandbox has a valid workspace cwd before tool execution.
5. Fix frontend SSE/live merge so second and later turns update without reload.
6. Emit or consume workspace file-change events while a turn is still running, not only at turn end.
7. Re-run the full E2E after Skill and sandbox issues are fixed.
