# ADR-0009: Workspace-owned file APIs

## Status

Accepted, 2026-09-15. Supersedes ADR-0008's retained per-Session 423 write
gate and the Session-based HTTP file routes. OSS storage semantics remain.
ADR-0012 subsequently changes the read response from file bytes to a signed OSS
URL descriptor; the ownership and write rules below still apply.

## Decision

All seven file operations belong to `/v1/workspaces/{id}`: list, read,
write, delete, rename, upload and signed preview URL. The ID is a Workspace
ID. The Host checks the authenticated Tenant's Workspace metadata before
accessing the corresponding OSS prefix. A Workspace need not have a Session.

Remove `/v1/sessions/{id}/workspace/*` without aliases or redirects. The
project has not launched, and maintaining obsolete entry points adds complexity.
The console obtains `workspaceId` from Session metadata and calls the new API.

Remove the per-Session write gate. Several Sessions can share one Workspace,
so checking one Session never provided a Workspace lock. Host writes remain
available while a Turn runs and after Sessions terminate. Concurrent writes
to the same path may overwrite each other. Rename remains copy-and-delete;
this change adds neither transactions nor locking.

## Consequences

Clients must migrate their URLs and use Workspace IDs. Existing files require
no migration because their `<tenantId>/<workspaceId>/` OSS prefixes are unchanged.
The file list is the Workspace's current file collection, including inputs and
intermediate files; it does not classify final Agent deliverables.

Tests cover a Workspace with no Session, shared and terminated Sessions,
Tenant isolation, path validation, all seven operations and removal of old routes.
Server and web must be released together, followed by live file lifecycle tests.
