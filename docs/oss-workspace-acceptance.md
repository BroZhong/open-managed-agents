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

## #127 — final assembly and regression

The default and production Host now use the same OSS-only Workspace assembly.
Required OSS/E2B settings fail clearly when absent, and a read-only OSS list
checks startup reachability. Skills keep their Supabase configuration and
client. Host OSS credentials are excluded from Adapter CLI environments.
Unused Supabase Workspace storage and the old synchronization implementation
are removed. Domain documentation and ADR-0007 record the replacement contract.

All package regressions were exercised on 2026-09-14:

| Scope | Result |
| --- | --- |
| Server Event Log / Store / Redis / Memory Store / Sandbox / Router / API | 8 / 91 / 37 / 36 / 53 / 69 / 295 tests passed (589 total) |
| Adapter workspace | 243 passed |
| Web console | 139 passed |
| Server all-package and Adapter typechecks; Web TypeScript build check | Passed |
| Managed parent/child Agent deployment tests | 3 passed |
| story-seed launcher shell checks | Passed |

`pnpm --dir server -r test` initially found one remaining old Skill-ID path
expectation in `agent-injection.test.ts`. It was updated to assert the requested
literal `/skills/greeter` path; all six tests in that file then passed. The
recursion had stopped before the API package, so the complete API suite was run
separately and all 295 tests passed. Already-passing packages were not rerun.
Adapter and Web suites ran with `pnpm --dir adapter test` and `pnpm --dir web test`.

The checked-in deployment guide covers required configuration, consistent
maintenance cutover, active and queued work, per-Agent template overrides,
rollback file visibility, and certificate maintenance. Shanghai declarations
passed a server-side dry run without applying changes. Actual ossfs PNG and MP4
signed GETs returned 200 with correct MIME and exact bytes after the signing fix.
The isolated application run passed at 10:13:25 UTC across nine deterministic
Adapter Turns using real E2B execution and OSS. It covered upload/edit/create,
signed PNG GET, isolation, concurrency, rebuild, named Skills, failure/retry,
and Interrupt of a running Python command. All three application Sandboxes and
both unique prefixes were cleaned and checked empty. Control metadata/auth and
Skill input bytes were in memory; these results do not claim a live model call,
production Supabase access, or interactive browser rendering. Web rendering and
Supabase behavior are covered by the package regressions above.

Detailed live application results and >1h credential-refresh evidence are in
`deploy/sandbox/oss-workspace/verification.json`. The same mounted Sandbox
completed its initial write at **2026-09-14 09:44:46.011 UTC** and its final write
at **10:49:47.561 UTC**: an actual interval of **3901.550 seconds (65 minutes
1.55 seconds)**. Post-expiry mounted write/read, Unicode rename/delete and
independent Host readback passed. This is a real elapsed-time test, not a
short-duration simulation or a replacement Sandbox.

Independent cleanup checks confirmed all **11** recorded test Sandboxes absent
and all **9** exact test prefixes empty. Local test servers were stopped, the
temporary kubeconfig was deleted, and the default kubectl context was unchanged.
The cloud evidence directory was checked against the current cloud/E2B
credentials and signed-URL patterns: zero matches. No production resources or
business files were removed.

The required independent Standards and Spec reviews each found the same P1:
root file listing did not follow CSI's Workspace symlink. Follow-up `a584914`
uses `find -H` and adds real `ToolExecutor.list` assertions. Both reviewers
confirmed the fix; real mounted listing and a browser-triggered Turn passed.
See [the two-axis review and resolution](./oss-workspace-review.md).

Actual local-browser acceptance subsequently covered sign-in, Chinese upload,
text preview, running write controls, real Sandbox edit/create/list, the exact
`/skills/probe-skill/SKILL.md` path, idle automatic refresh, loaded PNG dimensions
and explicit Refresh retaining the answer and files. Its one Sandbox and unique
OSS prefix were cleaned, and both local test servers were stopped. The browser's
media-download command completed, but its native Download event was not observed;
the existing Rename prompt reports unsupported in the built-in browser. Those
native interactions are not claimed as passed. The real authenticated API
download/signing/rename checks passed independently. The test uses synthetic
control records and a deterministic Adapter, never a production user or live LLM.

Production has not been changed. Publishing/pinning the reviewed images and an
authorized maintenance switch remain release steps. The certificate expires
2026-12-13 07:53:21 UTC and has no automatic renewal configured.
