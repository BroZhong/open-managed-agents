# Sandbox warm pool

The `agent-platform` ACS cluster in cn-shanghai runs Alibaba ACK managed Agent
Sandbox (OpenKruise Agents, `agents.kruise.io`), which is E2B-protocol
compatible. Sandboxes are served from warm pools declared as `SandboxSet`
resources in the `sandbox-system` namespace.

Production currently has one active pool: `code-interpreter`. The older
`code-interpreter-vfscli` assets are an optional prototype and are not deployed
or selected by the production Server.

## The name is the templateID

A `SandboxSet`'s `metadata.name` IS the E2B **templateID**. When a client calls

```ts
Sandbox.create("code-interpreter")
```

the E2B endpoint hands back a pre-warmed pod from the `code-interpreter`
SandboxSet. If no SandboxSet exists for a template, `POST /sandboxes` fails with
`400 "Template or Checkpoint not found"` — there is no implicit / on-demand
template. This manifest is what makes the `code-interpreter` template exist.

## Manifest

[`sandboxset-code-interpreter.yaml`](./sandboxset-code-interpreter.yaml) defines
the `code-interpreter` pool:

- **image** — `registry-cn-shanghai-vpc.ack.aliyuncs.com/acs/code-interpreter:v1.6`
  (the ACS-provided code-interpreter image; VPC ACR mirror).
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
- the container image tag — to roll a new code-interpreter image.

No other resource needs editing to resize the pool.

## Apply / verify

```bash
KUBECONFIG=~/.kube/agent-platform-config kubectl apply -f deploy/sandbox/sandboxset-code-interpreter.yaml
KUBECONFIG=~/.kube/agent-platform-config kubectl get sbs -n sandbox-system code-interpreter
```

`apply` is idempotent. The SandboxSet is ready once `AVAILABLE >= 1`.

## Mandatory sandbox (issue #54)

The sandbox is not optional. Every Agent run must execute inside a sandbox and
the server fails loud when it can't provision one.

Server wiring (see `deploy/k8s.yaml`):

- `SANDBOX_ENABLED=true` — in the `oma-server-config` ConfigMap (non-secret).
  This turns on the sandbox-backed `ToolExecutor`.
- `SANDBOX_TEMPLATE=code-interpreter` — ConfigMap; the E2B templateID, i.e. the
  SandboxSet name above.
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
