# Deployment

The production deployment runs on the Alibaba Cloud `agent-platform` ACS
cluster in `cn-shanghai`. This document and the manifests in this directory are
the current deployment reference. Dated E2E reports under `docs/` describe their
original runs and must not be used as current runbooks.

Controlled Sandbox idle reclamation has a separate
[rollout, adoption and rollback procedure](../docs/sandbox-lifecycle-deployment.md).
Migration 0014 and explicit Session-binding selection are required; the manifests
do not enable the new policy globally.
The [2026-09-23 production canary report](../docs/verification/sandbox-lifecycle-release-2026-09-23.md)
records the deployed image, selected bindings, live model compatibility fix and
real-time acceptance evidence.

## Topology

| Scope | Namespace | Resources |
| --- | --- | --- |
| OMA application | `oma-infra` | `oma-server`, `oma-web`, their Services, and the `oma-console` ALB Ingress |
| Application dependencies | `oma-infra` | Redis and sing-box; provisioned separately from `deploy/k8s.yaml` |
| Agent sandboxes | `sandbox-system` | ACK sandbox manager/gateway; sole maintained `auto-story-v2` SandboxSet |

The public console and API share `https://agentry.welltop.tech`. The ALB sends
`/api/*` to `oma-server` and all other paths to `oma-web`. The Server therefore
runs with `API_BASE_PATH=/api`, and its readiness endpoint is `/api/health`.
Use `https://agentry.welltop.tech/api` as the API base URL; `/v1/*` examples are
relative to it. The deployed OpenAPI document is available at
`https://agentry.welltop.tech/api/openapi.json`.

Check the health response body as well as the HTTP status:

```bash
curl -fsS https://agentry.welltop.tech/api/health | jq -e 'select(.status == "ok")'
```

Without `/api`, `/health` and `/openapi.json` are served by the console and may
return `200` HTML. That response does not confirm API health or contain an API
schema.

The application images are stored in the Shanghai `welltop` ACR. Pods pull
through the VPC endpoint with the `ali-shanghai` image-pull Secret. The active
sandbox default is `auto-story-v2`, whose immutable image digest is declared in
[`sandbox/auto-story-v2/sandboxset.yaml`](../sandbox/auto-story-v2/sandboxset.yaml). It includes VFS CLI, FFmpeg, Gemini's
Python SDK, MediaKit and native `rg`/`fd` search, without OpenMontage or Whisper.
This is the only pool maintained or shipped by this repository.

## Image pipeline

Build and publish images on `vfs-dev`. The application Dockerfiles start from
these pinned bases in the Shanghai ACR:

| Consumer | Base image |
| --- | --- |
| Server and Web build stage | `welltop/node-base:22-slim-pnpm-10.12.4` |
| Web runtime | `welltop/nginx-base:1.27-alpine` |
| Default `auto-story-v2` sandbox | Clean Shanghai ACS `code-interpreter` image, pinned in `sandbox/auto-story-v2/versions.json` |

Prepare or refresh the bases from the `vfs-dev` checkout:

```bash
ssh vfs-dev \
  'cd ~/workspace/yuzhong/open-managed-agents && deploy/scripts/build-base-images.sh --push'
```

Existing tags are skipped. Add `--force` only when intentionally rebuilding a
base tag. The script accepts `node` or `nginx` to process a subset.

A normal application release starts from a clean, committed checkout:

```bash
ssh vfs-dev \
  'cd ~/workspace/yuzhong/open-managed-agents && bash build.sh --push server web'
```

The default image tag is the current 12-character Git SHA. Local caches under
`.buildx-cache/` keep dependency layers warm across builds. BuildKit also keeps
architecture-specific pnpm stores and npm download caches on the selected
builder. Reuse that builder between releases; deleting it or pruning its cache
requires downloading dependencies again. Cache mounts survive failed installs,
but are not included in the published runtime image or the local layer export.

Web source edits reuse the manifest-only install layer. Server dependencies,
adapter dependencies, and Pi extensions are separate stages, so a Server-only
dependency change does not reinstall Pi extensions. Extensions install in
separate cached steps and prefer already downloaded packages. Check the build
output for `CACHED`; a second unchanged build should perform no installations.
ACR builds disable provenance attestations because this registry rejects the
BuildKit attestation manifest format.

The Web image uses
the same-origin `/api` endpoint by default; override it with `WEB_API_URL` only
when building for a different ingress layout.

Build the default sandbox with the same release entrypoint. Its recipe fetches
checksum-verified upstream releases, builds FFmpeg, and runs offline image
acceptance before pushing:

