# Deployment

The production deployment runs on the Alibaba Cloud `agent-platform` ACS
cluster in `cn-shanghai`. This document and the manifests in this directory are
the current deployment reference. The dated Hong Kong E2E report under `docs/`
is historical and must not be used as a runbook.

## Topology

| Scope | Namespace | Resources |
| --- | --- | --- |
| OMA application | `oma-infra` | `oma-server`, `oma-web`, their Services, and the `oma-console` ALB Ingress |
| Application dependencies | `oma-infra` | Redis and sing-box; provisioned separately from `deploy/k8s.yaml` |
| Agent sandboxes | `sandbox-system` | ACK sandbox manager/gateway and the `code-interpreter` SandboxSet |

The public console and API share `https://agentry.welltop.tech`. The ALB sends
`/api/*` to `oma-server` and all other paths to `oma-web`. The Server therefore
runs with `API_BASE_PATH=/api`, and its readiness endpoint is `/api/health`.

The application images are stored in the Shanghai `welltop` ACR. Pods pull
through the VPC endpoint with the `ali-shanghai` image-pull Secret. The active
sandbox pool uses the stock Shanghai ACS image declared in
`sandbox/sandboxset-code-interpreter.yaml`.

## Image pipeline

Build and publish images on `vfs-dev`. The application Dockerfiles start from
these pinned bases in the Shanghai ACR:

| Consumer | Base image |
| --- | --- |
| Server and Web build stage | `welltop/node-base:22-slim-pnpm-10.12.4` |
| Web runtime | `welltop/nginx-base:1.27-alpine` |
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

The custom sandbox remains opt-in and additionally needs a Linux AMD64
`vfs-cli` binary:

```bash
ssh vfs-dev \
  'cd ~/workspace/yuzhong/open-managed-agents && \
   VFS_CLI_SRC=/path/to/vfs-cli deploy/scripts/build-images.sh --push --tag <tag> sandbox'
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
# Current stock production pool: dry-run only
deploy/scripts/deploy-sandbox.sh --pool stock

# Optional custom pool
deploy/scripts/deploy-sandbox.sh --pool custom --image <immutable-image>
deploy/scripts/deploy-sandbox.sh --pool custom --image <immutable-image> \
  --apply --confirm-production
```

Creating the custom pool does not change the Server's default
`SANDBOX_TEMPLATE=code-interpreter`.

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
KUBECONFIG=~/.kube/agent-platform-config kubectl -n sandbox-system get sandboxset code-interpreter
```

The `code-interpreter-vfscli` directory is retained as an optional custom-image
prototype. It is not part of the current production topology and must not be
treated as the default sandbox deployment.
