# Model provider production release — 2026-09-24

## Source and artifacts

Branch `codex/custom-model-providers` was rebased onto `origin/main` at
`0d3a1fd` (API/Runner split) and pushed. The release includes tenant provider
configuration, endpoint model discovery, Pi inference probes, encrypted storage,
and loading saved providers in the separate Runner.

Images were built and pushed on `vfs-dev` from the isolated worktree
`/tmp/oma-model-providers-80d8694`. The shared checkout was preserved.

| Workload | Source commit / image tag | Deployed digest |
| --- | --- | --- |
| API and Runner | `29201d1c28f9` | `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:2e766b60d27aa8bf855090d633e1bb8241b41f39ce0ebae5f629126c12f63483` |
| Web | `80d8694c9d04` | `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web@sha256:5c3effa58533e762888954d6df51b3a758236c6b1b3dec598643e2ba860fd015` |

The final server-only commit prevents the provider encryption key from being
inherited by adapter subprocesses. It does not change the Web artifact.

## Deployment

- Target: production `oma-infra`, using explicit kubeconfig
  `~/.kube/agent-platform-config`.
- Applied additive migration `deploy/migrations/0016_model_providers.sql` and
  verified application-role SELECT/INSERT/UPDATE/DELETE privileges.
- Created the stable `OMA_PROVIDER_ENCRYPTION_KEY` entry in `oma-secrets`.
  API and Runner both reference that same required Secret key. Its value was
  never logged. Keep it stable to decrypt stored provider credentials.
- Updated `oma-api`, `oma-runner`, and `oma-web` using narrowly scoped JSON
  patches with old-image guards, after server-side dry runs. Preserved the
  existing split deployment configuration and Service routing. The legacy
  `oma-server` deployment was not used.
- The user explicitly authorized rolling Runner immediately and allowing
  interruption of its existing Turn. No idle wait was required afterward.
- All three rollouts completed; each deployment has one ready and available
  replica with the digest above.

## Validation

Before deployment, adapter and server type checks passed, as did the Web build
and OpenAPI/deployment contract checks. Relevant suites included 277 Pi adapter
tests, 455 API tests (11 opt-in skipped), 155 store tests (28 external skipped),
and 420 Web tests. Following the final server-only change, API type checking and
46 focused subprocess-environment/provider tests passed.

Post-deployment acceptance used a temporary isolated tenant through the public
API at `https://agentry.welltop.tech/api`, using the existing managed BigModel
credential only in process memory:

1. Provider protocol routes responded successfully.
2. The actual BigModel Coding endpoint returned 11 models, including `glm-5.3`.
3. The API's Pi inference probe succeeded and issued a verification token.
4. Saving the verified provider succeeded. Its database configuration contained
   encrypted credentials and no plaintext upstream key.
5. A second tenant could neither list nor delete that provider.
6. Subsequent discovery with an empty key reused and decrypted the saved key.
7. Created an Agent using the saved custom provider and a Session, then sent a
   user message through the public API. The separate Runner loaded/decrypted
   the provider and emitted a successful `OK` response and
   `session.turn_completed`.
8. Removed the temporary Session, Agent and provider, and revoked both temporary
   API keys.

Public `/api/health` and `/api/ready` returned 200; readiness identified the API
role. `/model-providers` and its new `/assets/index-BZMYuw9j.js` asset returned
200. The unauthenticated provider-list request returned 401 as expected.

This release acceptance covers the deployed API-to-Runner path with BigModel.
Broader configured-provider results, rate limits, and the Google proxy-only
probe are recorded in [the live provider report](model-providers-live-2026-09-23.md).
The form currently supports OpenAI Chat Completions, OpenAI Responses and
Anthropic Messages; this release does not add the Google native protocol or
change production proxy settings.
