# auto-story acceptance — 2026-09-07

Target: `https://agentry.welltop.tech`, Shanghai `agent-platform`, namespace
`oma-infra`. The default local kubeconfig points elsewhere; use the explicit
`agent-platform-config` for this installation.

## Agent and original Skills

Created [auto-story](https://agentry.welltop.tech/agents/agent_8kC4R3BvbC1FxNRzLOm63)
for the existing `brozhong` tenant.

- Agent id: `agent_8kC4R3BvbC1FxNRzLOm63`
- Runtime/model: `pi-agent`, `openai-codex/gpt-5.6-sol`
- Sandbox template: `auto-story`
- Equipped original local Skills: `byted-mediakit-shared`,
  `byted-mediakit-audio`, `byted-mediakit-editing`, `byted-mediakit-image`,
  `byted-mediakit-video`, `vfs-cli`, `video-analysis`.

No Skill packages were added to the repository or image. Import used the local
Skill files and original embedded VFS CLI Skill source. Cross-Skill references
were adapted only in the Agent's independent forks; original files and shared
Library contents remain independent. A repeat provisioning run completed with
the same Agent and fork ids.

## Three-model live check

Real requests used a temporary copy of the local Pi credentials and exactly the
sanitized deployment model definitions. Each returned `OMA_MODEL_OK`:

| Model | Pi thinking | Provider effort | Result |
| --- | --- | --- | --- |
| K3 | xhigh | max | pass |
| GPT-6 Astra | max | max | pass |
| GPT-5.6 Sol | max | max | pass |

Original local auth was unchanged; the temporary auth copy was removed. The
built Host image's actual installed adapter source and all three configured
thinking levels were also checked offline.

## Real local Skill dependency checks

`deploy/auto-story/e2e/run.py` completed successfully with a synthetic three
second H.264/AAC video: red background, white box, continuous 440 Hz tone.

| Check | Result |
| --- | --- |
| MediaKit local video and audio metadata | pass |
| MediaKit local trim, file/duration/audio verification | pass |
| MediaKit Cloud image metadata | pass |
| VFS embedded Skill and generation schema | pass |
| Real authenticated VFS read | pass |
| Official Gemini actual video + audio analysis | pass |
| Uploaded Gemini file deletion | pass |

Gemini used `gemini-3.8-flash`, returned timestamped observations matching the
synthetic visuals and tone, and reported successful file cleanup. No VFS project
was modified or generation job launched. Raw credentials and VFS records were
excluded from saved results.

Local report: `/private/tmp/auto-story-e2e-verified/report.json`.

## Code verification

- 251 adapter tests passed, including runner tests rerun outside the local IPC
  restriction; full adapter TypeScript checks passed.
- 290 API tests passed; the additional three provisioning integration tests
  passed through the real upload/equip/file APIs. API TypeScript check passed.
- 118 web tests passed; production web build and TypeScript check passed.
- Five provisioning/subagent Node tests passed; patched original subagent
  extension loaded successfully under SDK 0.80.10.
- Changed text files were checked against inherited credential values: none
  were present. `git diff --check` passed.

## Deployment and Agent Session acceptance

All three images were built, verified and published from the authorized `vfs-dev` builder. The deployed resources use their immutable registry digests:

| Image tag | Published and deployed digest |
| --- | --- |
| `oma-server:auto-story-20260907` | `sha256:7735b1354d498ad5c553cdcbc82ad11cb78736ab3d194ba35ba35d29a9a25179` |
| `oma-web:auto-story-20260907` | `sha256:a37176d90855779c76c716361e982976accdd6716c2076cd41fcbbfc1d3af372` |
| `oma-sandbox:auto-story-0.1.0` | `sha256:96ab935b6d775aeac5cd8a3f0c8fc5f1faf1d715f1345ba8ab57bc8467b0fd3f` |

Registry prefix: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/`.
The sandbox passed offline non-root verification with a minimal PATH, injected
environment marker, real H.264/AAC processing, MediaKit paths containing spaces,
VFS embedded Skills, and Gemini SDK Files/Interactions APIs. Its base layers and
ENTRYPOINT/CMD were preserved. Python resolves to `/opt/auto-story/venv` through
an explicit launcher. The web image passed `nginx -t` and HTTPS API-base checks.

Both Host containers and the web Deployment rolled out successfully. Health at
`https://agentry.welltop.tech/api/health` returned `{"status":"ok"}`; Host and web
had one available replica and zero restarts on the new Host. The auto-story
SandboxSet reported one updated available warm replica. The publicly served
`/assets/index-Dk3GbMf-.js` contains all three model choices, the auto-story
sandbox selector, and the correct HTTPS API base.

Dedicated Secret `oma-auto-story-env` supplies K3's Host credential and the
allowlisted auto-story sandbox environment. Existing `oma-pi-auth` was preserved.
All temporary API keys used to provision and test were revoked after use.

### Live model verification

Actual requests from the deployed Host returned `OMA_MODEL_OK` for K3, Astra,
and Sol at provider effort `max`. K3 used the Host environment key; Astra and
Sol used the Host's existing Codex OAuth. The Codex verification used SSE through
the deployment's egress dispatcher; both responses returned HTTP 200. The actual
Agent Session used GPT-5.6 Sol and its configured maximum thinking level.

### Live Agent acceptance: pass

[Successful acceptance Session](https://agentry.welltop.tech/sessions/sess_vouIHGpZUCAfi6YMYz67O)

- All seven equipped original `SKILL.md` files were read through real `read`
  tool calls from their `/skills/<fork-id>/` projections.
- Real `bash` execution ran the unchanged media/VFS/Gemini checks in the
  auto-story sandbox; the generated report has `ok: true`.
- MediaKit local video/audio metadata, local trim with duration/audio checks,
  and authenticated Cloud image metadata passed.
- VFS embedded Skill, generation contract and authenticated read passed.
- Gemini analyzed the actual video and audio and deleted its uploaded file.
- The Agent read the results and wrote `agent-verification.md` through its
  `write` tool. The Session completed without `session.error` events.
- Workspace storage contains the report, analysis, verification note, original
  synthetic video/audio/image, and trimmed H.264/AAC output.

Local API-level receipt:
`/private/tmp/oma-auto-story/live-session-proxy/acceptance.json`.

The first Session (`sess_Ak48hjCj0W2ejuZKdmyVe`) read the Skills and processed
local media, but direct sandbox connectivity to Gemini timed out. That test was
interrupted and was not counted as success. Auto-story now supplies the existing
agentry outbound proxy through its non-secret `sandbox.env` values. Its
`NO_PROXY` list keeps internal services, VFS and domestic media services direct.
The successful second Session used a fresh sandbox with this environment.

The Session harness also now accepts the API's empty HTTP 202 response and can
resume observing an existing test with `AUTO_STORY_E2E_SESSION_ID`, preventing a
client-side response-parsing failure from creating duplicate work.

### Video interpretation limit

This is a functional integration acceptance, not a semantic-accuracy benchmark.
Gemini recognized the red background, white shape and continuous tone, but called
the 120×100 rectangle a square, used approximate 00:00–00:02 timestamps for a
three-second clip, and added an unsupported maritime-flag interpretation. The
Agent explicitly recorded those errors in its verification note. They are not
endorsed as facts or hidden by the successful service-call result.
