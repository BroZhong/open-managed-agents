# Pi native search release verification — 2026-09-09

This release restores Pi 0.80.10's native `grep` and `find` implementation in
the agentry deployment. It does **not** establish full local/cloud parity for
all seven tools. The deployed-runtime comparison found remaining differences
in `bash`, `read`, `edit`, and `ls`.

## Release provenance

The feature commit is `d1f23222901c4a407d87af84516ebcf6dc757338`, based on
main `8321abc325c63868c98585ba3ce8041347f49a98`, in PR #120. The cloud was
already running workspace-upload changes from `e229d252800dadc06374bb0216cdf2952424b4ab`.
Release commit `d6460a20c0e1a09f61601594bcd4e91dca68ab43` merges only this
feature onto that existing runtime, preserving the already deployed behavior.
The Web image and other Deployment configuration are unchanged.

Images were built on `vfs-dev` from the pushed release commit. The full Host
build uses `bash build.sh --tag pi-native-search-d6460a20c0e1 --push server`;
the historical source-only overlay was not used. Both the `server` container
and `seed-pi-auth` init container use the same immutable Host image.

All repositories below use `registry-vpc.cn-shanghai.aliyuncs.com/welltop/`.

| Component | Repository | Deployed SHA-256 digest |
| --- | --- | --- |
| Host | `oma-server` | `43dd88c08f3e65d13cb680413974fa55f3bc6aa717001941c336f0419a8e365f` |
| auto-story 0.1.2 | `oma-sandbox` | `dd6437954752ff8527225bd2198245b89c75598a43c2e17d652d3d43279a4a72` |
| code-interpreter | `oma-sandbox` | `1cf094551dd4822ccb184fa95da7bd170af001b3a1a23ae45e1499eb5007391d` |
| code-interpreter-vfscli | `oma-sandbox` | `f910f7b3aaefba6271f1dfe131874e90bfa62673bf6e043ef31b49b4169eb024` |

The Host index resolves to Linux amd64 manifest
`8736d707f2576115507fea09c46b51f5f039aa64ad752c126cee4fc1fd856259`.
The three sandbox templates pin rg 15.1.0 and fd 10.4.2. auto-story retains
VFS CLI 0.3.14, MediaKit 0.2.1, Gemini SDK 2.22.0 and its existing media tools;
Skills remain separate projections and are not packaged into the image.
The stock template now references the existing `ali-shanghai` pull Secret.
Each new warm Pod became Ready before the first Host rollout.

An offline image audit resolved imports from `/app/server/packages/api`,
including pnpm's installed adapter snapshots. Seven relevant source files
matched the release checkout, native search executed through injected
operations, and both real E2B SDK entrypoints passed split-UTF-8 checks.
The subsequent cloud probe recorded hashes from those actual deployed imports.

## Automated and deployed tool comparison

- Local build validation: 297 adapter tests and 94 sandbox tests passed,
  including 26 native search comparisons, eight Host-I/O exclusion tests and
  twelve E2B entrypoint UTF-8 tests. Required typechecks passed. Deployment
  checks: nine passed, one optional skip. All four PR CI jobs passed.
- Native reference: actual macOS Pi 0.80.10 with Pi-managed rg 15.1.0 and
  fd 10.4.2, running 54 observations across all seven tools.
- Deployed auto-story: the installed Host code created a disposable sandbox
  and ran the same cases plus two cloud-specific observations, for 56 total.
  No patched source bundles or replacement executables were uploaded.
- Other templates: code-interpreter and code-interpreter-vfscli each ran 13
  search/execution observations against their newly published images.
- All seven tool parameter schemas matched the native reference exactly.

The 56-case comparison contains 35 strictly identical observations, 13
behavior differences, three error-text differences, three native variations
(search traversal order, fd limit subset and platform binary matching), and
two successful cloud-only observations. These counts include several cases
for the same underlying issue; they are not 13 independent defects.
Each other template had ten strictly identical observations, one native
traversal-order variation and two successful cloud-only observations.

Search checks cover Unicode regular expressions, brace/question-mark globs,
recursive basename matching, ignore rules, hidden paths, context bytes,
limits, empty directories, symlink roots and absolute Skill-style paths. Cancellation
waited for a real `rg` process blocked on a FIFO, then verified `Operation
aborted` and zero surviving matching PIDs. The cloud-only checks verified
sandbox `~/` expansion and the executor's actual exit code 7. Split UTF-8
output remained `中文😀`. Bash timeout/abort continuation markers were absent.

Direct binary-file matching exposed an upstream platform difference: raw
Darwin rg JSON returned `needle\n`, while Linux rg returned
`needle\u0000bad\n` for identical fixture bytes and Pi's exact arguments.
Running Linux rg with `--no-mmap` reproduced Darwin's output. This was
independently reproduced using the published sandbox image without Pi, E2B
or the adapter; raw outputs remain in the receipts. The adapter does not
alter native rg output to conceal this difference.

## Remaining differences