```bash
ssh vfs-dev \
  'cd ~/workspace/yuzhong/open-managed-agents && \
   deploy/scripts/build-images.sh --push --tag <tag> sandbox'
```

This produces `oma-sandbox:auto-story-v2-<tag>`. The standalone recipe defaults to
its versioned release tag; see [the sandbox recipe](../sandbox/auto-story-v2/README.md)
for preparation, version pins and image checks. `AUTO_STORY_BASE_IMAGE` can
override the clean base for this wrapper; it must satisfy the recipe's checks.

Both build scripts support `--dry-run`. A dirty checkout is rejected unless
`--allow-dirty` is explicit; auto-tagged dirty builds include a UTC timestamp so
they cannot be mistaken for the commit image.

## Deployment scripts

Validate a newly published application release against `agent-platform`:

```bash
deploy/scripts/deploy-app.sh --tag <tag>
```

This performs a server-side dry-run by default. Production mutation requires
both flags deliberately:

```bash
deploy/scripts/deploy-app.sh --tag <tag> --apply --confirm-production
```

The script always renders the image placeholders into a temporary manifest and
validates the complete resource set. Its apply path then patches only the two
Deployment image fields, waits for both rollouts, prints the running images,
and checks `/api/health`. Routine releases therefore cannot accidentally
rewrite the ConfigMap, Services, or Ingress. The rendered manifest is deleted
on exit and is never committed.

SandboxSet validation and deployment use the same safety gate:

```bash
# Default auto-story-v2 pool: dry-run only
deploy/scripts/deploy-sandbox.sh
deploy/scripts/deploy-sandbox.sh --image <immutable-image> --apply --confirm-production

```

Pool deployment does not change the Server's `SANDBOX_TEMPLATE` setting.
The ConfigMap and the SDK fallback default to `auto-story-v2`; explicit Agent
template selection still takes precedence. Existing Session sandboxes need a
rebuild or a new Session to pick up a changed image or template.

## What the repository owns

`k8s.yaml` declares the application ConfigMap, Server/Web Deployments and
Services, and the public Ingress. It intentionally does not create Redis,
sing-box, RDS, Workspace OSS, Skill Supabase Storage, the ALB controller, or the
ACK sandbox-manager installation.

`OMA_SERVER_IMAGE` and `OMA_WEB_IMAGE` in the manifest are release-time
placeholders rendered by `deploy/scripts/deploy-app.sh`. Do not apply the raw
manifest or commit credentials or rendered manifests.

Production uses `PG_ENSURE_SCHEMA=false`; apply the idempotent SQL files in
`migrations/` with a privileged database operator before rolling out code that
depends on a new migration.

## Cluster access and verification

### Durable delegation release (#133–#141)

See [the production verification report](../docs/verification/durable-delegation-release-2026-09-16.md) and `scripts/verify-durable-delegations.mjs` for the real Pi/Sandbox release checks.

Apply `migrations/0012_durable_delegations.sql` before the Host image. Verify
the application role can read all six `delegation_*` tables and the new
Session/pending-input columns. Update the `server` container image. Production
loads settings and extensions from `/opt/pi-agent-seed` in that image; the
`oma-pi-gateway` Secret mounts `auth.json` and `models.json` there read-only.
There is no seed init container or writable Pi configuration volume.

For the first cutover, stop ingress to the old Host and stop its scheduler;
wait for its active Turns to drain before starting the new image. The release
must not mix the plugin and Host-owned tools. The old implementation's in-memory
child identifiers cannot be migrated. Existing tool summaries remain readable;
queries using those expired identifiers explicitly fail.

New deployments register only `Agent`, `get_subagent_result`, and
`steer_subagent`. `run_in_background` defaults to false for both creation and
resume. `SUBAGENT_MAX_CONCURRENT` defaults to 4 per parent Session and
`SUBAGENT_MAX_MODEL_STEPS` defaults to 500 (maximum 1000). These count concurrent
child Turns and model steps respectively; waiting parents consume no child slot.
The Host assigns its configured budget to each new or resumed execution; the
Agent tool accepts no budget override. Exhaustion returns `budget_exhausted`;
only an explicit resume starts a fresh budget. The live verification script’s
`budget` phase requires a dedicated verification Host configured with
`SUBAGENT_MAX_MODEL_STEPS=1`, also set in the script environment.

