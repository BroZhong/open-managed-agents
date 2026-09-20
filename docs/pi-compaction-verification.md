# Pi 0.83.0 automatic compaction verification

Baseline: `@earendil-works/pi-ai` and `pi-coding-agent` **0.83.0**, pinned in
Adapter and Server lockfiles. See ADR-0012 and `adapter/patches/README.md`.

## Reproduce

```sh
pnpm --dir adapter install --frozen-lockfile
pnpm --dir server install --frozen-lockfile
pnpm --dir web install --frozen-lockfile
pnpm --dir adapter typecheck
pnpm --dir server typecheck
pnpm --dir adapter test
pnpm --dir server -r test
pnpm --dir web test
pnpm --dir web build
```

For a focused native/platform comparison:

```sh
pnpm --dir adapter/packages/pi-agent exec vitest run \
  test/compaction-sdk.test.ts test/context-persistence.test.ts \
  test/compaction-events.test.ts test/continuation-sdk.test.ts
pnpm --dir server/packages/session-router exec vitest run test/delegation.test.ts
pnpm --dir server/packages/api exec vitest run test/delegations.test.ts
pnpm --dir web exec vitest run src/lib/compaction.test.ts \
  src/components/conversation-view-dom.test.tsx src/lib/session-event-stream.test.ts
```

## What the comparison proves

`compaction-sdk.test.ts` uses the actual installed Pi SDK for both paths. It
replaces only network model responses and ambient resources, using the same
model, high thinking, 1000-token context window, 100 reserve tokens, 30 retained
tokens, and a one-retry policy. These small test settings force deterministic
boundaries; they are not new production defaults. Summary text is fixed so
random model wording cannot conceal request or boundary differences.

The comparison checks threshold and overflow request order, full summary inputs,
summary thinking/config, summary retries, retry exhaustion, permanent errors,
cancellation responses and overflow recovery exhaustion. It compares subsequent
model messages with the native run. Timestamps are ignored only when comparing
two independently generated runs; direct message replay tests compare timestamps,
usage, signatures and entry IDs exactly.

A subprocess reconstructs the completed history using JSON-serialized platform
events alone. Further cases cover an uncompacted later Turn, Child Session
resume, model switching, independent parent context, tools, steering and a
synchronous Delegation continuation without an extra user input. Native replay
tests retain both S1/S2 for audit while selecting only S2 for model context.
Persistence-failure tests stop requests after both threshold and overflow summary
generation. Host tests cover the awaited write path, repeated delivery, stale
fences and duplicate checkpoint records. API, SSE/reconnect and DOM tests cover
persisted visibility, token labels and summary expansion after refresh.

## Boundaries

- Legacy events cannot recover missing original usage, timestamps, thinking
  signatures, message boundaries or old summaries. They retain their existing
  compatibility behavior; only new native records claim exact message fidelity.
- Host recovery uses the existing execution/fencing rules. A committed summary
  is reconstructible; this does not authorize restarting arbitrary interrupted
  tools or uncertain child executions.
- Summary usage is the usage Pi exposes, not a fabricated count for failed
  requests. After-compaction tokens are estimates. Missing values stay missing.
- These tests do not call paid providers or deploy a Host. They compare controlled
  SDK behavior, not a particular provider's changing live responses.
- Live Supabase tests require their existing opt-in environment and are skipped
  when it is absent. No manual compaction or settings UI is introduced.
