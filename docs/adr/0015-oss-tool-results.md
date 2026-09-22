# ADR-0015: OSS-backed large tool results and on-demand display

## Status

Accepted. Extends ADR-0013/0014's durable event journal with immutable external
payloads. The journal still owns ordering, identities, idempotency and compaction
boundaries; a referenced payload is part of that durable record. No Pi SDK patch
or model-context truncation is introduced. Extends ADR-0011's share allowlist
with a Session-scoped event-data read.

ADR-0016 further consolidates new Pi message output into native entries and
derives display events. The separate envelopes described below remain relevant
to legacy data and other runtimes.

## Decision

Tool result event data of at least 64 KiB (UTF-8 JSON bytes), or containing
NUL/unpaired UTF-16 surrogate characters that PostgreSQL JSONB cannot store,
lives in OSS. The character check includes nested result values and object keys;
valid surrogate pairs (such as emoji) and literal backslash escapes remain intact.
This applies to `agent.tool_result`, `agent.mcp_tool_result` and native Pi
`agent.context_entry` messages whose role is `toolResult`, including their
copies in Delegation wait checkpoints. Smaller JSONB-compatible results remain inline.

Store the original JSON data as a content-addressed object at
`__oma/session-results/v1/{sessionId}/{sha256}.json` in the configured OSS Bucket.
This reserved Host-only prefix is outside every mounted Workspace and file API.
There are no thumbnails, previews or transformations. Hashing the complete
event allows exact event/checkpoint copies in one Session to share an object;
different display/native envelopes are still separate objects. This change
does not claim to consolidate the existing event protocol.

PG retains identity/status metadata plus
`payloadRef: { version: 1, sha256, bytes }`. Native entry identity and its
tool-call identity remain inspectable, but its complete entry is in the object.
Object upload must succeed before committing the PG reference. Repeated writes
use the same content key. Upload failure aborts persistence; it never silently
falls back to a large PG value. Failed PG transactions may leave an unreferenced
object. Retain these for now; no deletion based on age alone is safe.

Host runtime reads hydrate and verify the object's hash and size before
returning original data to Pi. Missing/corrupt objects fail visibly. Pi entry
IDs, signatures, tool pairing, timestamps and compaction boundaries survive
exactly; model transport remains Pi's responsibility. Checkpoint status polling
uses references and only execution recovery hydrates the checkpoint.

JSON history lists, Child Session trace lists and both replay/live SSE use the
same reference representation. They never GET an external payload. Legacy
inline results are projected to the same lightweight representation without
writing objects on a GET. The browser requests
`GET /v1/sessions/{id}/events/{seq}/data` only after the user expands the result.
The Host finds the exact event under the authorized Session and returns
`{ data: originalEventData }`; clients cannot request arbitrary OSS keys.
Responses are no-store; failed hydration returns a sanitized, retriable 503.

The endpoint accepts owner credentials or an existing share for that exact
Session. Session/Workspace soft deletion prevents lazy reads. Share credentials
remain separate from owner authentication and do not grant Child Session access.
This is a buffered result-data endpoint, not a Workspace file endpoint; ADR-0012
continues to govern signed Workspace reads.

Tool details mount/fetch after expansion, including failed large results. Closing
aborts an outstanding request; reopening fetches again. On success, images render
their original bytes, never base64 text or generated thumbnails. Trajectory
details can explicitly retrieve full event JSON. No eager background preload is
performed. Size labels describe the complete result JSON bytes, not image pixels
or an estimate of model tokens.

## Existing data and release

Deploy reference-aware Host and Web together. Old frontends cannot understand
the new lightweight result representation. Existing inline records remain
readable before migration, but must be migrated to remove their large PG values.

Run the bounded migration with the normal Host environment:

```sh
pnpm --filter @oma-server/api exec tsx src/migrate-big-results.ts --session=sess_...
pnpm --filter @oma-server/api exec tsx src/migrate-big-results.ts --apply --session=sess_...
```

Omitting `--session` scans all Sessions. Default is dry-run. It migrates event
data and Delegation wait checkpoint copies, uploads and verifies the object by
reading it back, then conditionally replaces the original PG value. It preserves
sequence numbers and event timestamps, is safe to rerun, and reports concurrent
update conflicts (exit 2) for a later retry. No production migration is automatic
at startup. PG vacuum/reuse governs reclamation of old physical row versions.

Once migration has run, rolling back to code without payload hydration is not
safe. Keep OSS objects at least as long as their durable references and include
them in retention/backup planning. Deploying code alone does not evacuate old PG
payloads, and this ADR does not assert a production rollout has occurred.

## Local verification (2026-09-21)

- All server workspace tests passed (986 tests, 8 environment-dependent skips),
  as did all Web tests (389 tests). A subsequent reference-field boundary test
  passed with the affected Store/Delegation/OSS suites (24 tests).
- Native Pi SessionManager replay preserves entries and the compacted context
  after a fresh Store reader hydrates externalized results. Migration tests
  cover dry-run, object read-back, checkpoint copies and repeat execution.
- Web tests cover no request before expansion, original image rendering,
  cancellation, retries, share credentials, orphan MCP results and timeline reads.
- Server type checking, Web build/type checking and OpenAPI checks passed.
  ESLint passed for the new files and affected files except the timeline's
  pre-existing effect-state violation; the full Web lint still reports existing
  violations in unrelated code. No lint rules were disabled.
- Store tests use pg-mem; the OSS SDK test uses a local HTTP object-store fixture.
  Production PG concurrency and live OSS were not exercised by these new tests.
  No production deployment or data migration was performed.
