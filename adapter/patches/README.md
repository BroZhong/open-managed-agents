# Pi search process hooks

`@earendil-works__pi-coding-agent@0.80.10.patch` adds optional process and path
hooks to Pi's native `grep` and `find` factories. The adapter supplies sandbox
operations while Pi retains its original arguments, parsing, limits, errors,
and rendering. `find` can supply `exists` without replacing `glob`; its ancestor
`.git` checks use that same operation.

The patch is pinned to Pi 0.80.10 and applied by `patchedDependencies` in both
the adapter and server workspaces. Both lockfiles carry the same patch hash.
The server workspace needs its own declaration because its adapter dependency
is a `file:` snapshot. Server image builds copy the patch before installing.

Validate a change to this patch with frozen installs in both workspaces and the
adapter's native search parity tests. On a Pi upgrade, rebase the patch against
the exact published package and keep the upstream search implementation intact.
Calling a factory without these hooks retains Pi's local execution path.
