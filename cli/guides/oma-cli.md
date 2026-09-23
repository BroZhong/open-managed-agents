# oma-cli

Version 0.1.0. This guide is distributed with the CLI. The local npm package name
`oma-cli-local` does not reserve a public registry name. Requires Node.js >=22.

## Connect and discover

Set OMA_BASE_URL and OMA_API_KEY or pass --base-url and --api-key; flags win.
There is no default production URL. A deployment prefix is retained, for example
`https://oma.example.test/api`. Host requests use x-api-key. Signed Workspace
requests have no Host credentials. Do not put real keys in shared scripts.

`oma-cli --help`, `--version`, `version`, `schema`, `schema session send`,
`guide list`, and `guide read --name oma-cli --raw` work offline.
`doctor --offline` checks local configuration; `doctor` additionally reads health,
authenticated Agents and OpenAPI, without creating resources or running a model.
OpenAPI cannot attest the atomic queue-drain implementation: verify PR #179.

## Agent and Session workflow

```sh
oma-cli agent list
oma-cli agent get --agent-id agent-example
oma-cli workspace create --workspace-id workspace-example --name "Example"
oma-cli workspace file upload --workspace-id workspace-example --path input.txt --file ./input.txt
oma-cli session create --agent-id agent-example --workspace-id workspace-example
oma-cli session send --session-id session-example --prompt "Read input.txt and write output.txt"
oma-cli session wait --session-id session-example
oma-cli session events list --session-id session-example --all
oma-cli session events read --session-id session-example --seq 1
oma-cli workspace file list --workspace-id workspace-example
oma-cli workspace file download --workspace-id workspace-example --path output.txt --output ./output.txt
```

Use the IDs returned by create, not the placeholder IDs above. Agent create
requires name/runtime/model/system. Runtime is claude-code, codex, pi-agent or
mock; model names are deployment-specific. Agent updates only send supplied
fields. Agent fork copies configuration, Agent Files and private Skill trees,
without Sessions, Loops or Workspaces. Existing Sessions have saved snapshots.
No arbitrary MCP, Sandbox or tools configuration can be written through CLI.

Agent Files use IDENTITY/SOUL/USER/MEMORY (without .md). They are shared by the
Agent’s Sessions. `agent file write` fully replaces text; it does not append.

Send accepts one prompt, prompt-file (including stdin `-`), or events body.
Default send reports acceptance, not execution success. `session pending` is
only a 20-item unclaimed preview; count is not queue depth and empty is not idle.
Interrupt requests stopping the current Turn; queued inputs and output remain.
Session delete uses POST deleted:true to hide it; it does not terminate execution.
Workspace delete hides it and its associated Sessions; neither soft-delete frees
file storage or offers a recovery API. Agent delete has no cascade guarantee.

## Observe and wait

```sh
oma-cli session send --session-id session-example --prompt-file ./prompt.txt --wait --stream
oma-cli session wait --session-id session-example --wait-timeout 10m
oma-cli session events follow --session-id session-example --after-seq 0 --duration 5m
```

Follow prints every persistent Complete Event as NDJSON kind:event/type/seq/data.
Frame-local durable IDs exclude Deltas; replay/live overlaps are deduplicated.
Follow survives idle and terminated states; it has no final result. Resume using
the last seq with --after-seq. Event read lazily expands server payload references.

Wait requires a Host containing PR #179’s atomic queue acknowledgement/idle
contract. A turn_completed or an empty pending preview alone is not completion.
It drains history around idle observations and includes newly accepted input.
Normal output contains every text block of the last ended Turn, without falling
back to older successful Turns. Stream replays the most recent input onward and
adds exactly one kind:result at completion; send prepares its cursor before POST.
Future child results that have not arrived are outside the accepted-input boundary.
Wait success certifies queue drain, not business success or correct artifacts.

Wait timeout defaults to 2h; 0 is unlimited. It starts after send acceptance and
is distinct from the per-request --timeout (30s). Timeout or SIGINT ends only the
local observer. After an accepted send fails while waiting, use independent wait
or read history; do not resend. Terminated Sessions return conflict, not success.

## Files and Skills

