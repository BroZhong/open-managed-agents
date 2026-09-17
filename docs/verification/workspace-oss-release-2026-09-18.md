# Workspace OSS direct reads: production verification

Deployed at https://agentry.welltop.tech on 2026-09-18 after explicit authorization
to configure CORS, deploy and test production.

## Release

- Application commit: `782b2be91561` on `codex/workspace-oss-direct-reads`.
  Both server and web images use this immutable tag. Later commits only update
  API inventory tests and release documentation, not the deployed application.
- Integrated `origin/main` at `c0989cf`, preserving the already deployed Session
  sharing feature. Owner and shared Workspaces use the same signed-read logic.
- Built and pushed both images on `vfs-dev` with `build.sh --push server web`.
- Server image manifest: `sha256:3be9ae10074c7855a871a56ac20c28cebdee2eff42742d087711de1410893ca1`.
- Web image manifest: `sha256:5eb562077d81ad88fed44a57d45492cbe8fef5581c00d899960f4a7fd4eb041c`.
- Deployment script dry run passed, followed by image-only rollout to
  `agent-platform/oma-infra`. Both Deployments ready 1/1; public `/api/health`
  returns `{"status":"ok"}`. No running/waiting Sessions before rollout.
- Previous image tag for rollback: `dae5be156b0c`. No database migration.

## OSS configuration

- Bucket: `agentry`, Shanghai; ACL remains `private`.
- Signing endpoint remains `https://oss-cn-shanghai.aliyuncs.com`.
  No custom preview domain, DNS or certificate was introduced.
- Applied and read back [console-cors.json](../../deploy/oss-workspace/console-cors.json):
  only `https://agentry.welltop.tech`, GET/HEAD, Range/conditional read headers,
  exposed content/range/ETag/disposition headers and 600-second preflight caching.
- Positive OPTIONS preflight and actual GET responses allow the console origin.
  An unrelated origin is not allowed. Unsigned object GETs return 403.

## Verification

Local checks after integrating Session sharing: web 363 tests; API 405 tests
with one existing live-test skip; TypeScript checks, web production build,
OpenAPI generation/check and 27 API inventory tests passed. Earlier store tests
passed (131 store and 58 memory-store tests; seven existing store skips).

Production used a disposable Tenant, mock Agent, Sessions and Workspaces.
No user files were modified and no real model Turns were submitted.

- `server/test-workspace-api.mjs`: **61 HTTP checks passed** through the public
  API, covering file lifecycle, Unicode paths, metadata descriptors, direct
  storage reads, signed attachment downloads, byte ranges, authentication,
  removed routes and shared/terminated Workspace access.
- Additional live checks verified five actual objects: PNG, MP4, text and PNG/MP4
  explicitly stored as `application/octet-stream`. Direct SDK uploads were used
  for the generic MIME fixtures because normal application uploads infer MIME.
- Every descriptor used `agentry.oss-cn-shanghai.aliyuncs.com`; the 14,168,173-byte
  MP4 descriptor was approximately 533 bytes. Range requests returned 206 and
  exactly 16 requested bytes, with CORS headers. Download disposition was correct.
- A one-second storage URL expired and returned 403; obtaining a fresh URL via
  the authorized API restored a successful 206 read. Shared writes returned 403.
- The first supplementary run incorrectly expected 206 for a range covering the
  entire 57-byte text file. OSS returned 200. The test was corrected to request
  bytes 0–15; all 22 checks in the corrected run passed. Two generic-MIME setup
  checks and four expiry/access checks also passed.

## Real browser

Used the deployed anonymous share page and its actual Workspace component.

- PNG displayed at 1254×1254. The image's `currentSrc` used the OSS domain.
  OSS returned `Content-Disposition: attachment` and `x-oss-force-download: true`
  for PNG; this did not prevent embedded image rendering in the tested browser.
- The 60-second, 13.5 MiB MP4 reached `readyState=4`, initially buffering only
  0–3.431 seconds. After native play/seek controls, playback reached 57.707 seconds
  with separate buffered ranges 0–8.579 and 41.667–60 seconds. The browser did not
  need to fetch the whole file before preview or seek.
- Both generic MIME fixtures decoded successfully: PNG at 1254×1254 and MP4 with
  60-second duration, first frame and `readyState=4`, without a media error.
- Text preview displayed the expected Chinese/English content through CORS.
- Download dispatched to a fresh OSS URL in a separate browser tab. HTTP download
  bytes/disposition passed; completion of a native OS file-save dialog was not
  independently checked.
- [Production video preview](workspace-oss-video-2026-09-18.png).

These results establish embedded previews in the tested Chromium-based browser.
They do not establish top-level inline viewing for every OSS file type or
cross-browser codec compatibility. Existing local tests cover bounded media
retries and request cancellation; an already-issued URL remains valid until
expiry even after application access is revoked.

## Cleanup

Disposable objects, Agent and Sessions were removed or soft-deleted, Workspaces
soft-deleted, and temporary API keys revoked. The test share was invalidated.
Only soft-deleted audit metadata remains. Temporary browser tabs were closed.
