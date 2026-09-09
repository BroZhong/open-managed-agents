# Deployment

The production deployment runs on the Alibaba Cloud `agent-platform` ACS
cluster in `cn-shanghai`. This document and the manifests in this directory are
the current deployment reference. Dated E2E reports under `docs/` describe their
original runs and must not be used as current runbooks.

## Topology

| Scope | Namespace | Resources |
| --- | --- | --- |
| OMA application | `oma-infra` | `oma-server`, `oma-web`, their Services, and the `oma-console` ALB Ingress |
| Application dependencies | `oma-infra` | Redis and sing-box; provisioned separately from `deploy/k8s.yaml` |
| Agent sandboxes | `sandbox-system` | ACK sandbox manager/gateway; default `auto-story` and optional `code-interpreter` / `code-interpreter-vfscli` SandboxSets |

The public console and API share `https://agentry.welltop.tech`. The ALB sends
`/api/*` to `oma-server` and all other paths to `oma-web`. The Server therefore
runs with `API_BASE_PATH=/api`, and its readiness endpoint is `/api/health`.

The application images are stored in the Shanghai `welltop` ACR. Pods pull
through the VPC endpoint with the `ali-shanghai` image-pull Secret. The active
sandbox default is `auto-story`, whose immutable image digest is declared in
`sandbox/sandboxset-auto-story.yaml`. It includes VFS CLI, FFmpeg, Gemini's
Python SDK, MediaKit and native `rg`/`fd` search, without OpenMontage or Whisper.
The other pools remain available through explicit Agent `sandbox.image` values.

## Image pipeline

Build and publish images on `vfs-dev`. The application Dockerfiles start from
these pinned bases in the Shanghai ACR:

| Consumer | Base image |
| --- | --- |
| Server and Web build stage | `welltop/node-base:22-slim-pnpm-10.12.4` |
| Web runtime | `welltop/nginx-base:1.27-alpine` |
| Default `auto-story` sandbox | Clean Shanghai ACS `code-interpreter` image, pinned in `sandbox/auto-story/versions.json` |
| Optional custom sandbox | `welltop/sandbox-base:code-interpreter-v1.6` |

Prepare or refresh the bases from the `vfs-dev` checkout:

```bash
ssh vfs-dev \
  'cd ~/workspace/yuzhong/open-managed-agents && deploy/scripts/build-base-images.sh --push'
```

Existing tags are skipped. Add `--force` only when intentionally rebuilding a
base tag. The script accepts `node`, `nginx`, or `sandbox` to process a subset.

A normal application release starts from a clean, committed checkout:

```bash
ssh vfs-dev \
  'cd ~/workspace/yuzhong/open-managed-agents && bash build.sh --push server web'
```

The default image tag is the current 12-character Git SHA. Local caches under
`.buildx-cache/` keep dependency layers warm across builds. The Web image uses
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

This produces `oma-sandbox:auto-story-<tag>`. The standalone recipe defaults to
its versioned release tag; see [sandbox/auto-story/README.md](sandbox/auto-story/README.md)
for preparation, version pins and image checks. `AUTO_STORY_BASE_IMAGE` can
override the clean base for this wrapper; it must satisfy the recipe's checks.

The optional custom sandbox additionally needs a Linux AMD64 `vfs-cli` binary:

```bash
ssh vfs-dev \
  'cd ~/workspace/yuzhong/open-managed-agents && \
   VFS_CLI_SRC=/path/to/vfs-cli deploy/scripts/build-images.sh --push --tag <tag> \
     --sandbox-template code-interpreter-vfscli sandbox'
```

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
# Default auto-story pool: dry-run only
deploy/scripts/deploy-sandbox.sh
deploy/scripts/deploy-sandbox.sh --image <immutable-image> --apply --confirm-production

# Optional stock and custom pools
deploy/scripts/deploy-sandbox.sh --pool stock
deploy/scripts/deploy-sandbox.sh --pool custom --image <immutable-image>
deploy/scripts/deploy-sandbox.sh --pool custom --image <immutable-image> \
  --apply --confirm-production
```

Pool deployment does not change the Server's `SANDBOX_TEMPLATE` setting.
The ConfigMap and the SDK fallback default to `auto-story`; explicit Agent
template selection still takes precedence. Existing Session sandboxes need a
rebuild or a new Session to pick up a changed image or template.

## What the repository owns

`k8s.yaml` declares the application ConfigMap, Server/Web Deployments and
Services, and the public Ingress. It intentionally does not create Redis,
sing-box, RDS, Supabase Storage, the ALB controller, or the ACK sandbox-manager
installation.

`OMA_SERVER_IMAGE` and `OMA_WEB_IMAGE` in the manifest are release-time
placeholders rendered by `deploy/scripts/deploy-app.sh`. Do not apply the raw
manifest or commit credentials or rendered manifests.

Production uses `PG_ENSURE_SCHEMA=false`; apply the idempotent SQL files in
`migrations/` with a privileged database operator before rolling out code that
depends on a new migration.

## Cluster access and verification

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
KUBECONFIG=~/.kube/agent-platform-config kubectl -n sandbox-system get sandboxset auto-story
```

The `code-interpreter` and `code-interpreter-vfscli` pools are independent
options. The default build and deploy commands above target `auto-story`.
