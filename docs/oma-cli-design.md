# OMA CLI v0.1 design

Implements the first-version command surface from GitHub #180–#196. The CLI is
an independent Node.js >=22 npm package, with TypeScript compiled before packing
and no runtime dependencies. `oma-cli-local` is a local tarball name; public npm
scope/ownership is undecided. No publish, deployment or service logic changes.

## Boundaries

`commands/` registers executable command descriptions, flag definitions, body
fields, requirements, exclusivity, API mappings and effects. `input.ts` performs
strict offline validation and merges only non-overlapping sources. Discovery
builds help/schema from those definitions. `http.ts` owns prefix-aware Host
requests, credential separation, errors, per-request timeout and cursor traversal.
It never retries writes (currently ordinary reads also have no implicit retries).
`output.ts` handles envelopes, field/raw, fixed/default columns, CSV and NDJSON.
`local-files.ts` owns local symlink/path checks and complete-file commits.
`events.ts` owns durable history, resumable SSE and Session waiting.

Workspace file operations first read Workspace metadata so deleted Workspaces are
not accessible through CLI, even on a Host whose file routes still accept their
IDs. This is a client-side read-only precheck; it does not change the Host API or
claim an atomic gate against concurrent deletion. Workspace get uses metadata
plus the complete filtered list. System `.oma-workspace-checks` and directory
markers are excluded, while ordinary hidden and zero-byte files remain visible.

Skill uploads mirror the Host's existing single-line frontmatter parser. They
validate selected trees and all remote Library pages before making one multipart
request per Skill. File edits operate on the supplied Library/fork ID; root
SKILL.md protection and same-path rename avoidance are client responsibilities.
Equip/unequip and Agent fork preserve the Host ownership semantics in ADR-0004.

## Event and wait boundaries

History preserves native-projection sequences and lazy payload references
(ADR-0015/0016). SSE uses explicit IDs in the current frame, ignores transient
frames, reconnects with its last emitted sequence, and bounds consecutive failed
connections. Keepalive refreshes transport inactivity timeout; overall duration
never restarts. Follow does not end on idle/terminated and emits no result.

Wait scans durable inputs (`user.message`, tool confirmation/custom tool result,
`delegation.input`, `subagent.result_claimed`) and never parses turnId strings.
Unclaimed `subagent.result` notifications are not new Turns. It polls the real
Session endpoint and drains history around stable idle observations, including a
final read to catch a complete fast Turn between observations. It never uses the
bounded pending preview as proof of drain. Matching public turnId associates
complete text blocks with the latest input's completion. No fallback to older
successful replies. Stream uses the same durable history reader; send captures
its cursor before submission and only emits subsequent records.

Reliable idle is a server prerequisite: PR #179 atomically commits final input
acknowledgement, idle and its lifecycle event. Doctor can check advertised routes
but cannot attest a deployed transaction implementation from OpenAPI, so it
reports that capability caveat. Verification includes the actual repository Host
and SessionRouter with input injected between completion and acknowledgement,
as well as a real deployed two-input workflow. No new state endpoint or server
state-machine changes are introduced.

## Verification and development

```sh
npm --prefix cli ci
pnpm --dir server install --frozen-lockfile  # real Host test dependencies
npm --prefix cli run typecheck
npm --prefix cli run build
node --test cli/test/sessions.test.mjs
npm --prefix cli test
node cli/scripts/verify-package.mjs
```

The pack verifier installs into an independent temporary directory, exercises
compiled commands without source dependencies, and reports a tarball SHA-256.
`cli/scripts/live-acceptance.mjs` is explicitly opt-in: environment credentials,
new unique resources only, installed CLI, actual Agent output checked separately
from successful wait, and cleanup recorded. Unknown execution outcomes retain
resources for inspection. It is excluded from the published package.

User-facing workflow and operational limitations are in the bundled guide.
