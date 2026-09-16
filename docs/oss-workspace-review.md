# OSS Workspace implementation review

> Historical OSS migration record (2026-09-14). Image digests, templates and
> observations below belong to that run. Session file routes and the HTTP 423
> write gate were superseded by [ADR-0009](adr/0009-workspace-file-api.md).
> Use [the deployment guide](../deploy/README.md) for current operations.

Independent Standards and Spec agents reviewed `git diff 5609760...HEAD` at
`2fb4e20`, covering commits `4d8378a` (#124), `674dd54` (#125), `12cc079` (#126)
and `2fb4e20` (#127). Standards sources were AGENTS.md, the domain instructions,
CONTEXT.md and applicable ADRs, plus the code-review skill's smell baseline.
The Spec reviewer independently fetched GitHub issues #124–#127 and applied
the user's additional requirement to use Skill names in projection paths.

## Standards

One P1: `E2BSandboxClient.list` ran `find <root> -type f` without following the
initial directory symlink. ADR-0008 and live CSI evidence establish that
`/home/user/workspace` is a symlink into the mount. A temporary-filesystem
reproduction returned no files with the original command and the saved file
with `find -H`. This broke Pi `ls` and `find` operations despite successful
writes. No other definite documented-standard violation or actionable smell
was found. The reserved Manager list hook and weakly typed Provision Source
coordinates are supported by existing repository decisions.

## Spec

One P1, independently found: the same root listing behavior failed #125's
requirement to unify tool paths at `/home/user/workspace`. The mocked SDK list
test and initial deterministic Adapter harness did not cover the real symlink
layout. The reviewer found no additional concrete isolation, old-sync,
completion-state, assembly or scope-expansion defect. Named Skill projections,
descriptors and discovery consistently use names; internal source/ownership IDs
and Supabase Skill storage remain intact. At the initial review, the honestly
pending >1h probe and unperformed production cutover were release status, not
false passing claims. The >1h probe subsequently passed; production remains
unchanged at that review stage. The subsequent production deployment is recorded
in [the release report](./oss-workspace-production-release.md).

Summary: Standards 1 finding (P1); Spec 1 finding (P1), both identifying the same
root listing defect. The findings are recorded separately to preserve each axis.

## Resolution

The follow-up changes listing to `find -H`, which follows the initial root
symlink while preserving normal handling of symlinks encountered inside the
tree. The live application harness now asserts uploaded and shell-created files
through the real `ToolExecutor.list('.')` and checks the exact named Skill path.
The 32 SDK boundary checks and Sandbox typecheck pass. Both independent
reviewers confirmed that `a584914` resolves the finding in code, with no new
finding in their directed review.

The actual E2B client then listed seven files through the existing CSI symlink.
A separate browser-triggered Turn exercised the new `ToolExecutor.list('.')`
assertions against three uploaded/generated files, returned the exact named
Skill path, and automatically refreshed the page after completion. These runs
confirm the original failure path; their detailed evidence and cleanup are in
`docs/verification/oss-workspace/verification.json`.

Final status: Standards 0 unresolved; Spec 0 unresolved. Native download-event
and prompt limitations of the built-in browser are recorded separately from
the passing Host API checks and are not represented as successful UI checks.

## Production baseline merge and build-cache review

Before publication, current production `df7f1eb` was merged into the implementation
branch as `f98d729`. Both independent reviewers found the same two Supabase
Skills regressions: raw object URL segments could change the requested path,
and HTTP 400 responses could be mistaken for missing files. `24872a9` encodes
each object path segment and treats only HTTP 404 as absence. Real HTTP fixture
tests cover reserved/encoded path characters and strict error propagation.
Both reviewers confirmed the fixes with no remaining findings.

Both reviewers also checked `2f21683`, which adds dependency download caches and
isolates build stages. Neither found a new blocker. The actual published image
passed source-import and Pi seed checks, and repeated Host/Web builds completed
in 6.16/6.09 seconds with every RUN step cached. Current production acceptance,
including a real browser-triggered Pi Turn and instance replacement, passed.
