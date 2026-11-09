# Session creation idempotency release — 2026-11-09

## Release

The user authorized merging to main, deploying both test and production, and
packing oma-cli **0.1.1**. Feature commit
`6e19185ac5d63e5d04f16adf347463da9b562ec8` was pushed to main on top of
`3a1e0100aa59e918cf6e1c7f54e914101f49990a`.
The schema merge preserves main's removal of the global delegation lock.
Because main already contains migration 0031, the new additive migration is
`deploy/migrations/0032_session_creation_keys.sql`.

Built and pushed on vfs-dev from the clean feature commit:

- Image tag: `202611092248`.
- Server digest: `sha256:b8a0d2dde947567b0624952e22b16983d6a37744ff2691f10a06b78c54d4c1c2`.
- OCI revision label matches the feature commit.

Only the API needs this feature. Both `oma-test/oma-api` and
`oma-infra/oma-api` now use that digest, with 1/1 ready replicas. Runner,
Web and image-builder images were retained. Test used the complete rendered
overlay after its diff showed only the API image change; production patched
only the API image, following the current deployment runbook.

## Migration

Applied 0032 to `oma_test` first, then to `oma`, through the configured
privileged database connector on the verified Shanghai agent-pg instance.
The connector's RPC route uses one atomic DO block per environment, retaining
the 5-second local lock timeout and the migration's DDL and grants.
`oma_test_app` / `oma_app` each have SELECT and INSERT on their own
`session_creation_keys` table, with no DELETE grant. No existing data was changed.
The key reservation, Workspace and Session are committed in one transaction.
Keys have no automatic expiry and remain reserved after soft deletion.

## Verification

After integration with current main:

- API: 84 tests passed, including concurrent idempotency, changed parameters,
  aliases, Tenant isolation, Agent default changes and failure compensation.
- Real temporary PostgreSQL: 28 tests passed, including 16 concurrent creators,
  different-parameter races, failed-insert rollback, restart replay and a
  one-connection pool.
- CLI 0.1.1: all 47 tests passed, including a real Host integration.
- Deployment checks: 49 passed, 1 existing opt-in check skipped.
- Type checking and OpenAPI generation/lint passed; lint retained four unrelated
  existing warnings (license, localhost server, two public read routes' 4xx).
- The tarball passed independent installation, executable version, offline
  discovery and authenticated fixture checks. Its 20 files are limited to the
  published README, package.json, dist and guides; no credentials are included.

Live acceptance completed at **22:51:42 Asia/Shanghai** on test and
**22:53:17 Asia/Shanghai** on production. The exact CLI tarball was extracted
inside each API Pod and used against its public API URL. Each run created two
fresh Tenant fixtures and checked:

1. Public health and OpenAPI describe `Idempotency-Key`.
2. CLI creation plus 12 concurrent HTTP retries produce exactly one Session and
   one Workspace in PostgreSQL; a later CLI retry returns the same IDs.
3. Changed Agent, Workspace or Environment parameters return 409 and the
   original `sessionId`; the CLI reports `idempotency_key_conflict` and exits 5.
4. Workspace parameter aliases replay the same Session.
5. A failed creation leaves the key available; malformed keys return 400.
6. The same key is independent across Tenants.
7. Requests without keys continue to create separate Sessions.

Only these fixtures were touched. Their Sessions and Workspaces were
soft-deleted, their Agents deleted, and their temporary API keys revoked.
No Turns or Sandboxes were started. The live receipts, without credentials,
are in `session-idempotency-release-2026-11-09.json`.

## CLI artifact

- Package: `@welltop/oma-cli@0.1.1`.
- Tarball: `welltop-oma-cli-0.1.1.tgz`, 38,320 bytes.
- SHA-256: `b7201b6491a8b6d24993fab435b572fa4b7c51ddcfdfa77af0bc6b7decd28088`.
- Local delivery directory: `exports/oma-cli-0.1.1/` in the original checkout.
- Published the exact verified tarball to `https://registry.npmjs.org/` as
  `@welltop/oma-cli@0.1.1`, public access and `latest`, after the user's explicit
  publication instruction and npm account authentication.
- Registry publication time: **2026-11-09 23:02:50 Asia/Shanghai**.
- Registry SHA-1 and SHA-512 integrity match the original tarball. A fresh
  installation from the official registry passed executable version, Session
  creation schema (`--idempotency-key`) and bundled guide checks at 23:03:13.
- Package: https://www.npmjs.com/package/@welltop/oma-cli/v/0.1.1

## Rollback

The previous API image in both environments was
`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:a44550a793fc3ebd75807ca9efa1ecd8867a0800d26a279c23a71913c3c81483`.
Keep the additive key table during rollback. The old API does not support
idempotent Session creation, so pause clients relying on the header before
reverting the API. Restoring the new API resumes the stored key mappings.
