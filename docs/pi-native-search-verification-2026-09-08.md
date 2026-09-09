# Pi native grep/find sandbox verification — 2026-09-08

The implementation now runs Pi 0.80.10's native `grep` and `find` logic through
sandbox filesystem/process operations. Code and isolated cloud verification
are complete. This change has not been committed, merged, or deployed to the
shared Host or sandbox templates.

## Implementation

- Remove the Python regular-expression search and `ToolExecutor.list` glob
  replacement. Pi retains its tool schema, original rg/fd arguments, ignore
  rules, parsing, context formatting, truncation details and result rendering.
- Pin a small Pi dependency patch exposing process spawning and sandbox home
  directory options. `find` probes `.git` ancestors through the same filesystem
  adapter. Async probes recheck cancellation before starting a process.
- Bridge `rg`/`fd` to `ToolExecutor.exec` with actual exit status. Search errors
  no longer turn into successful results. The backend retains a command handle
  and kills the executable on cancellation; no process runs on the Host.
- Use real stat/access and byte-preserving context reads through sandbox exec.
  Empty directories, symlink search roots, BOM text and absolute Skill paths
  retain native behavior. Python is used only for these filesystem operations.
- Preserve UTF-8 across stdout/stderr chunks. The local executor uses independent
  streaming decoders; a pinned E2B 2.24.0 patch fixes both published SDK entrypoints.
- Add `rg` and `fd` to both managed sandbox image recipes, plus offline smoke
  checks. Existing templates do not contain these executables. Debian packages
  are used by the image recipes and their versions/checksums are recorded;
  image builds themselves were not performed in this verification.

## Automated verification

- Adapter suite: **286 passed**, including **26 native-vs-adapter comparisons**
  and eight tests that forbid Host spawn/filesystem access.
- Sandbox suite: **94 passed**, including twelve tests driving both actual E2B
  SDK entrypoints with split UTF-8 protobuf events.
- Adapter typechecks and sandbox/API/Session Router typechecks passed.
- Frozen adapter/server installs and `git diff --check` passed.

The differential tests execute actual rg/fd on the same fixtures with identical
binary versions, comparing tool content, details and errors. They cover Unicode
regex, brace and question-mark globs, hidden files, gitignore and nested Git
boundaries, compiled Python bytecode, context encoding, truncation, empty paths,
symlink roots, projections and cancellation. A missing local test binary is
provisioned through Pi's own native bootstrap; tests do not skip parity.

## Real cloud execution

A separate auto-story sandbox used the modified Pi tools, SandboxManager,
E2BSandboxClient and patched SDK loaded in an isolated probe process. No-op
Workspace persistence avoided writing diagnostic fixtures into user storage.
The probe staged official Linux rg **15.1.0** and fd **10.4.2**, matching the
versions used by the local native reference. No user Session or Agent was edited.

**17 checks passed**, including Unicode regex, brace globs, ignore rules, BOM/CRLF
context, match/line truncation, invalid regex errors, empty directories, fd glob
semantics, symlink roots, Skill paths, sandbox `~`, missing paths, actual gateway
UTF-8 byte splitting, nonzero exit status and active process cancellation.

The cancellation test waited until an actual `rg` process was blocked reading a
FIFO, cancelled the tool, checked the native `Operation aborted` result, then
verified the process was absent from `/proc`. Passing sandbox:
`sandbox-system--auto-story-gn9dk`. Its dispose completed; all three diagnostic
sandboxes were subsequently absent. Temporary Host probe modules/binaries were
removed. The initial binary-availability probe confirmed the existing template
has neither rg nor fd. An initial FIFO check used an overly strict argv[0] path
predicate; the final check accepts both `rg` and its absolute executable path.

Receipts and the standalone cloud probe are available locally under:
`/Users/zhangyuzhong/Downloads/auto-story-验收-20260908/records/native-search-fix/`.

## Release boundary

A release must rebuild the Host with both dependency patches and the executor
changes, and rebuild/update the sandbox templates with rg/fd. The historical
source-only tools overlay now refuses an incompatible base image. The binary
versions in a built image still need to be checked against the intended local
reference; the cloud result above applies to rg 15.1.0/fd 10.4.2.

This verification establishes the tested grep/find behavior. It does not claim
full parity for bash, read, write, edit or ls; their previously identified
semantic differences require their own work.
