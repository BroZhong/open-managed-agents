# ADR-0012: Durable Pi messages and automatic compaction

## Status

Implementation superseded by [ADR-0013](0013-public-pi-sdk-boundary.md): public
SDK hooks, temporary import bridge and Adapter request gate replace the patch.
The durability and replay requirements below remain applicable.

Accepted. Supersedes ADR-0003's lossy reconstruction for newly produced Pi
messages and its deferred compaction persistence decision. Extends ADR-0010's
checkpoint protocol without adding automatic recovery of uncertain executions.

## Decision

Pi 0.83.0 owns automatic compaction timing, model selection, summary generation,
summary thinking and retry policy. The Host does not add tool-iteration checks,
a retry algorithm, a manual compaction action, or a compaction settings UI.
Comparisons with local Pi require the same model, thinking and settings.

Each Session, including each Child Session, has its own append-only context
journal inside the existing platform event log. `agent.context_entry` records
carry a version discriminator (`pi@0.83.0`), the native entry and its original
identity, parent, timestamp, message structure, model origin, usage and supported
signatures. They also record the promoted input identity where applicable.
`agent.context_start` records attempted-input ownership before SDK initialization
or prompting. A pre-prompt failure or crash must not turn the unmatched display
input into a legacy message inserted ahead of an already-persisted native chain.
Native entry IDs are preserved on replay rather than regenerated: compaction
`firstKeptEntryId` therefore references a durable identity. No Pi JSONL is used.

The Adapter seeds an in-memory SessionManager through a narrow patched public
`restoreEntry` method. It validates the chain and rejects conflicting duplicate
IDs and missing compaction boundaries. Native `buildSessionContext` selects the
latest compaction and retained entries; previous summaries remain in the event
log for audit. New messages after compaction continue the same durable chain.
Original timestamps retain native stale-usage and model-switch behavior.

Display events remain available, but are not injected a second time. Native
messages replace their Turn's assistant display blocks, their input's canonical
record, matching tool results and applied steering instructions. Host-generated
results for recovered synchronous waits still enter history when no native tool
result exists. Steering is also appended to the native SessionManager, using the
same timestamp for live context and replay.

## Commit barrier and failure

The SDK patch exposes an optional asynchronous `commitCompaction` callback after
a compaction entry is prepared and before the SDK replaces model context. The
Adapter asks the Host to persist preceding native entries and the new compaction
in order. The Host uses the existing pending-input fence and stable event-ID
idempotency keys. Queue delivery and checkpoint recovery reuse these keys.
A failed commit terminates the operation, including overflow compact-and-retry;
no request can use an uncommitted summary. Native summary failures and retries
retain their upstream behavior. This callback adds durability, not a second
compaction policy. Standalone Adapter users must provide `persistContext` to
allow successful compaction.

Interrupt invokes both Pi's `abortCompaction()` and its general `abort()`; the
latter alone does not cancel a summary request. Aborted operations are checked
before subsequent model requests and before committing the compaction boundary.

The compaction entry itself is commit evidence. A crash after its write and
before the SDK end event does not lose the summary or require reapplying it.
An uncommitted summary, failed attempt or cancelled attempt cannot become a
replay boundary. A synchronous Delegation checkpoint includes the new `agent.*`
records under the existing filter. No separate recovery scheduler is introduced.

`agent.compaction` records describe starts, retries and terminal outcomes with a
stable attempt identity. SDK end events without a start get their own identity.
The UI folds these and committed entries into one expandable record, including
trigger, retry information, summary, available summary usage and token estimates.
Pre-compaction tokens are labelled measured only when they match the last valid
native usage exactly; otherwise they are labelled an SDK estimate. After tokens
are always estimates. Missing values remain unavailable, not zero. Terminal Turn
markers or an inactive Session prevent an unfinished start from looking active
forever. A committed entry remains successful even when its end event was lost.

## Legacy compatibility

Old display events use the existing compatibility translator. It cannot recover
missing original timestamps, usage, signatures, message boundaries or historical
compactions. Its SDK-required zero values are unknown-value compatibility
sentinels, not measured facts; they are not backfilled into platform history.
Deterministic legacy entry identities allow a real new compaction to retain an
old message. Mixed histories can continue, but native fidelity is claimed only
for new native records. Corrupt native chains fail visibly instead of silently
reloading an uncompacted prefix.
