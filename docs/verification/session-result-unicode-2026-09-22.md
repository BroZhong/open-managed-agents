# Lossless storage of binary tool output — 2026-09-22

The Sessions `sess_FvBbDRDMdGpNfRBKbreti` and
`sess_KLN8_gm1ymcWvg8XPoa12` stopped with `adapter_error: unsupported Unicode
escape sequence` after commands read executable/binary files as text.
PostgreSQL JSONB rejects NUL (SQLSTATE `22P05`) and unpaired UTF-16 surrogates
(`22P02`), although JSON serialization can represent them.

The existing result codec now externalizes these results regardless of size,
using the same immutable object, hash verification and reference format as
results of at least 64 KiB. This covers ordinary and MCP tool results, native
Pi tool-result entries and their delegation checkpoint copies. No bytes are
stripped or replaced. Ordinary Unicode, emoji and literal backslash escapes
retain their existing inline representation. No schema migration is needed.

## Verification

- Before the fix, six new regression cases failed against the old size-only
  policy.
- Store, Session Router and API suites: 671 passed, 9 environment-dependent
  skips. Store/API type checks and `git diff --check` passed.
- Independent temporary PostgreSQL **18.4** on localhost: 22 tests passed,
  covering raw JSONB rejection, exact append/read/idempotent retry, native
  presentation, delegation checkpoints, object-upload failure, Pi restoration
  after compaction, and a Router Turn reaching its final answer after binary
  output without `session.error` or a repeated Adapter invocation.
- HTTP history, replay/live SSE and lazy details cover small unsafe results as
  well as existing large results. List reads retain references; expanded
  results and runtime reads recover the exact content.
- CI now runs the focused PostgreSQL regression suites with PostgreSQL 17.
  These integration tests use an in-memory object-store implementation; they
  do not claim a live OSS end-to-end run.

Reproduce against a disposable database (the harness recreates its test schema):

```sh
export PG_TEST_URL=postgresql://postgres@127.0.0.1:55489/postgres
export PG_TEST_SCHEMA=oma_unicode_test
pnpm --dir server --filter @oma-server/store exec vitest run test/event-payload.test.ts test/event-presentation.test.ts
pnpm --dir server --filter @oma-server/api exec vitest run test/big-results-pi-context.test.ts
```

No production deployment, data migration or Session continuation was performed.
The VFS identity/skill workflow and storage-outage recovery policy are unchanged.
