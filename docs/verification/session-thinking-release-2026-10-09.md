# Session thinking and Codex connection release — 2026-10-09

## Released behavior

The Session composer displays its model and thinking preference. Clicking it
opens a stepped slider and a reset action. An unset/null preference inherits
the Agent; an explicit preference is persisted on that Session only. Changes
apply when the next Turn starts, including previously queued input. Running
Turns and resumed wait checkpoints keep their established configuration.
Normal Sessions follow the live Agent; Loop Sessions use their Agent snapshot.
Pi remains responsible for mapping preferences to supported model levels.

## Source and artifacts

- Local source commit: `57f6498` (`codex/session-thinking-controls`).
- Builder checkout: `/tmp/oma-session-thinking-57f6498` on `vfs-dev`.
- Builder commit: `3772af8c`; source tree equals local source exactly:
  `04328943be4c829db10a3d22b2c0f4cee5bedca7`.
- Image tag: `session-thinking-57f6498`.
- Server manifest: `sha256:8d896422622729286d0c5b43ea7f5d04d2c306124d5b1c84b5c5a463d74cf961`.
- Web manifest: `sha256:3ee6a0ed7446dd9dacf46ec2fd394d742da2b51cdbbe60a8182dd82e3c0826ed`.

Source was synchronized as a diff against the builder's existing checkout after
its GitHub fetch failed. No repository history or credentials were transferred
in the build patch. The identical tree hash was verified before building.

## Deployment

Production target: `agent-platform`, namespace `oma-infra`.

Applied `0019_session_thinking.sql`. Acceptance also identified that the existing
Agent thinking migration had not been applied in production despite its Web
control being present. Applied the additive Agent `thinking` column from 0017,
then verified the application role can update both columns. All existing rows
retain null defaults. The pre-migration canary Agent creation returned HTTP 500;
it passed after the missing prerequisite was applied.

Updated only the image fields of `oma-api`, `oma-runner`, and `oma-web`, with
old-image guards and server-side dry runs. The legacy zero-replica `oma-server`
was not used. Runner updates were performed after confirming no pending input.
All three Deployments reported one updated, ready replica.

Separately updated the `openai-codex` provider in `oma-pi-gateway` from the local
Codex provider configuration, using its Responses endpoint and file-backed API
key. Preserved all ten configured Codex model IDs and all other providers.
Updated both provider-wide and per-model endpoints, and the mounted API-key
credential. No credential values are recorded in source, build artifacts, or
this report. A restricted local Secret snapshot was retained for rollback.

## Validation

- 111 focused tests passed across composer/picker, Session page, API, Session
  store, and Runner configuration forwarding.
- All server workspace type checks passed.
- Web production build and changed-file ESLint checks passed.
- OpenAPI generation/check passed (four pre-existing documentation warnings).
- Browser preview verified the popover, keyboard slider adjustment, and reset.
- Public readiness returned `{"status":"ok","role":"api"}`.
- Public OpenAPI exposes `Session.thinking`; the deployed Web bundle contains
  the new Session picker and reset control.
- Mounted runtime endpoint and credential matched the local configuration;
  real Astra and Sol inference probes each returned `OK`.
- Isolated live fixtures verified Session update/readback, sibling isolation,
  and unchanged Agent preference. Pi's durable native entry recorded `low` for
  the override. Reset to null and a second Turn both succeeded.
- Two completed live fixture runs each recorded two completed Turns and zero
  Session errors. Four fixture Sessions are terminated and hidden; temporary
  Agents were deleted and Workspaces hidden. All four temporary API keys,
  including the early failed setup attempts, were revoked.

Session/Workspace cleanup uses soft deletion and retains the isolated canary
history. No pre-existing user resources were changed by acceptance tests.