| Tool | Observed local/cloud difference |
| --- | --- |
| `bash` | Cloud still invokes `/bin/sh`; Bash array syntax fails. Its Pi operation returns exit code 0 after normal stream completion, hiding an actual command exit 7. Explicit timeout 0 succeeds in cloud while native Pi rejects it. Timeout/abort errors also differ and can lose preceding output. |
| `read` | Cloud rejects symlink reads, invalid UTF-8 and NUL-containing text; its 32 MiB transport cap also prevents a small page read from a larger file that native Pi permits. Missing-file errors differ. Ordinary text pagination and PNG image content matched. |
| `edit` | Cloud rejects symlink edits and loses an existing UTF-8 BOM. CRLF preservation and ordinary replacements matched. Raw post-edit bytes were compared. |
| `ls` | Cloud rejects an empty directory and omits empty subdirectories/symlink entries from a populated directory. |
| `write` | Sampled nested-directory, Unicode, BOM and symlink writes matched; this is bounded test evidence rather than universal parity. |

The low-level executor now exposes actual exit status, but the existing Pi
`bashOperations` adapter does not yet consume it. A model choosing another
tool or passing different prompts cannot repair these remaining semantics.

## Deployment recovery and Agent acceptance

The first full Host rollout exposed missing pre-existing database migrations
0007–0009. With `PG_ENSURE_SCHEMA=false`, the missing `loops` table caused
scheduler errors and missing `api_keys.revoked_at` caused API-key requests to
return HTTP 500. Health alone did not detect this readiness problem. The Host
was rolled back and the auto-story API verified HTTP 200 before proceeding.

The database was matched through independent application-PG and privileged
postgres-meta table identifiers. Only the three checked-in SQL migrations were
applied in a transaction. Subsequent application-PG reads confirmed the new
table, all four required columns and five indexes. The same verified Host
image was then restored. Future full-image releases must audit required
database migrations before rollout, even when the previous image's source
revision suggests that it already contains those features.

The restored Host Pod `oma-server-7896484fc7-hlmdz` became Ready with zero
restarts. Several scheduler intervals passed with no missing-table or
missing-column errors. The public health endpoint returned HTTP 200, and
authenticated Agent and Session APIs succeeded.

Real acceptance Session:
[sess_UR48VnTmtf3MsE-9dcig1](https://agentry.welltop.tech/sessions/sess_UR48VnTmtf3MsE-9dcig1).
The existing auto-story Agent ran `openai-codex/gpt-6-astra` and completed
20 actual tool calls across all seven native tool names, with zero tool or
Session errors. Its final status is `idle`.

- Actual grep/find calls returned `src/child.ts` and excluded the ignored
  fixture. Both basename and question-mark path globs were exercised.
- The write/edit/read round trip produced the persisted bytes `after`.
- All eight original projected Skill headers were read with `limit=8`:
  five MediaKit Skills, VFS CLI, video-analysis and narration-led-film.
- `read` returned a real `image/png` content block. The persisted 32×32 red
  PNG is 97 bytes, SHA-256
  `becf0cf30d6978325d9ccdea315923e2dbbf7e591c2857b92b5f82e41957bb98`.
- The Agent checked rg 15.1.0, fd 10.4.2, VFS CLI 0.3.14 and MediaKit 0.2.1
  from the actual sandbox, and wrote `pi-cloud-acceptance/agent-report.json`.
  A separate authenticated API read verified the report, note and PNG.

This Session tests the Astra model's tool integration and Skill availability.
It does not rerun media generation or Skill business workflows, and does not
claim a fresh K3/Sol model acceptance. Existing story artifacts and user
Sessions were not modified. The acceptance Session is retained for review.

## Evidence and cleanup

Receipts are retained at
`/Users/zhangyuzhong/Downloads/pi-agent-云端验收-20260909/`.
They include the native/cloud JSON, comparator, standalone probe, image audit,
three-template build logs and independent rg platform evidence.

All three disposable tool-probe sandboxes were deleted:
`auto-story-bsp2d`, `code-interpreter-mwbmb`, and
`code-interpreter-vfscli-w99nt`. Named temporary probe files were removed from
the Host. An initial probe startup failure revealed an incorrectly guarded
local-cleanup branch that attempted to remove `/home/user` and the synthetic
projection directory on the Host. The guard was corrected before the completed
run. The exact image baseline had neither path, both parents were ordinary
directories, and the Pod had no corresponding mounts; the audit found no
persistent workspace target affected. The receipts retain this incident and
the path/mount audit rather than treating it as a successful test.

Temporary API credentials were revoked after acceptance; the single key from
the failed pre-migration request was removed. The build host reached its
unprivileged disk-space limit during verification. Only this release's export
cache and thirteen verified private BuildKit records were removed; no other
cache IDs or images changed. BuildKit reported 1.102 GB reclaimed, restoring
about 663 MiB available space and normal non-root container writes. The exact
cleanup inventory is retained; build-host disk headroom remains limited.
