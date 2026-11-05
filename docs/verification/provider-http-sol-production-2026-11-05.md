# Public HTTP providers and GPT-6.1 Sol — production, 2026-11-05

Released to `agent-platform/oma-infra` on 2026-11-05, completed around
14:54 Asia/Shanghai. The user authorized production publication and explicitly
required that Runner HPA changes stay out of this release.

## Released source and images

- Source: `265cc8af725a4ea175170610a5fe9eebf128b276`.
- Image tag: `202611051444`, built on `vfs-dev` from a clean isolated clone.
- API and Runner: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:c3747f4a8940b26e66a9a257e7e091b654b2e3d66504946b0bf629d89b02e084`.
- Web: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web@sha256:8bd59a95685fa96b7cfa81ec502bb1701d2e6066eb8b5766c172c103802546b8`.

The release allows public HTTP URLs for custom-provider discovery, connection
tests and execution. Public-address validation, connection-time DNS checks,
endpoint confinement and redirect rejection remain enforced.

The built-in picker also offers `openai-codex/gpt-6.1-sol`, with 500,000-token
context metadata and five distinct thinking efforts through `max`. The existing
default model remains unchanged. Only that new model entry was appended to the
production `oma-pi-gateway` Secret; existing providers and credentials were
compared and preserved.

## HPA exclusion and deployment scope

- Production had no HPA or KEDA ScaledObject before or after the release.
- Runner remains fixed at **5 replicas**, with **5/5 updated and ready** at
  acceptance. API and Web are each **1/1** ready; all three rollouts completed.
- Production Deployment changes were restricted to image fields. Full specs
  were compared against the pre-release snapshots with only those fields
  excluded. Replica counts, resources, environment and rollout strategy match.
- Image builder was unchanged. No migration, Sandbox image, Warm Pool or
  cluster autoscaling resource was applied.
- The untracked `deploy/keda/` directory was absent from the clean build clone.
- `oma-test` already had a separate HPA Runner release. Acceptance therefore
  used isolated temporary API/Web Pods and a temporary Pi Secret, without
  replacing test Deployments or applying the complete test overlay. All existing
  test Deployment specs were compared and remained unchanged. Temporary Pods
  and Secret were removed afterwards.

## Verification

- Local: 62 HTTP-provider/workflow/DNS tests, 33 model/picker tests, API and
  adapter typechecks, Web TypeScript build checks and `git diff --check` passed.
  The published Web production build also passed.
- Isolated image acceptance: API readiness, HTTP URL acceptance, loopback and
  metadata-address rejection, model catalog loading, thinking choices, and
  GPT-6.1 Sol inference returning exactly `OK`.
- Production authenticated public API: the same HTTP acceptance and private
  address rejection checks passed; the model-thinking endpoint returned the
  new model's five choices and automatic `max` setting.
- A discovery probe against the supplied public HTTP gateway used a deliberately
  invalid test key. It reached upstream authentication and returned the expected
  sanitized key-rejection error, rather than the previous URL-validation error.
  This does not validate the user's actual gateway key or model access.
- A new production Runner independently called GPT-6.1 Sol and received `OK`.
  Probe credentials were copied to temporary files and removed after the call;
  mounted OAuth credentials were not modified.
- Public `/api/health` returned `{"status":"ok"}`; the served Web bundle
  contains the GPT-6.1 Sol picker entry.
- Temporary verification API keys were revoked and deleted; verification
  scripts were removed from production Pods. No user Session was created or
  modified by the probes.

## Rollback images

Patch only the corresponding production Deployment image field:

| Deployment / container | Previous image digest |
| --- | --- |
| `oma-api` / `api` | `oma-server@sha256:af4bb67faba4c8df307a21349ca0f4dc5c32a9b75ece8c1bd18908b5006a32bb` |
| `oma-runner` / `runner` | `oma-server@sha256:6d5823b163d3a92d23b4981db92a93ad64dc8dd2e47731aab0ef4df6a8ad015a` |
| `oma-web` / `web` | `oma-web@sha256:a711fe146d3cccc64b3bb11ef3ad2424e316262167257ad6834bf69a296326cd` |

All images use `registry-vpc.cn-shanghai.aliyuncs.com/welltop/`. Preserve the
five Runner replicas and all unrelated configuration. The appended model
catalog entry can remain during an image rollback; do not overwrite the entire
Secret or restore stale OAuth credentials.
