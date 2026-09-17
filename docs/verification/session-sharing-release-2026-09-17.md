# Session and Workspace sharing production verification

Scope: #154 and #155. Deployed and tested at https://agentry.welltop.tech on
2026-09-17 following explicit authorization to deploy and test production.

## Release

- Application commit: `dae5be156b0ce80158156f2c6eaf8f035c4232d6`, branch
  `codex/session-workspace-sharing`. This release was built from that commit;
  it does not imply a merge to main.
- Built and pushed server and web on `vfs-dev` with `build.sh --push server web`.
  Both deployed image tags are `dae5be156b0c`.
- Server manifest digest:
  `sha256:880b178eaa2791ba28f7da3b1c7d9de8b4adb30d54e4433c04aa843bed44a1aa`.
- Web manifest digest:
  `sha256:e08243580911c34da9f4152c101371299d97d8acbbd34a3218e4594266fb01e7`.
- Applied `deploy/migrations/0013_session_shares.sql` transactionally through
  the configured Supabase postgres-meta service, after verifying that it and
  the Host connection access the same database. Schema initialization is disabled
  in production. Confirmed the table is readable by `oma_app`, with SELECT,
  INSERT and UPDATE privileges and without DELETE privilege.
- Ran the deployment script's dry run, then
  `deploy/scripts/deploy-app.sh --tag dae5be156b0c --apply --confirm-production`
  using the production kubeconfig and `oma-infra` namespace.
- Both deployments completed successfully. After release, also replaced the
  Host pod to test persistence. No running/waiting Sessions or pending inputs
  were present before the rollout or deliberate restart.
- Final state: server and web each ready `1/1`; public `/api/health` returns
  `{"status":"ok"}`. Public OpenAPI includes the share endpoints.

## Production checks

All **60 recorded assertions passed**. The
[assertion record](session-sharing-production-2026-09-17.json) contains each
result, the disposable fixture identifiers and final cleanup counts.

Tests used a separate disposable Tenant, User, Agent, Sessions and Workspaces.
HTTP requests passed through the public production ingress. History was seeded
as synthetic durable events in PostgreSQL; no model Turns were submitted.

- Sixteen concurrent share creations against real PostgreSQL returned one ID.
  Independent processes and an actual replacement Host pod retained that ID
  and could read history. This closes the pg-mem-only limitation in the earlier
  implementation verification.
- All 213 initial events loaded over three pages, including thinking and tool
  events. A subsequent event became visible after manual refresh (214 total).
- Anonymous access succeeded. Mixed owner/share credentials still received the
  restricted projection. Forged shares did not borrow owner credentials.
- Session/Workspace lists, Agent/Skill access, sibling and child Sessions,
  another Workspace, signed URLs, SSE, and every tested mutation were denied.
  Rejected messages did not enter the queue; rejected writes left files intact.
- File reads reflected subsequent owner writes. Traversal and encoded unsafe
  paths were rejected. Download responses returned expected bytes with an
  attachment disposition. Image, audio and video reads passed through the Host.
- Termination preserved sharing. Session deletion invalidated resolution,
  history, file lists and file content. Workspace deletion invalidated another
  share bound to that Workspace.

## Browser verification

Used the deployed web app and ordinary login/logout with the disposable User.

- Owner dialog has the fixed 240px clipped preview and gradient. Copy shows
  已复制; reopening and copying returns the same URL.
- The share page works while logged in and after logout. It has no composer or
  file mutation actions; child Session links render as text.
- Conversation file links open read-only text. Missing files display feedback.
  Image previews load; audio/video Blob previews report one-second duration
  without media errors. Browser error/warning logs were empty during these checks.
- Manual refresh displays the added message, modified report and new file.
  The page still works after Host replacement.
- After Session deletion, refresh displays 分享已失效 without redirecting to login.

[Read-only production page](session-sharing-production-2026-09-17.png) ·
[Invalidated production share](session-sharing-production-invalidated-2026-09-17.png)

Native browser file-save completion was not independently confirmed. Download
bytes and response headers passed live HTTP checks; browser download dispatch
is covered by the implementation's DOM tests.

## Cleanup

Removed all synthetic objects from both test Workspaces through the configured
OSS ArtifactStore. Terminated and soft-deleted the four test Sessions, deleted
both Workspaces and the test Agent, revoked every temporary API key in both test
Tenants, and removed the exact disposable User. Final database checks confirmed
zero matching Users, active keys, Agents, live Sessions, live Workspaces or
pending events. Soft-deleted Session records and synthetic history remain as
audit data. Both test shares are invalid. Closed the browser test tabs and
removed temporary credential files.

No application code changed during deployment verification. The full suite and
review results are recorded in the
[implementation verification](session-sharing-2026-09-17.md).
