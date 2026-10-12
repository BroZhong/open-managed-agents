# Provider-controlled thinking: Pi 0.83.0 boundary investigation

Verified with controlled SDK requests on 2026-10-12 for #228. This is a release
blocker, not a claim that provider-controlled mode is implemented. Production
rejects `thinkingMode: "provider"`; no SDK patch or production payload hook was
added. The #226 default-support release and #229 rollout depend on resolving it.

## Controlled evidence

Run:

```sh
pnpm --dir adapter --filter @open-managed-agents/adapter-pi-agent test test/provider-thinking-boundary.test.ts test/custom-thinking-requests.test.ts
```

The tests invoke Pi's published native `stream` functions and observe real SDK
HTTP bodies, SSE parsing and replay. They include system instructions, existing
assistant/tool-result history and tool schemas. They use controlled fetch
responses and make no paid inference calls.

| Protocol and public mechanism | Observed result |
| --- | --- |
| Chat Completions, `reasoning: false` metadata | Omits thinking controls but changes the system instruction from developer to system. With Pi's `requiresReasoningContentOnAssistantMessages` compatibility metadata it drops the required empty `reasoning_content` from tool-call history. |
| Responses, native `stream` without effort and `thinkingLevelMap.off: null` | Preserves developer role and tool result, and omits explicit reasoning controls. It also omits `include: ["reasoning.encrypted_content"]`. A controlled server that supplies encrypted reasoning only when requested demonstrates that newly produced reasoning cannot retain or replay its encrypted payload. |
| Responses, `reasoning: false` metadata | Also changes developer to system and does not request encrypted reasoning. |
| Anthropic, native `stream` without thinking options | Omits controls while preserving signed thinking and tool history. This protocol alone does not resolve the three-protocol requirement. |

Pi's public `OpenAIResponsesOptions` has effort and summary options, but no
independent encrypted-content collection option. In 0.83.0, a Tenant-owned
provider receives encrypted-content inclusion when Pi also serializes an effort
or summary control. Special cases for built-in provider identities cannot be
reused by renaming a Tenant provider without violating identity/isolation.
Using full `stream` instead of `streamSimple` therefore does not remove the
Responses blocker.

A read-only npm registry/source check on the same date also inspected published
`pi-ai` 1.1.0. Its Responses builder still couples encrypted-content inclusion to
the reasoning branch for a Tenant provider. Generic payload/sampling-parameter
overrides remain protocol-field configuration, so simply upgrading versions does
not establish the dedicated public mechanism proposed below. The controlled
execution tests in this document remain pinned to the repository's 0.83.0 SDK;
no SDK upgrade was made.

Normal `off` retains Pi's existing meaning. Controlled application-mode requests
verify all five unknown-model levels for all three protocols, Responses extended
effort, Anthropic budget/adaptive metadata and DeepSeek compatibility. Those
tests prove serialization, not that a real gateway executes the requested effort.

## Concrete boundary choices

Preferred: upgrade to an unmodified Pi release with a public provider-control
option that independently omits effort/enable/disable/budget controls while
retaining the model's capability metadata, message roles, signed history,
reasoning-content requirements and Responses encrypted-content inclusion.
The same request/replay tests must pass before enabling the mode.

Alternative requiring an explicit ADR-0014 boundary change: adopt a narrowly
scoped public `onPayload` policy after Pi serialization. Keep `reasoning: true`
and its compatibility metadata; retain `include`, message history and tools;
remove only documented control fields. A test-only Responses demonstration in
`provider-thinking-boundary.test.ts` removes `reasoning` after Pi has serialized
the payload. It verifies existing encrypted history, fresh encrypted reasoning,
subsequent replay, developer role and tool result preservation. No production
code uses this hook.

This alternative makes the platform responsible for a versioned per-protocol
control-field allowlist. Chat Completions can use `reasoning_effort`, `reasoning`,
`thinking`, `enable_thinking` or provider-specific `chat_template_kwargs`;
Anthropic uses `thinking` and `output_config.effort`; Responses uses `reasoning`.
Template fields can be supplied by Pi compatibility metadata, so the allowlist
must cover the offered profiles explicitly and reject unsupported profiles.
It must preserve unrelated output configuration, history and response inclusion.
Calling the hook public does not remove that protocol ownership or the required
review. The Responses demonstration establishes feasibility of that specific
proposal, not complete coverage of every catalog compatibility profile.

After either choice is implemented, verify all offered protocol profiles with
history and tool round trips, persist/reload mode per model, preserve Agent and
Session preferences, and complete the #228/#229 controlled upgrade acceptance
before deployment. The current changes do not migrate a running production
fleet or silently turn on this incomplete fallback.
