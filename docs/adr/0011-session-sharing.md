# ADR-0011: Read-only Session and Workspace shares

## Status

Accepted for issues #154 and #155. Extends ADR-0009 without changing Workspace
storage, concurrent owner writes, or Session execution.

## Decision

A Session has at most one durable `session_shares` record. Its ID is 32 random
bytes encoded as base64url, independent of the Session ID. PostgreSQL's unique
Session constraint and atomic upsert make concurrent creation idempotent. The
record stores only the Session binding; Tenant and Workspace come from that
Session's immutable trusted relationships. IDs have no expiry or rotation and
there is no revoke endpoint.

Only an owner Bearer token or Tenant API key can call
`POST /v1/sessions/{id}/share`. Opening the console dialog creates nothing;
copying creates/retrieves the ID and copies `/share/{id}`. The dialog explains
that anyone with the link can read the complete Session and entire current
Workspace, including later updates after refresh.

The anonymous page supplies the ID through `x-session-share`. This identity
takes precedence over all ordinary credentials and development auth bypass.
Central authorization permits only share resolution, the linked Session's
read-only display projection and JSON events, and the bound Workspace's file
list and Host file reads. Both resource paths and operation IDs are allowlisted;
unknown operations, SSE, other Sessions (including Child Sessions sharing the
Workspace), Agent configuration/Files, Skills, signed OSS URLs, and every write
are denied. Every request resolves the binding and checks that the Session and
Workspace exist and have not been soft-deleted. Termination alone preserves
access. Previously downloaded bytes cannot be recalled.

Share Session responses contain only ID, title, status, creation date, Agent
name, and Workspace ID. Agent snapshots, environment and system configuration
are not returned. Existing MCP filtering for ordinary responses remains.
Persisted history, including thinking, tool inputs/results and delegation
results already in parent history, is shared verbatim: this is not a general
content-redaction service and cannot remove secrets written into history.

The share route is outside the login provider and ordinary query cache. It
uses credential-free HTTP requests apart from the share header and never
redirects to login or changes the normal token. History loads all JSON pages
without SSE or polling. A local read-only FileSource reuses Workspace path
validation, tree, text and Blob media handling. No write capabilities or child
execution callbacks are supplied. Resource links open only Workspace paths;
other links and embedded images cannot initiate privileged navigation or
background requests. Refresh reads current persisted history and files, with
no snapshot, version store or Turn execution.

## Deployment

Apply `deploy/migrations/0013_session_shares.sql` before the Host release when
`PG_ENSURE_SCHEMA=false`. Automatic development schema setup includes the same
table. The production application role receives SELECT/INSERT/UPDATE only.
Release the web console and Host together. No existing IDs or files migrate.
