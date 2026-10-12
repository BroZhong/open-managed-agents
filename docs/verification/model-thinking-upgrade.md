# Model thinking capabilities: implementation and upgrade

Scope: #225–#229, verified locally on 2026-10-12. This is a code and controlled
verification delivery, not a production rollout.

## Release state

#225's shared Agent/Session capability resolver, #226's new BYOK defaults and
#227's built-in Pi references are implemented. #229 supplies an explicit,
repeatable data migration and controlled upgrade coverage. **Do not enable these
new defaults in production yet.** The mandatory #228 fallback is blocked by the
unmodified Pi 0.83.0 Responses integration. Its public omission controls cannot
retain collection of newly produced encrypted reasoning history. See
[request evidence and boundary proposal](byok-provider-thinking-boundary.md).
The API rejects provider-controlled mode rather than pretending it works.

This means #228 and the release/fallback portions of #229 remain incomplete.
The code can be reviewed and exercised in isolated environments now. A successful
gateway response does not establish that a requested effort was honored or that
#228's history-preservation requirement is satisfied.

## Data behavior

The existing `model_providers.config` JSONB column accommodates the additive
metadata; no DDL or credential re-encryption is needed. New models store
`capabilityVersion: 1` with `reasoningSource`. A manual reference is stored as
`capabilityReference: {provider, modelId}`. Its model ID is separate from the
actual upstream `id`.

Legacy models with neither provenance nor manual settings are marked
`reasoningSource: "legacy"`, `capabilityVersion: 1`, and `reasoning: true`.
This boolean is the unknown-model fallback, not a frozen catalog verdict:
current Pi exact matches or preserved `catalogProvider` references still resolve
known non-reasoning models to off. Old true, old false and existing catalog
associations all use the current resolver. No upstream model-list refresh is
required. Source-unknown legacy false is intentionally **not** treated as an
explicit upstream rejection.

Records carrying a semantic version, known provenance, manual reference or mode
are preserved. The migration does not touch provider identity, protocol, URL,
ciphertext, test timestamp, model IDs, Agent/Session references or saved thinking
preferences. It also never rewrites historical Turns or execution checkpoints.
Existing manual false values may begin sending thinking controls because their
original intent cannot be recovered; communicate that behavior before rollout.

## Upgrade and rollback

After #228 is resolved and independently verified:

1. Back up provider configuration and the existing encryption key using the
   deployment's normal secure backup procedure. Keep Agent/Session writes and
   Runner intake drained during the version transition.
2. Run the migration in dry-run mode against the explicitly selected database:

   ```sh
   pnpm --dir server --filter @oma-server/api exec tsx src/migrate-model-providers.ts
   ```

3. Deploy matching API and Runner builds with the same Pi SDK/catalog. Keep
   intake paused until both roles are on the new build, then apply:

   ```sh
   pnpm --dir server --filter @oma-server/api exec tsx src/migrate-model-providers.ts --apply
   ```

4. Inspect `scanned`, `candidates`, `updated`, and `conflicts`. The script processes
   bounded pages and compares the original JSON before each update. Concurrent
   edits are not overwritten. Exit code 2 reports conflicts; rerun after writers
   settle. A process failure can leave completed rows upgraded; rerunning skips
   them and resumes the remaining work. A second successful apply changes zero
   rows. Do not treat the operation as an all-record transaction.
5. Deploy the matching Web build, refresh already-open browser tabs, verify
   capability queries, explicit test/save, inheritance, reference clearing and
   the completed provider fallback, then resume intake.

New readers can interpret unmigrated legacy JSON, so code-before-data is
supported while intake is paused; migration persists that interpretation.
Mixed old/new API and Runner fleets are not supported: their effective default
levels differ. Old Web clients are also unsupported after cutover because they
cannot preserve the new metadata on edit. The migration is not an activation
switch: deploying the new resolver already changes future Turn behavior.

If errors appear before intake resumes, keep intake paused and roll back API,
Runner and Web together. An old Runner interprets the migrated `reasoning: true`
literally and ignores references; restoring only old code is unsafe. Restore the
provider configuration backup as part of that rollback. If users have edited
providers after cutover, reconcile those records individually while preserving
their current encrypted key; do not overwrite them with a blanket snapshot.
Never erase Agent/Session preferences to undo a capability change.

## Controlled verification boundaries

- Public HTTP capability APIs work before Agent creation, honor Tenant ownership,
  protect shared access and surface retryable failures without credentials.
- The full HTTP workflow discovers unknown and explicitly unsupported models,
  performs the existing user-triggered Pi tests, saves/reloads, creates Agent and
  Session, and checks actual Pi requests across inheritance, overrides and model
  switching. No inference occurs during capability lookup or save.
- Adapter tests inspect native requests for the three protocols, basic and
  extended levels, manual references, unchanged upstream IDs, Anthropic budgets
  and adaptive configuration, and sanitized parameter rejection. These inspect
  serialization; they do not prove a real gateway executed a particular effort.
- Store tests use the repository's PostgreSQL store with pg-mem to check dry-run,
  persisted reload, repeated application and preservation of ciphertext and
  settings. API upgrade tests resolve migrated fixtures through current Pi
  metadata without discovery, inference or decrypting the stored key.
- Web tests cover model changes, capability retries, inherited and adapted
  preferences, explicit recommendation confirmation, reference reload/clearing,
  and invalidation after provider edits.

No production data or live model service is needed for this validation. The
opt-in live PostgreSQL/Redis, OSS, Sandbox and upstream inference suites remain
separate from these local checks.

## Local check results

- Adapter full suite: 39 files, 478 tests passed. A partial-stream error leakage
  regression found during verification was fixed before the final full run.
- Server suites: 1,019 tests passed; 39 opt-in infrastructure tests
  skipped. Live PostgreSQL, split-process PG/Redis and live inference opt-ins were
  not enabled.
- Web full suite: 58 files, 478 tests passed. Production build and focused lint
  passed; the existing large-bundle advisory remains.
- CLI full suite: 27 tests passed; typecheck passed.
- API contract/deployment script tests: 71 passed, one opt-in package check skipped.
- Adapter and API typechecks passed. OpenAPI generation/check passed with the
  existing four informational lint warnings. `git diff --check` passed.

Commands used for the full local checks:

```sh
pnpm --dir adapter test --maxWorkers=2
env -u PG_TEST_URL -u SPLIT_TEST_PG_URL -u SPLIT_TEST_REDIS_URL -u RUN_LIVE_SUPABASE_LOOP_E2E pnpm --dir server --workspace-concurrency=1 -r test --maxWorkers=2
pnpm --dir web test --maxWorkers=2
npm --prefix cli test
node --test .github/scripts/apifox-*.test.mjs deploy/*.test.mjs
pnpm --dir adapter typecheck
pnpm --dir server typecheck
npm --prefix cli run typecheck
pnpm --dir web build
pnpm --dir server openapi:check
```

## Review outcome

The independent Standards review found no actionable violations. The Spec review
identified two issues: a native HTTP-200 streaming thinking rejection lost its
specific safe diagnostic, and new capability references imported unrelated catalog
prices. Both were fixed and independently rechecked. Regression tests cover the
native stream, the HTTP connection-test endpoint, credential redaction, and usage
costs. No actionable findings remain from either review; #228's explicit boundary
blocker and the dependent release acceptance remain outstanding.
