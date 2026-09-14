# OSS Workspace implementation acceptance

Implementation branch: `codex/oss-workspace`, starting at `5609760`.
Issues: #124 → #125 → #126 → #127. Production is not switched by these commits.

## #124 — Host file API

`workspaceObjectPrefix(tenantId, workspaceId)` is the only object-prefix rule:
`<tenantId>/<workspaceId>/`. Both identities are 1–128 ASCII letters, digits,
underscores or hyphens. The trailing slash is part of the isolation boundary;
Sandbox CSI `subPath` removes that one trailing slash. Only the Host derives
coordinates from the authenticated Tenant and the Session's immutable Workspace.

File paths are relative POSIX paths, decoded once by HTTP, then used literally.
No dot/empty components, absolute paths, backslashes, control characters or
unpaired surrogates. Percent signs, Unicode, spaces and hidden files are preserved.
`.oma-workspace-checks/` is reserved for temporary mount-verification probes and
excluded from business file APIs and lists. Browser media URLs use the public
regional HTTPS endpoint and expire in 60–900 seconds (default 600).

Reproducible checks on 2026-09-14:

- API: `pnpm --dir server/packages/api exec vitest run test/workspace.test.ts test/workspace-oss.test.ts test/sessions.test.ts test/workspaces.test.ts` — 86 passed.
- OSS Store: `pnpm --dir server/packages/store exec vitest run test/oss-artifact-store.test.ts test/oss-sdk-integration.test.ts` — 9 passed.
- Store typecheck: `pnpm --dir server/packages/store typecheck` — passed.

The authenticated integration test exercises the real OSS SDK against a local
HTTP protocol fixture, including pagination, multipart upload, overwrite rename,
Unicode download headers, media signing, cross-Tenant/Workspace denial and the
existing per-Session 423 gate. The fixture is not evidence of live cloud IAM;
real-cloud acceptance is recorded separately under `deploy/sandbox/oss-workspace`.

## #125 — mounted execution

SandboxManager now creates a restricted CSI mount at `/home/user/workspace`.
Before each tool operation it checks the gateway's storage authorization,
ordinary-user `fuse.ossfs` mount identity and a closed-file probe read back through
the Host OSS store. Probe files use only the reserved control directory. A failed
check blocks execution; it never creates a local fallback Workspace. Expired
Sandbox resources rebuild with the same trusted prefix.

Skills still come from Supabase through `S3ProvisionSource`. In response to the
user's additional requirement, their projection and Adapter discovery paths are
`/skills/<skill-name>`, while source ownership stays keyed by Skill ID. Invalid or
duplicate equipped names fail before execution. Rename/retry removes stale
projection paths, including paths left by a partially failed copy.

- Sandbox focused checks: `pnpm --dir server/packages/sandbox exec vitest run test/sandbox-manager.test.ts test/e2b-sandbox-client.test.ts test/provision-source.test.ts` — 53 passed.
- Router mounted-execution checks: `pnpm --dir server/packages/session-router exec vitest run test/session-router-sandbox.test.ts` — 27 passed.
- Adapter tool/Skill boundary checks — 25 passed.
- Sandbox and Router typechecks — passed.
- Local `linux/amd64` image build and ordinary-user smoke — passed; see `deploy/sandbox/code-interpreter-vfscli/local-build-verification.json`.

Real isolated cloud checks confirmed Host/Sandbox Unicode, empty and binary file
visibility, concurrent writes, Workspace isolation, rebuild persistence, and
local Node/Python installation. `/home/user` and dependencies stay local. These
checks do not promise general POSIX semantics, instant cache visibility, or
preservation of open/background writes at Turn end. Image publication and a
production maintenance cutover have not been performed.

## #126 — concurrency and failure states

Each Session owns its execution resource; multiple Sessions can mount the same
Workspace without a shared lock. Successful closed-file writes survive normal,
failed and interrupted Turns. Session deletion disposes its Sandbox and leaves
Workspace objects in place; failed resource cleanup remains retryable.

A failed end-of-Turn mount check emits `workspace_storage_error`, retains the
answer and completes the Turn. The next execution checks the mount again.
The file manager retains its last successful listing on refresh failure and
labels the current file status unconfirmed. Refresh retries the file API only;
it does not post another input or replay the Turn. Malformed successful list
responses also fail visibly instead of becoming an empty directory.

- Router concurrency/Interrupt/deletion/storage-failure checks are included in the 27 passing checks above.
- Web: `pnpm --dir web exec vitest run src/components/workspace-panel.test.tsx src/lib/hooks/use-session-events.test.tsx src/pages/session-detail-queued-input.test.tsx src/lib/workspace-file-source.test.ts` — 17 passed; TypeScript build check passed.
- Real SDK storage-failure checks distinguish a missing object from a missing bucket, preserve uploaded media metadata, and reject OSS's unsupported `response-content-type` override. OSS focused checks — 11 passed; Store typecheck passed.

The signed GET compatibility check was added after a real OSS request returned
`InvalidRequest` for a response Content-Type override. Signing now preserves the
object's stored headers; the authenticated Host preview/download path supplies
MIME fallback for ossfs files with generic metadata. Signing does not modify
object metadata. Full application/cloud results are recorded with #127.
