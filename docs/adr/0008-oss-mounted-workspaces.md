# ADR-0008: Direct OSS-mounted Workspaces

## Status

Accepted for implementation in #124–#127. Replaces ADR-0002's S3/Supabase
Workspace medium, `/home/user` root and scan/sync/file-change semantics, and
ADR-0005's WorkspacePersistence/Baseline/checkpoint mechanism. Production
activation remains gated by the deployment and acceptance checklist.

## Decision

The Host still owns infrastructure and authorization. The Adapter receives a
ToolExecutor per Turn; parent and child Pi Agents use the same injected tools.
The Sandbox Manager owns creation, reuse, rebuild, projection refresh and
resource disposal. We add neither another runtime nor a neutral tool framework.

Workspace files live only in OSS. Host file APIs use `OSSArtifactStore`; a
Sandbox accesses the same prefix through the existing Agent Identity CSI mount.
The single trusted prefix is `<tenantId>/<workspaceId>/`, computed by
`workspaceObjectPrefix` from authenticated Tenant and bound Session metadata.
Opaque IDs allow 1–128 ASCII letters, digits, `_` and `-`. CSI `subPath` removes
the final slash. Clients cannot submit mount metadata or arbitrary object prefixes.

The Workspace root is fixed at `/home/user/workspace`. HOME stays local at
`/home/user`; only files inside the mounted directory persist. Supported Node
and Python dependency installs target local directories configured by the Host,
with explicit instructions. Commands are not intercepted: creating project
`node_modules` or `.venv` inside the Workspace will persist them. Local installs
and caches may need to be recreated after a Sandbox rebuild.

Each completed write and successful close saves one file. Normal completion,
failure and Interrupt retain saved files. There is no Turn transaction, rollback,
Workspace lock, merge, version history or undo. Multiple Sessions may use a
Workspace concurrently and overwrite the same file. Rename remains non-atomic
copy-and-delete, with the existing overwrite behavior. A same-path rename is a
no-op after verifying the source exists. Session deletion releases execution
resources and retains Workspace files; it does not wait for arbitrary background
processes or promise that open handles have been saved.

Before execution, the Manager verifies the real mount and the current ordinary
user's read/write capability. The deployed CSI path is a symlink into
`/run/csi/mount-root/oss/`; mountinfo reports only `fuse.ossfs` and source `ossfs`.
Therefore kernel mount detection alone cannot establish the actual object prefix.
Verification combines trusted E2B identity/storage metadata, canonical mount
inspection and a fresh write-close-read probe that the Host independently reads
from the expected OSS prefix. Probe filenames are random under the reserved
`.oma-workspace-checks/` subtree, hidden and rejected by business file APIs.
Cleanup runs on success and failure; a failed check never permits a local-directory
fallback. Expired or missing Sandboxes rebuild against the same verified prefix.

There is no Workspace hydration, refresh-copy, mtime/hash/Baseline scan, dirty
retry or checkpoint upload. A Turn-end availability check can report an error but
cannot claim that all open files were saved. Its error is recorded independently
of the answer and Turn completion; it never automatically reruns the Turn.
The next affected execution checks the mount again. The web console refreshes
on Turn end, retains the last loaded tree and answer when refresh fails, and
offers file refresh retry. The existing per-Session 423 write gate remains.
Historical `workspace.file_change` events remain readable as history; no new
sync deltas are produced or required to refresh the console.

Skills retain Supabase storage and Read-only Projections. Their mounted paths
use `/skills/<skill-name>` as requested; internal authorization and source lookup
continue using Skill IDs. Unsafe or duplicate equipped names fail visibly before
execution. Rename reconciliation removes old paths, including after a failed
projection attempt. Agent Files remain Host-assembled instructions.

## Consequences

OSS mount caches can delay visibility between Host and Sandboxes; measured
latencies are observations, not an SLA. OSS rename, concurrent overwrites,
close-time upload and temporary local disk use do not provide full POSIX or
transaction guarantees. Mount probes verify current reachability and scope,
not future durability of other open handles.

Host OSS configuration is mandatory and independent of Skills configuration.
Signed browser GETs use the public regional HTTPS endpoint for 60–900 seconds;
the Bucket remains private and long-lived secrets stay on the Host. E2B request
timeout defaults to 185 seconds to allow the ALB's 180-second response window;
Sandbox TTL is separate.

No historical files are migrated or dual-written, and old business objects are
not deleted. Consistent maintenance cutover must drain active Sessions, retire
old execution resources, deploy Host and image together, and verify per-Agent
template overrides. Reverting code does not copy new OSS files back into
Supabase. See [acceptance](../oss-workspace-acceptance.md) and
[deployment instructions](../oss-workspace-deployment.md).
