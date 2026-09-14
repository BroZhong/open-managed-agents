# OSS Workspace production release — 2026-09-14

Published and deployed to https://agentry.welltop.tech using the Shanghai
`agent-platform` cluster. Host and Web are ready at 1/1. Production uses only
`auto-story-v2`, including existing Agent overrides; the temporary verification
and restored legacy template entries have been removed.

The release source is `2f21683`, incorporating current production baseline
`df7f1eb` before the OSS changes. PostgreSQL, Redis, Supabase Skills, proxy,
Pi model/auth Secret mounts, media tools and current production features were
preserved. There is no migration or deletion of historical Supabase business
files; Workspace file APIs now use OSS exclusively.

## Deployed immutable images

All images are under `registry-vpc.cn-shanghai.aliyuncs.com/welltop`.
The same digests are available through the public Shanghai registry hostname.

| Image | Tag | Digest |
| --- | --- | --- |
| `oma-server` | `oss-workspace-2f21683` | `sha256:a37ff0d2ef1d0503781f98cdfe5e78cd3b609cd1e7efa03d9e945ab4b3efc51b` |
| `oma-web` | `oss-workspace-2f21683` | `sha256:14202012ed917d20d861245c2a1b77ae4c3faf8af8e3c98811ef2d2428f7cadf` |
| `oma-sandbox` | `auto-story-v2-oss-workspace-f98d729` | `sha256:254c2618e695504a673665d2dc261a8799d51492f40e9aeff7d98fc6f8f9f5c1` |

The Sandbox overlay preserves the existing `auto-story-v2` runtime digest and
adds the local HOME/mounted Workspace environment. Its source was unchanged by
the subsequent Host storage fix and build-cache improvements.

## Build performance

Web now installs from manifests before copying source. Host adapter dependencies,
Server dependencies and Pi extensions are separate stages. Architecture-specific
BuildKit pnpm/npm caches retain downloads across layer invalidation and failed
installs. Pi extensions install in separate steps, with their guarded patches
preserved. Cache mounts are excluded from the runtime image.

A repeated unchanged build, including registry push, took **6.16 seconds for
Host** and **6.09 seconds for Web**; all RUN steps were cached. During the first
build with the new layout, Host pnpm installs downloaded zero packages after
seeding the cache from the preceding build. Pi MCP installation dropped from
about 15 minutes to 90 seconds. These measurements use the same warm builder;
a fresh or pruned builder still needs downloads. Public Web builds on Apple
Silicon used the separately published native arm64 Node base, while both
production runtime images are amd64.

## Validation and cleanup

- Full Server tests: 753 passed, 3 optional live checks skipped. Adapter: 354
  passed. Web: 229 passed. Deployment checks: 9 passed, 1 optional network check
  skipped. Server, Adapter and Web typechecks passed.
- A separate Pod loaded the published Host image, compared all 19 source files
  in the API's actual Adapter import targets against the release source, verified
  the Pi seed packages, and imported the Pi Adapter successfully on x64.
- Isolated instances of the published Sandbox overlays passed ordinary-user
  mount checks, Host/native filesystem Unicode and binary read/write, shell
  file creation, listing and persistence through instance replacement.
- Two real production Pi Turns used `openai-codex/gpt-6-astra` and
  `auto-story-v2`. They read `/skills/release-check-skill/SKILL.md`, read and edited
  an uploaded Chinese filename, wrote files through bash/Python and native
  `write`, and listed the mounted Workspace. Host download bytes, MIME and
  attachment headers, public HTTPS signed preview and unauthenticated denial
  passed.
- After deliberately reclaiming only the test Sandbox, the second Turn created
  a new instance, read the existing file and named Skill, and wrote a fourth
  file. The production browser displayed it automatically without Refresh.
  During the active Turn, file writes returned HTTP 423 and UI edits were disabled.
- Session termination retained all four business test files. After this check,
  the isolated test files, Skill library/fork, Agent, Session, account and
  metadata were removed. No test Sandbox, verification Pod or template remains.
  Existing application data remains at 1 user, 4 Agents and 20 idle Sessions,
  with no pending input. Public Web and `/api/health` both return HTTP 200.

The earlier real credential-refresh test ran for 3901.55 seconds on one mounted
Sandbox and passed. Its evidence is retained in the existing
[cloud verification record](../deploy/sandbox/oss-workspace/verification.json);
it was completed before this production switch.

[Machine-readable production evidence](../deploy/sandbox/oss-workspace/production-verification.json)
and [browser screenshot](../deploy/sandbox/oss-workspace/production-verification.png)
contain no credentials or signed URLs. Temporary local deployment credentials
are removed after the release; production reads its dedicated least-privilege
Host key from the managed Kubernetes Secret.

## Novel-to-film acceptance — 2026-09-15

A retained production Agent ran the `welltop-cn/auto-story-skills` package at
`76f82520c7327afaf1207e2285dc0493e37c0b74` on `auto-story-v2`. Its 16 Skills and
116 files were imported and individually read back; projections use
`/skills/<skill-name>/`. The run fetched all 30 chapters and the outline for
novel 73994, then adapted the end of EP1 and EP2 into a narrated short film.

The final artifact is `novel-73994/final/film.mp4`: 120 seconds, 720×1280,
24 fps, H.264/AAC, 14,019,408 bytes, with 262 English narration words and
48 burned English subtitle cues. Its SHA-256 is
`7bc97d91ce269c444d8c04b5170844152a0f1e7527a96d81288b21298eedc061`.
Full decoding and normal-speed browser playback passed; the production browser
decoded all 2,880 frames with zero dropped frames. The final audible-video
Gemini review passed with no reported defects and nine paired media processing
calls/results. Seven final review/delivery input hashes matched, and the local
delivery was byte-identical to the canonical Workspace file. Both `review.json`
and `delivery.json` are ready with no unresolved items.

This was a complete artifact workflow with operator intervention, not an
unattended reliability pass:

- Two SeedAudio responses contained valid audio but omitted the subtitle field,
  so VFS reported failure. Existing audio artifacts were recovered without
  regeneration or billing changes; the Agent selected the complete candidate.
- Two external VFS releases lost four in-flight video task records. Their
  original successful provider artifacts were recovered after matching task
  identities and prompts, without resubmitting generation or changing billing.
- The Agent resumed from the persistent Workspace after an external Host
  restart, and repaired its concurrent task-summary writes. Gemini review
  retrieval used the existing interaction's stream after ordinary GET timeouts.
- After the Agent's final response and delivery validation, the active-turn
  write gate still returned 423. An explicit interrupt ended the completed
  execution, after which independent verification records were uploaded and
  read back. The retained execution-state issue is not claimed fixed here.

Agentry was production; the existing real VFS provider configuration used
`RUNTIME_ENV=test`. Agent `agent_m39Qg5bPzpjXQFQnovzuN`, Session
`sess_1Rfcfh_Vvbr-vwyyZn9PS`, all Skills and generated media remain available.
The Workspace includes `final/operator-run-report.md` and the final review and
delivery evidence. The temporary access key was revoked and verified to return
401; temporary local credentials and the preview server were removed.
