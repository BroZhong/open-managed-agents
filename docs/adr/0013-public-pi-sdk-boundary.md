# ADR-0013: Integrate Pi through public SDK mechanisms

## Status

Accepted. Supersedes ADR-0005's requirement to execute native tool factories on
Host through injected I/O, ADR-0010's patched continuation entry point, and
ADR-0012's SDK patch and no-JSONL-import implementation decisions. Their Session,
Delegation, event-log durability and sandbox isolation contracts remain in force.

## Decision

Use the published, unmodified Pi 0.83.0 SDK in Host and Sandbox. There is no Pi
`patchedDependencies` entry, runtime replacement of private methods, or private
SessionManager field access. The E2B transport patch is separate and remains.

### Native tools run in the Sandbox

Host registers the seven tools through `customTools` and disables built-ins.
It reuses public factory schema, argument preparation and prompt metadata, but
provides its own `execute` and file-free renderers. Each execute sends a JSON
request through the existing ToolExecutor, starts a short-lived Node process in
the Sandbox, and invokes an unmodified Pi tool factory there. Thus native path
probes, image processing, edit matching, mutation queues, rg/fd processes and
Bash full-output files all use the Sandbox OS. Model inference and the AgentSession
remain in Host. Host-owned Delegation and managed MCP capabilities retain their
existing explicit execution boundaries; this protocol covers the seven standard
filesystem/process tools, not arbitrary third-party extension code.

The request is a private temporary file, deleted before SDK import. The process
returns newline-delimited acceptance, update, result and error frames; stdout
is decoded incrementally. A result requires a confirmed successful process exit.
Missing runtime, version mismatch, malformed response and uncertain transport
failure fail visibly, with no Host-native fallback. Cancellation sends SIGTERM to the wrapper through a separate executor command.
The wrapper invokes Pi’s AbortController and emits a cancelled frame only after
native execution settles. A cancelled frame and process exit are both required;
killing the wrapper alone cannot prove a detached Bash child stopped. Requests cancelled before process start get best-effort Sandbox cleanup.

Adapter also serializes write/edit requests by executor filesystem identity and
canonical remote path, because native per-process queues cannot coordinate
separate tool processes. It holds the queue until the backend operation settles.
Tool execution keeps the original arguments. Adapter normalizes only the mutation
lock key (including file URLs, Unicode spaces and the Sandbox home); search,
editing and output truncation remain in the SDK. Skill projections and full-output paths remain usable inside Sandbox.

The image installs the exact Pi version from an npm lockfile at
`/opt/oma-pi-tools`; image smoke checks exercise all seven tools offline as the
ordinary user. Release order is Sandbox image/rebuild, then Host. Old images
without this runtime reject tool execution. Local executor developers can set
`OMA_PI_TOOL_MODULE` in the executor environment to their installed SDK entry
point; it must report the expected version. No Host environment is forwarded
by the protocol.

Tradeoff: each tool invocation starts/imports a Node SDK process. This pays cold
start overhead in exchange for a small transport and no internal I/O patches.
A persistent tool worker is deliberately not introduced without measurements.

### Context persistence through public hooks

`PiContextJournal` snapshots new entries with `getEntries()` at model-request,
`tool_call` and operation-settlement boundaries. Pi emits `message_end` before
its own append, so snapshots are not taken as if that event were an append hook.
The `tool_call` extension sees the requesting assistant entry before any durable
Delegation wait records its checkpoint.

The awaited `session_compact` extension writes the pending native prefix and
new compaction through Host's existing fenced, idempotent event-log path. Pi
catches extension exceptions, so persistence failure is stored as sticky Adapter
state. The public `streamFunction` gate and operation settlement both check it.
Pi may have changed its transient in-memory context, but no subsequent model or
summary request can use an uncommitted summary. Such a boundary and later entries
are not emitted as durable native records. Normal upstream compaction and retry
policy is untouched.

Pi 0.83.0 looks up the extension's compaction entry by summary text, which can
refer to an older equal summary. Adapter takes the newly appended boundary from
the journal cursor rather than trusting that lookup.

Native entry chains are validated in Adapter. To import original IDs/timestamps,
Adapter writes a mode-0600 JSONL in a private temporary directory, calls the
public `setSessionFile()` on an in-memory SessionManager, and immediately removes
the directory. `isPersisted()` stays false: this is an import bridge, never a
second durable store. Normal completion/failure cleans the bridge; abrupt process
loss may leave an OS temporary directory, which is not used for recovery.

### Structured continuation

Adapter triggers the SDK's public `sendCustomMessage(..., {triggerTurn:true})`
with an empty, non-displayed `oma.continuation` control message. The public
`convertToLlm` callback excludes that marker from model inputs and state. An awaited public Agent `message_end` listener runs after the SDK append and
before steering, and uses SessionManager `branch`/`resetLeaf` to detach it; the
journal skips it. Thus it cannot become a false turn boundary in later compaction.
No new user input or tool re-execution is introduced. SDK prompt settlement owns
retries and compaction, instead of duplicating that state machine in Adapter.

## Verification

Retain the controlled SDK/platform request comparisons, fresh-process recovery,
commit-failure, Interrupt, equal-summary and Delegation tests. Tool tests compare
unmodified in-process factories with the same unmodified factories in a separate
executor process on shared fixtures, including binary/image data, BOM/CRLF,
Unicode, symlinks, search limits, timeout, cancellation and large output. Separate
boundary tests forbid Host fs/process calls across all seven custom tools and
renderers. These tests do not claim a deployed Sandbox image has been upgraded.
