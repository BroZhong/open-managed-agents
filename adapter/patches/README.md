# Pi search process hooks

`@earendil-works__pi-coding-agent@0.83.0.patch` adds optional process and path
hooks to Pi's native `grep` and `find` factories. The adapter supplies sandbox
operations while Pi retains its original arguments, parsing, limits, errors,
and rendering. `find` can supply `exists` without replacing `glob`; its ancestor
`.git` checks use that same operation.

The patch is pinned to Pi 0.83.0 and applied by `patchedDependencies` in both
the adapter and server workspaces. Both lockfiles carry the same patch hash.
The server workspace needs its own declaration because its adapter dependency
is a `file:` snapshot. Server image builds copy the patch before installing.

Validate a change to this patch with frozen installs in both workspaces and the
adapter's native search parity tests. On a Pi upgrade, rebase the patch against
the exact published package and keep the upstream search implementation intact.
Calling a factory without these hooks retains Pi's local execution path.

## Durable same-Turn continuation

The patch also exposes `AgentSession.continue()`. It reuses the SDK's existing
prompt settlement, retry, and compaction loop while starting from the restored
structured transcript. It does not append a user prompt. The Host first commits
all pending tool results; the Adapter refuses continuation while any result is
missing. `test/continuation-sdk.test.ts` verifies the public SDK method with a
controlled provider failure followed by a successful automatic retry.

## Gateway error normalization (no pi-ai patch)

The adapter uses the public per-Agent `streamFunction` hook in
`packages/pi-agent/src/gateway-error-stream.ts`. It translates observed gateway
errors into the existing Pi error vocabulary while retaining the original text:
`stream_read_error` becomes `Network error`, temporary upstream unavailability
becomes `Service unavailable`, and `AccountQuotaExceeded` becomes `Quota exceeded`.
Pi's existing classifier then drives its bounded retry/backoff loop. No private
method is overridden and no second retry loop is introduced.

Pi 0.83.0 exports `isRetryableAssistantError` but does not offer a custom
classifier callback or additional-pattern setting. Its extension API also
supports custom providers through `registerProvider` / `streamSimple`; the
per-Agent hook avoids replacing provider registrations shared across sessions.
The actual SDK continuation tests exercise this adapter hook against unmodified
pi-ai, including retained tool results, retry exhaustion and permanent errors.

## Pi 0.83.0 compatibility

The stream hook is now `Agent.streamFunction`. An explicit Bash `env` keeps
its remote-environment semantics and defaults session environment exposure off;
`exposeSessionEnvironment` can still explicitly opt in. Native calls without
an explicit environment retain the SDK default.

## Durable context (ADR-0012)

`SessionManager.restoreEntry` and `onEntryAppended` retain native IDs and full
messages without JSONL. `AgentSession.commitCompaction` is an optional awaited
Host commit barrier before context replacement. Commit failure escapes the auto
compaction recovery catch, stopping both pre-prompt and overflow continuations.
Unconfigured native SDK consumers retain native behavior. `compaction-sdk.test.ts`
compares controlled native and Adapter requests, including summary retry options.
