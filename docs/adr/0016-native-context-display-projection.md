# ADR-0016: Native Pi entries own durable message content

## Status

Accepted. Amends ADR-0013/0014's dual native/display output persistence and
extends ADR-0015. Existing histories are not rewritten. The console's display
logic and event shapes remain unchanged.

## Decision

New real Pi executions persist assistant messages, thinking, tool calls and tool
results only through `agent.context_entry`. The Adapter still translates live
deltas, request spans, compaction attempts and other independent execution facts.
It suppresses the corresponding complete display events from both its emitted
durable stream and its Delegation checkpoint. Canonical user/Delegation input
records remain the Host-owned acceptance and ownership facts.

Each new native message carries `presentation: { version: 1, blocks: [...] }`.
These small selectors identify native content indices and display types, plus
MCP naming and stream block alignment where necessary. They contain no message
text, tool arguments, image bytes or result copies. Original native entries,
IDs, signatures and compaction boundaries remain unchanged for SDK replay.

The Host projects these selectors into the existing `agent.message`,
`agent.thinking`, tool-use and tool-result API shapes. HTTP history, live SSE,
SSE replay and Child Session traces use the same projection. Older native rows
without this versioned marker are not projected: their existing display rows
remain authoritative for display, avoiding mixed-history duplication.

A native entry can contain several display blocks. The store reserves N+1
consecutive sequence positions atomically for N projections and the native
record, but inserts only the native row at the range's final position. The
preceding positions are stable derived event cursors, not additional PG rows.
Existing records keep their original sequence numbers. Idempotent retries return
the same range. Both PostgreSQL append paths and the memory store implement this
allocation. Internal runtime reads return only canonical records.

An API read after a cursor inside a range still selects its ending native row,
projects it, then filters and bounds the display page. SSE replay follows the
same cursor ordering. The lazy detail endpoint resolves either a derived cursor
or the canonical cursor through its authorized Session. For large native tool
results, all projections use the one OSS payload reference; lists never hydrate
it. Detail reads hydrate the canonical entry and derive the requested result.

Router aligns each projected completion with its existing transient stream
block before persisting the native entry. Adapter captures run-local stream
indices synchronously so a compaction commit cannot lose alignment by overtaking
the Host's asynchronous event queue. Tool outcomes in interrupted assistant
messages that never executed can be derived as failed result cards without
inventing native tool-result entries. Interrupt draining accepts native entries
under the same renewed pending-input fence; uncommitted compactions stay excluded.

Synchronous Delegation consumes its native result in the existing atomic
transaction. Recovery uses the same consumption identity rather than appending
a second native row under an event-ID key. Host-generated recovered results
remain valid compatibility records where no native result was committed.
Dangling-tool repair and Child Session outcome extraction consume the display
projection internally; Pi reconstruction consumes only the original native log.

## Compatibility and verification

No frontend source changes are required. Deploy the reference-aware reader,
projection-aware sequence allocator and native-only Pi writer together. Old
Host readers cannot display new native-only output; rollback to such a reader
is not supported. No production rollout or historical migration is performed
by this change.

Tests cover native-only SDK output and restoration, multiple blocks in one
durable PG row, idempotent range allocation, pagination and reconnect inside a
range, equality of live and replay frames, one-object large results, owner/share
detail reads, stream alignment, synchronous Delegation and native child output.
Existing native compaction and legacy-history tests remain applicable.