Workspace read/write are full UTF-8 text operations; upload/download preserve
arbitrary bytes. --raw preserves content without adding a newline. URL returns
a temporary signed descriptor only; --download on url controls attachment headers.
Workspace URLs default to 600 seconds, accepting 60–900. MIME is descriptive.

Paths are relative and reject absolute paths, backslashes, empty/dot/parent
segments and controls. Recursive Workspace transfers require --recursive;
--path . means root. Contents retain relative hierarchy without nesting the source
folder. Hidden/empty files are included; empty directories and metadata are not.
Directory prefixes match boundaries. Local symbolic links are rejected.

Transfers preflight all paths and conflicts. --overwrite only permits replacing
ordinary files and does not bypass path safety. Remote conflict preflight cannot
prevent concurrent changes. Downloads use temporary files and commit complete
bytes. Failures retain successful items; there is no batch rollback or resume.

```sh
oma-cli skill upload --directory ./example-skill
oma-cli agent skill equip --agent-id agent-example --skill-id library-example
oma-cli agent skill list --agent-id agent-example
oma-cli skill file read --skill-id fork-example --path SKILL.md --raw
oma-cli skill file write --skill-id fork-example --path notes.txt --content "Private notes"
oma-cli skill download --skill-id fork-example --output ./exported-skill
```

Equip creates an independent fork ID. Re-equipping the same Library without
overwrite preserves private edits; overwrite replaces the entire fork tree.
Library changes/deletion do not propagate. Unequip uses the fork ID and deletes
its private tree and Agent reference; Library remains. skill delete only accepts
Library IDs. Both real deletions require --yes, and neither has recovery.

Skill upload detects a root SKILL.md or direct child directories containing one,
rejecting mixed trees and duplicate names. Each Skill uploads separately after
whole-batch validation and paginated name preflight. Single-line frontmatter
matches the Host parser; YAML multiline descriptions are not fully interpreted.
Names fall back to the real directory basename. Overwrite retains the selected
Skill ID and replaces its full tree. Upload never automatically equips.

Skill files are a server UTF-8 text channel; BOM or invalid bytes may already have
been normalized. Use Workspace transfers for binary fidelity. Root SKILL.md can
be written, updating metadata through the Host parser; it cannot be renamed or
deleted by CLI. Nested SKILL.md is ordinary text. Rename checks source existence;
same-path is a no-op. Other renames copy then delete, so failure may leave two
copies. Skill file delete is idempotent for absent files in an existing Skill.
Skill export is not an atomic snapshot and preserves unrelated local files.

## Inputs, output and errors

Flags can precede or follow command paths. IDs must be explicit. Missing input
fails immediately; no prompts or implicit current resource. --body accepts JSON,
@UTF-8-file or stdin -. Same-field body/flag duplicates are errors. One stdin
consumer only. Command schema lists allowed body fields and flag applicability.

Default output is table on TTY and JSON otherwise. Explicit formats: json, table,
csv, ndjson. JSON uses {ok,command,data,meta}; list metadata is outside data.
--field uses dot paths and numeric indices relative to data, per array row, skipping
missing paths; objects remain compact JSON. It conflicts with explicit --format.
--raw conflicts with format/field. Errors and verbose diagnostics go to stderr.
No automatic write retries. An HTTP failure can leave an unknown remote result.

Every write, including local downloads, supports --dry-run: validate and read-only
preflight, then a JSON HTTP/effects plan, with no remote or local target writes.
Sensitive body content is redacted. Dry-run needs no --yes; --yes never means
--overwrite. Read-only commands reject dry-run. Multi-item transfers return item
statuses succeeded/failed/unknown plus counts, even for a single item. Partial
failure yields ok:false on stdout, partial_failure on stderr, and exit 1.

Exit codes: 0 success; 1 network/internal/partial failure; 2 validation;
3 not found; 4 authentication/permission; 5 conflict; 10 successful dry-run;
124 timeout; 130 SIGINT. Structured error fields are type/subtype/message/param
(when relevant)/hint/retryable. Follow the hint and inspect remote state before
retrying a write; do not infer that a timeout proves it was not accepted.
