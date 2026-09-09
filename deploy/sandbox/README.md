# Sandbox warm pool

The `agent-platform` ACS cluster in cn-shanghai runs Alibaba ACK managed Agent
Sandbox (OpenKruise Agents, `agents.kruise.io`), which is E2B-protocol
compatible. Sandboxes are served from warm pools declared as `SandboxSet`
resources in the `sandbox-system` namespace.

The default template is `auto-story`. The stock `code-interpreter` and custom
`code-interpreter-vfscli` templates remain available for explicit Agent
selection through `sandbox.image`. An existing Session keeps its sandbox until
it is rebuilt; new sandboxes without an explicit template use `auto-story`.

## The name is the templateID

A `SandboxSet`'s `metadata.name` IS the E2B **templateID**. When a client calls

```ts
Sandbox.create("auto-story")
```

the E2B endpoint hands back a pre-warmed pod from the `auto-story`
SandboxSet. If no SandboxSet exists for a template, `POST /sandboxes` fails with
`400 "Template or Checkpoint not found"` — there is no implicit / on-demand
template. Each manifest defines the corresponding E2B template.

## Manifest

[`sandboxset-auto-story.yaml`](./sandboxset-auto-story.yaml) defines the
default `auto-story` media template for `agentry.welltop.tech` (Shanghai).
It supplies VFS CLI, MediaKit, FFmpeg, Gemini's Python SDK and native `rg`/`fd`
search, with no OpenMontage or Whisper. It accepts per-Agent
environment variables, and loads equipped Skills through the existing Host
projection mechanism. Build and verification instructions are in
[`auto-story/README.md`](./auto-story/README.md).

| Template | CPU / memory | Ephemeral storage request | Selection |
| --- | --- | --- | --- |
| `auto-story` | 2 vCPU / 4Gi | 50Gi | Default |
| `code-interpreter` | 1 vCPU / 1Gi | 30Gi | Explicit `sandbox.image` |
| `code-interpreter-vfscli` | 1 vCPU / 1Gi | 30Gi | Explicit `sandbox.image` |

[`sandboxset-code-interpreter.yaml`](./sandboxset-code-interpreter.yaml) defines
the optional `code-interpreter` pool:

- **image** — the pinned Shanghai ACR digest in its manifest, based on the
  ACS code-interpreter runtime with the native search tools overlay.
- **runtimes** — `csi` (NAS/OSS mounts) + `agent-runtime` (injects the e2b
  `envd` daemon that the E2B protocol talks to).
- **ECI scheduling labels** — the pod template carries
  `alibabacloud.com/acs: "true"`, `compute-class: agent-sandbox`,
  `compute-qos: default`. These are required for ECI / serverless scheduling;
  without them a bare Sandbox pod stays `Pending` with no ECI node assigned.
- **resources** — 1 vCPU / 1Gi memory, 30Gi ephemeral storage.

## Tunables

Only two things are meant to change:

- `spec.replicas` — the warm-pool size (how many pods sit ready).
- the container image digest — to roll a verified release.

No other resource needs editing to resize the pool.

## Apply / verify

```bash
# Default auto-story pool: validate the pinned manifest without changing it.
deploy/scripts/deploy-sandbox.sh
# Apply a verified release and wait for an available replica.
deploy/scripts/deploy-sandbox.sh --image <immutable-image> --apply --confirm-production
KUBECONFIG=~/.kube/agent-platform-config kubectl get sbs -n sandbox-system auto-story
```

`apply` is idempotent. The SandboxSet is ready once `AVAILABLE >= 1`.
Use `--pool stock` or `--pool custom --image <immutable-image>` to manage the
other pools. Pool deployment does not rewrite the Host's template setting.

## Mandatory sandbox (issue #54)

The sandbox is not optional. Every Agent run must execute inside a sandbox and
the server fails loud when it can't provision one.

Server wiring (see `deploy/k8s.yaml`):

- `SANDBOX_ENABLED=true` — in the `oma-server-config` ConfigMap (non-secret).
  This turns on the sandbox-backed `ToolExecutor`.
- `SANDBOX_TEMPLATE=auto-story` — ConfigMap; the E2B templateID, i.e. the
  SandboxSet name above. The E2B client also defaults to `auto-story` when this
  setting is omitted. An explicit Agent `sandbox.image` takes precedence.
- `E2B_DOMAIN` + `E2B_API_KEY` — provided via the `oma-secrets` Secret
  (`secretKeyRef`), **never baked into the image**. Add them alongside the other
  secrets:

  ```bash
  KUBECONFIG=~/.kube/agent-platform-config kubectl -n oma-infra create secret generic oma-secrets \
    --from-literal=E2B_DOMAIN=... \
    --from-literal=E2B_API_KEY=... \
    ...   # plus PG_PASSWORD / REDIS_PASSWORD / SUPABASE_SERVICE_KEY
  ```

Fail-loud behavior: a sandboxed Agent (which, by default, is every Agent —
`sandbox.enabled` is treated as true unless explicitly `false`) whose turn has no
provisionable sandbox executor does **not** run the adapter. Instead the session
emits a `session.error` with `code: "sandbox_unavailable"` and returns to idle.
This prevents the adapter from falling back to built-in fs/bash tools that would
write to the server pod filesystem. In practice this triggers when
`SANDBOX_ENABLED` is unset/false or the `E2B_*` secrets are missing.
