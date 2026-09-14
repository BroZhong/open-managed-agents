# ADR-0003: Pi context built as structured history from the event log

## Status

Accepted. Extends (does not supersede) ADR-0002 — refines how the stateless Pi
Adapter obtains conversation history for each `run()`, without changing the
Adapter contract or the Host-owns-infrastructure rule.

## Context

ADR-0002 established that the Host builds context from the persisted event log
and the Adapter is a stateless per-`run()` translator. The initial Pi Adapter
implementation cut a corner: it flattened prior turns into a single text blob
(`buildPromptWithHistory`) and fed that string to `session.prompt(...)`, using a
throwaway `SessionManager.inMemory()` per turn.

Two problems followed:

1. **Tool-call history is lost.** The text flattener keeps only `user.message`
   and `agent.message`; it drops `agent.tool_use` / `agent.tool_result`. So on a
   multi-turn conversation the model cannot see what tools it previously ran or
   what they returned — only the words exchanged. Our `ContentBlock` union has no
   tool_use/tool_result variants at all.
2. **Provider-layer capabilities go unused.** The Pi SDK's provider layer already
   normalizes tool-call ids across providers (`transformMessages` /
   `normalizeToolCallId`), drops cross-provider-incompatible thinking/signatures,
   injects synthetic tool results for orphaned calls, and can compact. Feeding it
   flat text bypasses all of it.

A separate desire (a user QA question) is that changing an Agent's model should
affect existing conversations, not only new ones — see slice "Existing
conversations follow the Agent's current model".

We investigated the installed Pi SDK (`@earendil-works/pi-coding-agent` 0.80.3)
to find a seam that keeps the **event log as the single source of truth** (no
second on-disk JSONL to keep in sync) while regaining structure + provider
capabilities.

## Decision

### 1. Rebuild structured history from the event log each turn

The Host converts the session's event log into a Pi `AgentMessage[]` on every
turn (a new `eventLogToAgentMessages` translator), preserving structure:

- `user.message` → `{ role: "user", content }`
- an `agent.message` plus the `agent.tool_use` blocks from the same turn →
  `{ role: "assistant", content: [text…, toolCall{ id, name, input }],
    provider, api, model }`
- `agent.tool_result` → `{ role: "toolResult", toolCallId, content, isError }`

The `toolUseId` we already store in the event log is the `toolCall.id` ↔
`toolResult.toolCallId` pairing key. Each assistant message carries the
`provider`/`api`/`model` that produced it, so the provider layer's `isSameModel`
check works: same-model turns keep tool ids byte-for-byte (KV-cache-stable),
cross-model turns get normalized automatically.

### 2. Seed an in-memory session; the SDK loads it — no second JSONL on disk

Per turn: `SessionManager.inMemory()` (`persist = false`), replay the rebuilt
messages via the public `appendMessage(...)` (which auto-generates entry
ids/`parentId`, so no hand-built tree), then `createAgentSession({ sessionManager })`.
The factory calls `buildSessionContext()` at construction and seeds
`agent.state.messages`, so the seeded history is in the LLM context on the first
`prompt(...)`. Nothing is written to disk; the event log stays the sole
authoritative store. We depend only on the public `AgentMessage` type and the
`appendMessage` / `createAgentSession` APIs — not on the on-disk entry format and
not on any private agent state.

This is a deliberate rejection of two alternatives: (a) the older text-flatten
path (loses structure + provider capabilities), and (b) the lower-level
`pi-ai` `stream(model, context)` path (stateless and clean, but forfeits Pi's
built-in compaction). Seeding an in-memory `SessionManager` keeps the event log
authoritative *and* retains compaction.

### 3. Model is resolved per turn from the current Agent config

`buildAdapterInput` supplies the model from the Agent's **current** config, not
the model snapshotted on the Session at creation. Because we rebuild a fresh
in-memory session each turn and replay history, switching an Agent's model takes
effect on existing conversations at zero cost; prior assistant messages keep
their own origin `provider`/`api`/`model` metadata, so the provider layer
normalizes tool ids correctly across the switch. Only the model is resolved live;
other Session-snapshot semantics (e.g. the agent identity) are unchanged.

### 4. Compaction stays with the Pi SDK for now; Host-side compaction is future

The seeded-`SessionManager` path retains Pi's automatic compaction. A Host-owned
compaction driven off the event log (decide when/what to compact, write the
summary back as an event) is a later optimization, out of scope here.

## Consequences

- The `ContentBlock` / event schema must map losslessly to Pi's `toolCall` /
  `toolResult` shapes; `agent.tool_use` blocks must be aggregated into the
  assistant message of their turn (Pi assistant messages interleave
  `text`/`toolCall` in one `content` array), not emitted as standalone messages.
- The event log must carry (or let us derive) the origin model of each historical
  assistant turn, so `isSameModel` is accurate. If unknown for legacy events, the
  worst case is a cross-model normalization pass, which is safe.
- The rebuilt assistant message must carry the recorded `stopReason` rather than
  asserting completion, for the same reason as the model metadata: it is a fact
  about the historical message that only the log knows. It is what lets Pi's own
  conversion layer discard an **Interrupted Turn**'s half-written output ("the
  model should retry from the last valid state") while the event log and the
  frontend keep it — a deliberate two-layer divergence. Because Pi drops such an
  assistant whole, the tool results belonging to its discarded tool calls are
  dropped with it; otherwise a result would reach the provider with no request in
  front of it. A missing `stopReason` means completed, so legacy events and
  runtimes that report none are unaffected.
- KV cache is prefix-stable within a single model across turns (tool ids
  round-trip unchanged); it necessarily misses when the provider changes or when
  compaction rewrites the prefix — both unavoidable and unrelated to id handling.
- Host-side compaction, if later adopted, would move that concern out of the SDK
  and onto the event log, consistent with ADR-0002's "Host owns infrastructure".
- The Adapter remains a pure per-`run()` translator (ADR-0002 §1); this ADR only
  changes *what* it translates (structured history vs. flat text), not the
  contract.
