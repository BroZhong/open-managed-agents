# ADR-0022: Agent Skills are versioned bundles in OSS, installed into the Sandbox by Skill Set version

## Status

Proposed for #262 (parent #259), pending the user's review. The design was
settled in review on 2026-10-23. #261 measures the Sandbox-side download and
calibrates the install budget; #263–#273 implement and roll it out.

Supersedes ADR-0005 §3 and §4 (Read-only Projection, Provision Source) and
ADR-0008's Skills paragraph. Revises ADR-0019's per-Turn Skills refresh and
ADR-0004's file copy on equip and Agent Fork, as listed under "Superseded and
revised decisions".

## Context

Every Turn of a Sandboxed Agent copied all of its equipped Skills from Supabase
Storage into its Sandbox as Read-only Projections (ADR-0005, ADR-0008).
`prepareExisting` listed `/skills`, deleted every existing and target Skill
directory and projected them all again; `S3ProvisionSource` listed each Skill
recursively and read every file. For the storyboard Agent of the mount
verification (19 Skills, 323 files, 5.0 MB) that is about 460 Storage requests
and 323 Sandbox writes on every Turn, whether or not anything changed.

A Child Session runs its parent's Agent and shares the root Session's
environment binding: `DelegationStore.accept` creates it with the parent's
`agentId` and `sandboxSessionId`. Each Turn of each Child therefore repeated
the same copy into the same Sandbox. In the prod300 batch of 2026-10-22 (#259)
Supabase Storage answered HTTP 544 `DatabaseTimeout` 87 times (list and
getObject). 146 Child Sessions still had `session.status_running` as their
latest event, the oldest for about 43 minutes; a sampled Child showed no model
or tool event for 34 minutes while its `/skills` was still being rewritten. A
read-only load test reproduced the same 544 against Storage directly, without
Runner or Sandbox; it is related evidence, not a proven root cause.

The copy had no version. Nothing could tell an unchanged Sandbox from a stale
one, a Turn could read a tree half deleted and half rewritten, and a Turn
preparing a shared Sandbox could delete files a parallel Turn was using.
Separately, the upload route reads every file with `.text()`, which corrupted
all stored TTF and `.pyc` files, including those of the 3 production and 4 test
copies of `precise-subtitles`.

Evidence: the [#259 handoff](../verification/oma-skill-sync-stall-handoff-2026-10-22.md),
the [Storage load test](../verification/skill-storage-local-concurrency-2026-10-22.md)
([JSON](../verification/skill-storage-local-concurrency-2026-10-22.json)) and
the [read-only OSS mount verification](../verification/skills-oss-mount-2026-10-22.md)
([JSON](../verification/skills-oss-mount-2026-10-22.json)).

## Decision

### Storage: each Skill version is one immutable Skill Bundle

- Each version of a Skill is one zip, a **Skill Bundle**, content-addressed by
  its sha256 within a Tenant. Bundles live in the OSS bucket `agentry` under
  the system prefix `__oma/skills/<tenantId>/<sha256>.zip`, outside every
  Workspace prefix. Identical content yields the same bundle; a bundle is never
  modified.
- PG `skills` gains `bundle_sha256` and `bundle_size` (uncompressed bytes): the
  Skill's current version. The row keeps the Skill's identity, owner and
  metadata; the bundle is the only copy of its files. There are no per-file
  objects.
- Equip and Agent Fork create a new Skill row that references the source's
  bundle; no object is copied. ADR-0004's fork semantics are unchanged: after
  equip, an edit on either side produces a new bundle for that side only.
- Every edit produces a new version: an upload or replacement, writing,
  deleting or renaming a file, renaming the Skill through `SKILL.md`, and a
  metadata change that touches files. The edit is applied to the version it was
  based on and published by compare-and-set on `bundle_sha256`; a concurrent
  edit based on the same version is rejected with HTTP 409.
- A Skill holds at most 50 MB uncompressed. There is no file-count, per-file or
  per-Agent limit. `.pyc` files and `__pycache__` directories are filtered out.
- Files are bytes end to end. A multipart file upload is added for existing
  Skills; the text PUT `/v1/skills/:id/files/content` stays text-only; reading
  a binary file returns its metadata, and a separate endpoint returns its
  bytes; the CLI writes bytes.
- Bundle garbage collection is deferred to #273. Until then every bundle stays.

### Runtime: install by Skill Set version

- The **Skill Set** is the Agent's equipped Skills as (name, `bundle_sha256`)
  pairs. Its hash is order-independent: it is computed over the pairs sorted by
  name. The Host computes it from PG at the start of each Turn.
- The environment binding records what its Sandbox holds, in two new columns:
  `delegation_environments.skills_sandbox_id` and `skills_set_hash`. When both
  match (the same Sandbox, the same Skill Set) the install is skipped entirely,
  with zero OSS and Sandbox calls. Child Sessions share their parent's binding,
  so they never reinstall an unchanged Skill Set.
- Otherwise the Sandbox pulls the bundles itself, in a **Skill Install**. The
  Host signs a short-lived presigned GET URL for the OSS internal endpoint for
  each bundle the Sandbox does not already hold, and passes the URLs to a root
  exec through stdin, never in argv or logs. The exec downloads with
  `curl --noproxy '*'`, extracts into `/opt/oma/skills/<setHash>`, makes the
  copy read-only (owned by root; directories and executables 0555, other files
  0444) and then atomically switches the `/skills` symlink to it. The Sandbox
  holds no OSS credentials. The Workspace signer signs only for public endpoints
  by design (ADR-0012) and rejects internal ones; it keeps doing so, and Skill
  Install uses a new signer for the internal endpoint.
- The binding is written back only after complete success, by snapshot → work →
  compare-and-set, like the existing environment operation
  (`withEnvironmentLock`). No database lock is held during the install. Installs
  are idempotent, so a lost compare-and-set or a lost Runner costs at most a
  repeated install. Within a process, one install per binding runs at a time.
  Two Runners can still install the same set into one Sandbox at once, so a
  version directory is used only once it is complete, and a complete one is
  never rewritten.
- On an existing Sandbox, the legacy `/skills` directory left by projection is
  moved aside and cleaned up. After a switch the previous version's directory
  is kept.
- Prompts keep the path `/skills/<name>/SKILL.md`. Equipped names must be safe
  single directory components and unique among the Agent's Skills; a violation
  fails visibly before execution (retained from ADR-0008).

### Visibility

A change to a Skill Set takes effect atomically at the start of the next Turn.
An attempt of a Resumed Turn computes its Skill Set when it starts, since
ADR-0021 assembles Skills per attempt. Parallel Turns sharing a Sandbox, such as
a parent and its children, may see the new version once another Turn has
switched `/skills`, but never a half-installed tree.

### Non-blocking and observable

- The install runs concurrently with inference. The model request does not wait
  for it; the first tool call waits for its result, and no business operation
  runs before preparation succeeds (ADR-0019).
- Budget: max(30 s, bytes ÷ measured throughput), with throughput initially
  assumed to be 20 MB/s and calibrated by the #261 spike; one retry. A failure
  ends the Turn with `skills_install_failed` and an error naming the stage and
  the cause. A Turn never shows running indefinitely while it prepares Skills.
- An install emits `span.skills_install_*` events (a start and an end) with its
  duration, bytes downloaded, number of Skills and, on failure, the reason. A
  skipped install emits nothing.

As implemented (#268):

- Before inference the Turn still waits for the cheap steps: reconnecting the
  Sandbox, verifying its mount and deciding the install (one read of the
  binding's record). They keep their failures (`sandbox_prepare_failed`; an
  unreadable record is `skills_install_failed` at stage `check`), and a
  skipped install is complete when preparation returns, as before. A cold
  Sandbox installs when the Turn's first Sandbox operation creates it.
- Every Sandbox operation waits for the install. A failed install fails the
  operation without running it (`skills_install_failed: <error>. The tool was
  not executed.`), and the first such failure ends the Turn: the Router aborts
  the Adapter run, gives any call left without a result the same answer and
  records `session.error` `skills_install_failed`. The Turn installs no more.
- A Turn that makes no Sandbox operation waits for its install only at its
  end, so the end span precedes `session.turn_completed` and a complete
  install is recorded. If that install failed, the Turn keeps its answer and
  ends with `session.error` `skills_install_failed` naming the stage and
  reason ("The answer is retained; ..."), like the Workspace check at Turn
  end. The binding records nothing, and the next Turn installs again.
- An Interrupt cancels the install: its exec is killed, it is neither retried
  nor recorded, the binding's single flight is free at once, and the end span
  says `aborted`. A cancelled install, by an Interrupt or a stopped attempt,
  records no error.
- `span.skills_install_start` carries `turnId`, `installId`, `setHash` and
  `skills` (Skills in the Set); `span.skills_install_end` adds `outcome`
  (`installed`, `failed`, `aborted`), `durationMs`, `downloaded` and `bytes`
  (installed) or `stage` and `reason`. The Host writes both through the Turn
  attempt's journal under keys of the attempt (`installId` is
  `<claim generation>.<n>`). An attempt that stops writes no end; the attempt
  that takes the Turn over ends each unended start right after its takeover
  marker, `aborted` without a duration. A Child Turn that only waited for its
  parent's install writes none.

### Rollout

This is informational; the release tickets own the procedure.

- A migration script converts Supabase Skills into bundles: a full copy at T0,
  then the API and the Runner are deployed together, then a delta pass converts
  the Skills updated after T0 (#266).
- Supabase Skill data is kept for 14 days (#272).
- The Read-only Projection and Provision Source machinery and the runtime
  Supabase Skill code are deleted outright, with no compatibility shim.
- The test environment goes first. Production needs separate authorization.

## Consequences

- A Turn whose Skill Set did not change costs only PG reads for Skills and no
  OSS or Sandbox call. This holds for every Turn of a delegation tree, so the
  Child Sessions of #259 no longer touch Skill storage at all. Supabase Storage
  leaves the Turn path.
- A changed Skill Set costs one download of each changed bundle from the OSS
  internal endpoint, bounded by the budget and overlapping the model request.
- Storage grows with versions, not with equips: forks share bundles, and every
  edit, even a one-line one, writes a complete new bundle. Old bundles
  accumulate until #273.
- The skip rule trusts the Sandbox's local disk for as long as its ID stays
  bound, while ADR-0019 gives local files no preservation guarantee. A Sandbox
  that kept its ID but lost `/opt/oma/skills` would keep a dangling `/skills`
  until its Skill Set changes or it is rebuilt.
- `/skills` is read-only to accidental writes, not a security boundary: the
  Sandbox user has passwordless sudo (mount verification). A modified copy
  affects only that Sandbox and stays until the next install.
- The test environment shares the `agentry` bucket with production, and bundle
  keys carry no environment. Equal keys hold equal bytes, so sharing is
  harmless for writes, but #273 must not collect a bundle that the other
  environment still references.
- `__oma` must never be a Tenant ID: `workspaceObjectPrefix` accepts it today,
  and its Workspace prefixes would overlap the system prefix. Registration
  creates UUID Tenants.
- Binary Skill files keep their bytes from upload to Sandbox. Corrupted files
  already stored are not recovered by conversion; #266 replaces the damaged
  `precise-subtitles` fonts and drops the `.pyc` files.

## Rejected alternatives

### A live read-only mount of the Agent's Skills

Mount a per-Agent OSS prefix read-only at `/skills` through ossfs. The
2026-10-22 verification showed the infrastructure supports it: the mount works
beside the Workspace, writes fail with `EROFS` and the read-only credential
rejects writes independently. It is rejected:

- Content changes in the middle of a Turn, file by file and not atomically, so
  a Turn can read a mix of two versions.
- ossfs1 caches stat and list results for about 900 s: deleted or renamed
  entries stay visible; a deleted Skill directory disappeared only after
  897.8 s.
- The mount exposes the Agent's whole prefix, including Agent-owned Skills that
  are not equipped.
- The 461 existing production Sandboxes have no maximum age and would need to
  be re-created to gain the mount.

### A mount pinned to the version at Sandbox creation

Atomic, but a long-lived Sandbox never receives an update.

### Industry practice

Both hosted agent APIs we checked treat a Skill as a sequence of uploaded
versions that a request references by version. Anthropic's Agent Skills API
makes each new version "a complete snapshot, not a delta", referenced by
version ID or `latest`, and copies Skill files into the container at
`/skills/{skill-name}/`
([Using Agent Skills with the API](https://platform.claude.com/docs/en/build-with-claude/skills-guide)).
OpenAI's Skills guide states "Uploaded skills use versioned bundles", uploaded
as a zip of at most 50 MB and referenced by a pinned version or `latest`
([Skills](https://developers.openai.com/api/docs/guides/tools-skills)).

## Superseded and revised decisions

- ADR-0005 §3 is superseded. Its Workspace half was already superseded by
  ADR-0008; the Read-only Projection and its Provision Source are replaced by
  the Skill Install of the Agent's Skill Set. There is no pluggable content
  source. The rule that Skills live outside the Workspace and are never written
  back is retained. Its Status sentence that Skills Read-only Projections
  remain accepted no longer holds.
- ADR-0005 §4 is superseded in its mechanism: Skills must still be in the
  Sandbox, because the `read` tool is mapped into it, and they get there by
  Skill Install instead of as a Read-only Projection.
- ADR-0008's paragraph "Skills retain Supabase storage and Read-only
  Projections" is superseded: Skills are Skill Bundles in OSS. The
  `/skills/<skill-name>` path, ID-based authorization and visible failure of
  unsafe or duplicate names are retained; rename reconciliation becomes the
  version-directory switch. The Sandbox Manager's "projection refresh" becomes
  the Skill Install, and the statement that Host OSS configuration is
  independent of Skills configuration no longer holds.
- ADR-0019 "Decision": "verifies the exact OSS mount identity and refreshes
  Skills" becomes "verifies the exact OSS mount identity and verifies the Skill
  Set version, installing it when it changed". Mount verification, the finite
  lifetime, cold pure chat staying cold and "no business operation executes
  until preparation and binding persistence succeed" are retained; the model
  request no longer waits for the install.
- ADR-0004 is revised: equip and Agent Fork no longer copy files; the new
  Skill row references the source's bundle. Ownership, `source_skill_id` and
  the independence of forks are unchanged. "One copy per Agent per Skill" no
  longer describes storage growth.
- ADR-0006 (Context, §5), ADR-0010 §2 and ADR-0014 speak of projected Skill
  bodies. Their rule that Skill bodies exist only in the Sandbox, read at
  `/skills/<name>/SKILL.md`, is unchanged; only the mechanism is renamed.
