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
