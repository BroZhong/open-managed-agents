# Opus five-level Adaptive effort — 2026-10-12

## Result

Users can select and save an explicit **Anthropic Adaptive · 五档** thinking
profile for an Anthropic Messages model. Agent and Session capabilities expose
exactly `low`, `medium`, `high`, `xhigh`, `max`; automatic selects `max`.
The supplied Opus model is configured with this profile, and Session
`sess_zgC2jVcwIHEss3IzuY7kH` is explicitly set to `max`.

The profile uses public Pi model metadata:

```json
{
  "compat": {"forceAdaptiveThinking": true, "supportsTemperature": false},
  "thinkingLevelMap": {
    "off": null, "minimal": null,
    "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": "max"
  }
}
```

Pi owns supported-level queries, clamping and request serialization. New requests
use `thinking.type: adaptive` and the selected `output_config.effort`, including
`max`. No SDK package was modified and no production payload hook was introduced.
The legacy off/minimal preferences stay persisted and resolve to low through Pi.

## Code and deployment

Implementation commit: `e242b3757770c7028ec16226e2886420fcad692f`, branch
`codex/opus-five-levels`, isolated worktree `/tmp/oma-opus-five-levels`.
It includes the main thread's committed UI changes through `66025e7`; the main
thread's checkout was not edited. Source tree
`4d219191e1580761ae221cf86ea316be9064b5b5` matched the isolated vfs-dev build checkout.
The existing native Sandbox lifecycle and three-hour tool wait code is unchanged.

| Workload | Deployed image digest |
| --- | --- |
| API / Runner | `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:ceb8726f06e6ab74b4f9fce5b817d89bfb31a19613fdf6f65db254be1e185d8b` |
| Web | `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web@sha256:a909ab8d26f62f53ffa763b6bfb53b2e0188999a11048a3a288a16edffb62575` |

Built and published on vfs-dev as `opus-effort-e242b37`. Before image changes,
a new-image Job verified the existing native lifecycle schema and exact five-level
capabilities. There were no active/waiting Sessions or pending inputs when the
rollout started. Applied guarded image patches and waited for API/Runner readiness
before publishing the Web entry point and saving the profile. All workloads have
one ready replica and public API readiness is healthy. No schema migration was
required. Restricted local deployment/provider snapshots were retained for rollback.

## Acceptance

- Controlled native SDK tests verify that each of the five levels emits its same
  effort string, preserves the upstream model ID and emits no fixed token budget.
- Public HTTP tests cover profile preview, configuration-bound proof, save/reload,
  profile clearing and rejection on the other protocols.
- A controlled full API/SessionRouter/Pi workflow verifies all five Session
  overrides, automatic max, and legacy off-to-low adaptation in actual request
  bodies. Seven Turns complete without errors.
- Web tests verify selecting the profile, previewing five levels, requiring the
  existing test before save, and preserving the upstream model ID and saved key.
- Live requests through the actual saved provider succeeded for **all five levels**.
  A read-only public observer confirmed `thinking.type: adaptive` and
  `output_config.effort` equal to low, medium, high, xhigh, max respectively.
- Saved the profile via the deployed test/save API, keeping the existing model ID,
  endpoint and key. Reloaded metadata confirms the saved profile and five choices.
- Set the target Session to max. An isolated fresh Session completed a real Runner
  Turn with durable native thinking level `max`, returned `OPUS_MAX_OK`, and made
  no tool calls.
- Authenticated UI verified the five slider stops (低、中、高、很高、最大); switching
  through them and reloading retained the selected maximum. The target remains max.

The gateway's successful responses establish parameter acceptance, not independent
proof of how much internal reasoning it performs. The user's business Session
received no test messages; real Turn testing used a separate fixture. The fixture
Agent was deleted, Session terminated/hidden and Workspace hidden. Cleanup was
confirmed complete with no pending input or Sandbox binding. The preflight Job
was removed.

See [sanitized live evidence](opus-adaptive-profile-2026-10-12.json).

## Checks

- Adapter: 484 tests passed; typecheck passed.
- Server: 1,033 tests passed; 37 opt-in infrastructure tests skipped; API typecheck
  passed. OpenAPI was regenerated and the initially stale artifact assertion was
  rerun successfully with the full API suite (490 tests).
- Web: 483 tests passed; typecheck, build and changed-file lint passed.
- CLI: 27 tests passed.
- Contract/deployment scripts: 71 passed, one optional package test skipped.
- OpenAPI validation and `git diff --check` passed. Review checked profile
  precedence, protocol rejection, credential/model preservation and native-only
  serialization; no subagents were used in this side conversation.

For rollback, restore the previous Provider configuration before reverting the
Runner: an older Runner cannot interpret `thinkingProfile`. Do not overwrite
concurrent user changes; reconcile the saved snapshot against current configuration.
