# Sandbox warm pool

The brozhong ACS HK cluster runs Alibaba ACK 托管 Agent Sandbox (OpenKruise
Agents, `agents.kruise.io`), which is E2B-protocol compatible. Sandboxes are
served from **warm pools** declared as `SandboxSet` resources in the
`sandbox-system` namespace.

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

- **image** — `registry-cn-hongkong-vpc.ack.aliyuncs.com/acs/code-interpreter:v1.6`
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
kubectl apply -f deploy/sandbox/sandboxset-code-interpreter.yaml
kubectl get sbs -n sandbox-system code-interpreter
```

`apply` is idempotent. The SandboxSet is ready once `AVAILABLE >= 1`.
