# Model thinking production release — 2026-10-12

## Source and production baseline

The user authorized production deployment and verification against
`sess_zgC2jVcwIHEss3IzuY7kH`, then explicitly required merging
`codex/native-sandbox-lifecycle` into main before rebasing this work.

- Remote main was fast-forwarded from `1a964e4` to `8c39497`; the local main
  checkout was also fast-forwarded, preserving its unrelated untracked files.
- `codex/model-thinking-225-229` was rebased onto that updated main.
- Released source: `22f9beb6a92d918c29a0700b86aceb58e8c54e3a`.
- Source tree: `40bb6140d87b8a4371d18c350006058228a37622`, checked equal in the
  isolated `vfs-dev` build checkout `/tmp/oma-thinking-22f9beb`.
- API, Sandbox manager and native tool source hashes in the deployed Runner
  matched the checkout. ADR-0019's finite lifecycle and the three-hour Host tool
  wait ceiling are retained; no old idle scanner or never-timeout policy returned.

| Workload | Immutable production image |
| --- | --- |
| API and Runner | `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:b9ffc5ea625998945a8b54d570eb0a2499b5fb38324f34bb85f130e967815a04` |
| Web | `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web@sha256:4ac0f377ea155f749a8985d4482642566a359c0634e6097d10f6cdf111fb1687` |

## Initial failed attempt and recovery

The first attempt used the GitHub main baseline without including the separately
released native-lifecycle branch. Its Runner still expected the obsolete
`invalidate_sandbox_idle()` function, and failed startup on the already-migrated
production database. This was a release-baseline error, not missing production
lifecycle prerequisites. Two attempts to apply obsolete migrations 0014/0018
were rejected at their transaction command by the SQL RPC; subsequent catalog
checks confirmed neither the old function, activity table nor trigger was created.

Before proceeding, restored all three original images and five Provider records.
Provider restoration used compare-and-swap against the expected migrated JSON;
all five restored with zero conflicts. API, Runner and Web returned healthy.
The original Server digest was `6d428258be77b5c173a76b673f5b82bebaef173209de726dc44847fe0fc9553b`;
the original Web digest was `ef373d2de948e41c16b3f58b151423c4479b16b87cf75e9423bd76638feb4487`.

The corrected release used the merged/rebased native baseline. An isolated
new-image preflight successfully ran the native lifecycle `assertReady`, the
Provider migration dry-run, and the target Opus capability resolver before
production cutover. No lifecycle DDL was applied during the corrected release.

## Cutover and migration

- Target: `agent-platform`, `oma-infra`, explicit `agent-platform-config` kubeconfig.
- Images were built on `vfs-dev` and published under `thinking-22f9beb`.
- Saved restricted local rollback snapshots of Deployments, encrypted Provider
  configurations and the existing Provider encryption key; no credentials entered
  source, logs or this report.
- Temporarily paused API ingress, waited for zero queued inputs and running/waiting
  Sessions, then stopped the old Runner. Existing Turns settled naturally.
- Used old-image-guarded patches, after server-side dry runs, for API/Runner/Web.
- Provider migration: five records upgraded, zero conflicts. A repeated apply
  reported zero candidates and zero updates. Compared all five resulting records
  against the exact intended migration: identities, endpoints, protocols, encrypted
  credentials and test timestamps were preserved.
- All three workloads reached one ready replica. Public `/api/ready` returned
  `{"status":"ok","role":"api"}`.
- Database retained `oma.lock_sandbox_binding()` and its single input-coordination
  trigger. Obsolete `sandbox_activities` and `invalidate_sandbox_idle()` stayed absent.

## Opus acceptance

The target uses Tenant-owned `global.anthropic.claude-opus-5-5` over
`anthropic-messages`. This ID has no exact entry in the pinned Pi catalog.
No alternative model reference was selected. Its native basic levels are
`off`, `minimal`, `low`, `medium`, `high`, with automatic default `high`.

1. Authenticated browser verification on the supplied Session changed the slider
   to low and high; both survived reload. Reset restored the original null override
   (inherit Agent). Agent preference was unchanged, and no prompt or tool execution
   was added to the supplied Session.
2. The Agent-before-Session endpoint and the target Session capability endpoint
   returned equal options.
3. Created an isolated temporary Agent and Session using the same saved provider
   and actual model ID. The deployed Runner completed low and high Turns,
   returning the requested `OK_LOW` and `OK_HIGH`, with no error or tool call.
4. Independent live native SDK calls used the same saved provider. A read-only
   public `onPayload` observer confirmed `thinking.type: enabled` with
   `budget_tokens: 2048` for low and `16384` for high. Both upstream responses
   completed successfully. This observer did not alter requests and is not a
   production payload workaround.
5. Pi's initial `thinking_level_change` journal entry is not a per-Turn audit:
   restoring a Session with an explicit new level need not append another such
   entry. The high check therefore verifies persisted preference and Turn success,
   while the native request observer verifies serialization. Budget probes use an
   adequate output cap so SDK token-cap adjustment does not collapse the budgets.

These checks establish configuration persistence, deployed execution, serialized
parameters and gateway acceptance. They do not prove the upstream internally
spent a particular reasoning budget. Provider-controlled mode remains intentionally
unsupported under the user's native-SDK-only decision.

## Checks and cleanup

After rebasing: 483 Adapter tests and 1,031 server tests passed, with 37 opt-in
infrastructure tests skipped. Adapter/API typechecks and OpenAPI/contract checks
passed. Web source was unchanged by the rebase; its prior 478-test suite and build
remain applicable, and the production browser checks above exercised the new bundle.

The temporary Agent was deleted; its Session was terminated and hidden, its
Workspace hidden. Final audit confirmed zero queued input, no Sandbox binding,
completed cleanup and no remaining test Agent. The Session history remains as
an audit record. Temporary migration/preflight Jobs and the maintenance Pod were
removed. Restricted rollback snapshots remain local.

See [sanitized acceptance evidence](model-thinking-production-2026-10-12.json).
