# Isolated candidate cloud verification — 2026-09-09

This is candidate-source verification against disposable cloud sandboxes, not a deployment or an assertion that the live template is ready. No live Host package, image, or SandboxSet was modified.

Local regression gates passed: 342 adapter tests, 126 Sandbox tests, adapter and server typechecks. CI additionally covers the server integration path, deployment overlays, OpenAPI contract and Web console. The implementation boundary is documented in [Pi native I/O forwarding](pi-sandbox-io-hooks.md).

The Host was `oma-server-68cc4f47b7-f2sm6`, image `sha256:b251efc256db85ec081a03073380ff54c8b4966a616fd760e11928c7ed8de214`. Source packages were copied to unique `/tmp/oma-pi-io-candidate-*` directories. Installed Host Pi 0.80.10 and E2B 2.24.0 packages were cloned into those directories and overlaid with the final worktree's patched distribution files. Each dependency was linked explicitly, with Pi/E2B/core/adapter/backend overrides resolving only to the isolated candidate graph. Fingerprints were checked before execution, and final copied source still matched the worktree after execution.

## Baseline infrastructure observation

The live `auto-story` SandboxSet uses image `sha256:65482ebbc3a0f42bbd64a122a79126aa62643e93c7e4284136d42f42ce81dd98`, different from the earlier native-search release image. The fresh sandbox's PATH was `/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games`. `rg`, `fd`, and `fdfind` were absent from PATH, and no matching file/symlink existed under `/usr/local/bin`.

The unstaged run therefore preserved expected I/O outcomes but could not execute search. Its full raw result is `cloud.json` and its original comparison is `comparison.json`. Do not interpret process exit code 0 as all cases passing: the harness records expected tool failures as observations.

## Candidate verification after staging prerequisites

A second disposable sandbox received only the verified Linux amd64 binaries in `/tmp/oma-pi-diagnostic-search-bin`; that directory was prepended to PATH for this diagnostic session. Its actual original PATH and binary absence were recorded before staging. The live template was unchanged.

- rg 15.1.0 SHA-256: `ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2`
- fd 10.4.2 SHA-256: `0dff4a420feb3e57fd1d4402d3e29f46115aa38d962467d2f3b72e7439d3ada8`

The run completed 61 observations. All seven tool schemas matched the prior native Pi 0.80.10 baseline. Of 54 shared observations, 50 matched exactly. Four differences remain:

| Case | Observed difference |
| --- | --- |
| bash_version | Native macOS Bash 3.2.57 vs sandbox Bash 5.2.15; this is a runtime version difference. |
| grep_brace_glob_ignore | Same lines, different native traversal order. |
| find_limit | Same limit semantics, different valid subset from traversal order. |
| grep_binary | Previously verified Darwin/Linux rg mmap behavior; the raw comparison retains the NUL-containing Linux match. |

The generic comparison script labels `bash_version` as `behavior_difference`; the raw output shows only the executable version string differs. All previous semantic I/O differences in this fixture matrix are resolved.

Seven cloud-only observations passed:

- `find` expands the sandbox's home directory.
- Direct exec reports exit 7 and stderr.
- Bash preserved all 140,000 output bytes in sandbox storage; SHA-256 `933f97c80b4c92abb1fb6aa15032ab7bc4e666ac9b2bbc3f2cc7b0cadfdb4e43`. The native `read` tool successfully read the last output line.
- Direct exec preserved invalid/raw bytes: stdout `00ffe4b8ad`, stderr `fe0a`.
- `write` expands `~` through a symlinked parent.
- The symlink remains intact and its target contains exact UTF-8 bytes.
- `ls` returned all 100 entries, taking 4,224 ms. Per-entry remote metadata calls remain a latency limitation.

A running real `rg` was observed before cancellation, and zero matching processes remained afterward. Neither aborted nor timed-out Bash commands wrote their delayed marker files.

## Cleanup

Both sessions used no-op Workspace persistence and no user Agent sessions or media. `session.dispose()` ran for each sandbox. Deletion was asynchronous; subsequent explicit Kubernetes queries confirmed both sandbox resources absent:

- `sandbox-system--auto-story-2dnxn`
- `sandbox-system--auto-story-8c4wh`

Both unique Host candidate directories were removed and verified absent:

- `/tmp/oma-pi-io-candidate-36fd3a411675`
- `/tmp/oma-pi-io-candidate-5b4f37f488d3`

Only these newly named Host directories were deleted. Receipts: `sandbox-cleanup.json`, `host-cleanup.json`, and the corresponding files under `staged-prerequisites/`. Final successful candidate receipts, including source fingerprints and full output, are under `staged-prerequisites/`.

The receipt paths above are relative to `/private/tmp/oma-pi-io-parity-validation-20260909/isolated-cloud/` on the verification workstation. They are diagnostic artifacts, not files inside the repository.
