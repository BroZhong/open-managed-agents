# Pi native I/O forwarding

The seven managed Pi tools retain the factories, schemas, matching, image
processing, pagination, edit algorithms and result rendering from pinned Pi
0.80.10. `buildCustomTools` supplies only their execution and filesystem hooks.
This is the Tool-mode boundary described by ADR-0005, not a general plugin or
filesystem virtualization layer.

## Filesystem boundary

`ToolExecutor.fileSystem` provides exact bytes, access checks, `stat`, `lstat`,
`realpath`, immediate directory entries, recursive directory creation and
temporary output files. Pi requires this capability; it never substitutes the
recursive, regular-file-only Workspace persistence `list` for filesystem
metadata. Legacy text read/write and persistence methods retain their existing
contracts.

The Local executor uses Node filesystem operations. The Sandbox backend executes
Node filesystem operations inside the sandbox and carries byte payloads and
structured errors across the transport. This preserves soft links, empty
directories, invalid UTF-8, BOMs and native error codes without trying to infer
them from a file inventory. Mutation cancellation settles the backend operation
before releasing the mutation queue.

Paths resolve against `/home/user`; all tool `~` expansion uses that same home.
Absolute Read-only Projection paths and sandbox temporary files remain usable.
The sandbox itself is the production isolation boundary. Workspace persistence
still syncs only the Workspace; temporary output outside it is ephemeral.

## Supplementary Pi hooks

The pinned dependency patch adds the seams that upstream operations do not
cover:

| Native tool behavior | Injected hook |
| --- | --- |
| Read path and Unicode candidate probes | `ReadOperations.exists`, with an injected access fallback |
| Home expansion | `homeDir` on all path tools |
| Write/edit serialization and symlink aliases | `mutationScope` plus `operations.realpath` |
| Bash full output files | asynchronous `createOutputSink` with `write` and `close` |
| Bash environment | explicit `env`, leaving backend environment ownership with the Sandbox |
| Grep/find child processes | `spawn`, preserving native rg/fd arguments and result parsing |

Mutation queues are scoped by the stable filesystem object, shared across tool
instances in a Session and isolated from other executors. Canonical paths are
resolved by that filesystem, never by Host `realpath`. For a new file, the queue
key resolves its nearest existing ancestor, keeping the key stable while a
pending write makes the file visible, including through symlinked parents.

Bash uses `/bin/bash`, observed exit status, and Pi's timeout validation. A
deadline aborts the executor and waits for its process completion report before
returning Pi's timeout result. Both timeout and user cancellation retain prior
command output. An uncertain transport failure is not converted into a claimed
successful process termination. Full output is saved through the injected
filesystem and can be opened by the same `read` tool.

The E2B patch exposes original stdout/stderr bytes alongside its existing text
callbacks. Pi consumes bytes; other executor consumers can still consume text.
Small spill writes are coalesced, but upstream synchronous output callbacks do
not provide backpressure and a slow sink can accumulate pending buffers.

## Scope of parity

These hooks forward the built-in tool operations. They do not intercept arbitrary
`fs` or `child_process` calls made by third-party extensions, nor remove native
macOS/Linux differences in rg, shell utilities, locale or permissions. The E2B
command transport also retains its login-shell setup and backend process-kill
contract. Equivalent OS, binaries, environment and permissions remain necessary
for exact native output comparisons.

Regression tests compare native factories with the injected tools on the same
fixtures, trap Host filesystem bypasses, verify queue isolation and symlink
aliases, and read back full Bash output. Backend tests separately exercise the
filesystem transport and process output/exit lifecycle.