Monitor `delegation_executions.record` for `status`, `notificationStatus`,
`pendingEventId`, and the effective model configuration. `queued` inputs use the
ordinary pending-input recovery scan; `running` records are fenced by that
input's owner and generation. An expired child lease becomes
`recovery_required`, never successful partial commentary. Inspect its complete
tool history and external task identifiers before an explicit resume. Saved
Workspace files remain available independently of that status.

`delegation_waits` identifies the original parent Turn and tool call. Its
checkpoint plus complete events lets a replacement Host continue that same
Turn; a non-wait tool with an uncertain outcome is reported and not replayed.
`subagent.result` is a visible result notification. Only
`subagent.result_claimed` enters the model's history. An accepted Interrupt is
reported as `requested`; the canonical aborted Turn confirms actual stopping.

After release, validate health and authenticated API reads, then exercise a
synchronous child, an asynchronous child that finishes after its parent,
result wakeup, cross-Host resume, steer, Interrupt, full execution traces and
usage. Check failure and budget-exhaustion results separately from file saves.

### Shared native sandbox credentials

The Host reads `sandbox-system/base-secret` at startup and supplies its valid
environment-variable keys to E2B `Sandbox.create({ envs })` for every Agent,
including newly created Agents. A SandboxSet's Kubernetes `env` alone does not
populate the E2B command environment. No shell profile or `ACS_SYNC_ENVS` bridge
is used by this integration.

The existing Secret is the source; no cross-namespace copy is maintained.
`source.env` and other file-like keys are excluded. Values remain in Host memory
and E2B's runtime environment, never in Agent records or Host `process.env`.
The dedicated Host ServiceAccount can only `get` this one Secret:

```bash
kubectl --kubeconfig ~/.kube/agent-platform-config apply -f deploy/sandbox-base-secret-rbac.yaml
```

The application manifest sets `serviceAccountName: oma-server` and the complete
`SANDBOX_BASE_SECRET_NAMESPACE` / `SANDBOX_BASE_SECRET_NAME` pair. A configured
but unavailable Secret prevents startup; omission of both settings disables the
integration for local development. HTTPS requests use the ServiceAccount CA and
bypass the outbound LLM proxy.

For an existing deployment, patch these two ConfigMap keys and the Deployment's
ServiceAccount together with the updated Server image; routine image-only
releases do not update those fields. Do not apply the full application manifest
just to enable credentials, because unrelated live configuration may differ.

Precedence remains explicit: legacy deployment defaults < base Secret < Agent
`sandbox.env` < explicitly scoped WW values < fixed Workspace environment. The
existing `oma-auto-story-env` only supplements keys absent from the base Secret,
so old preset copies cannot override a rotated shared credential. Without a
base Secret, the legacy preset retains its original behavior. Values explicitly
configured on an Agent still override shared defaults.

After Secret rotation, roll the Host. Its next Turn creates a new sandbox for an
existing Session using the fresh values; Workspace files stay in OSS. Updating
the Secret does not mutate environments of already running processes. Verify
with E2B `commands.run()` and only emit presence/equality booleans, never values.

Use the dedicated kubeconfig instead of whichever context happens to be the
local default:

```bash
KUBECONFIG=~/.kube/agent-platform-config kubectl get nodes
KUBECONFIG=~/.kube/agent-platform-config kubectl -n oma-infra get deploy,svc,ingress
KUBECONFIG=~/.kube/agent-platform-config kubectl -n sandbox-system get sandboxset
```

After applying a release, verify both application rollouts and the sandbox warm
pool:

```bash
KUBECONFIG=~/.kube/agent-platform-config kubectl -n oma-infra rollout status deploy/oma-server
KUBECONFIG=~/.kube/agent-platform-config kubectl -n oma-infra rollout status deploy/oma-web
KUBECONFIG=~/.kube/agent-platform-config kubectl -n sandbox-system get sandboxset auto-story-v2
```

Only `auto-story-v2` is maintained. Its recipe and SandboxSet manifest live in
[`sandbox/`](../sandbox/README.md). Shared Workspace infrastructure lives in
[`deploy/oss-workspace/`](oss-workspace/README.md). Retired templates and business
Agent presets are not shipped here; supply business Skills through the platform.

The manifest was aligned with the Shanghai deployment on 2026-09-16, including
its direct Pi gateway mounts, internal E2B endpoints, proxy overrides and Host
4 CPU / 8 GiB limits. Secrets are referenced by name only. The existing
`oma-auto-story-env` compatibility injection is still used by three Agents and
is retained until those settings are migrated. Removing repository presets
must not silently remove their deployed credentials.
