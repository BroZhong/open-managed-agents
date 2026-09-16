# OSS Workspace production release — 2026-09-14

> Historical OSS migration record (2026-09-14). Image digests, templates and
> observations below belong to that run. Session file routes and the HTTP 423
> write gate were superseded by [ADR-0009](adr/0009-workspace-file-api.md).
> Use [the deployment guide](../deploy/README.md) for current operations.

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
[cloud verification record](verification/oss-workspace/verification.json);
it was completed before this production switch.

[Machine-readable production evidence](verification/oss-workspace/production-verification.json)
and [browser screenshot](verification/oss-workspace/production-verification.png)
contain no credentials or signed URLs. Temporary local deployment credentials
are removed after the release; production reads its dedicated least-privilege
Host key from the managed Kubernetes Secret.
