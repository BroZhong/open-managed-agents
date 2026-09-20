# OSS Workspace infrastructure

These shared resources support the `auto-story-v2` SandboxSet in Shanghai
`agent-platform`. The application runs in `oma-infra`, and Sandbox/Agent
Identity resources run in `sandbox-system`. This directory contains storage
infrastructure, not an image recipe.

| Resource | Declaration |
| --- | --- |
| AgentIdentity `agentry-workspace` | `storage.yaml` |
| CredentialProvider `agentry-oss-rw` | `storage.yaml` |
| AgentRole / AgentRoleBinding `agentry-workspace-storage` | `storage.yaml` |
| PersistentVolume `agentry-workspace-oss` | `storage.yaml` |
| Sandbox RAM trust and maximum object permissions | `ram-trust-policy.json`, `ram-permissions-policy.json` |
| Host object permissions | `ram-host-permissions-policy.json` |

The resources were confirmed to exist on 2026-09-16. The PV uses `Retain`,
`ReadWriteMany` and Agent Identity, with the internal Shanghai OSS endpoint.
Its declared capacity is not an OSS quota; `Available` is not evidence that
this dynamic mount infrastructure is unused. CredentialProvider narrows each
STS credential to the requested bucket/subPath in private bucket `agentry`.
Host credentials are separate and never supplied to the Sandbox.

The maintained [Sandbox recipe](../../sandbox/auto-story-v2/README.md) and
[manifest](../../sandbox/auto-story-v2/sandboxset.yaml) live under `sandbox/`.
The Host's read access to shared native credentials is declared separately in
[the base Secret RBAC](../sandbox-base-secret-rbac.yaml).

## Inspect the current deployment

Use the dedicated kubeconfig without changing the default context:

```bash
kubectl --kubeconfig ~/.kube/agent-platform-config -n sandbox-system get sandboxset auto-story-v2
kubectl --kubeconfig ~/.kube/agent-platform-config -n sandbox-system get agentidentity agentry-workspace
kubectl --kubeconfig ~/.kube/agent-platform-config -n sandbox-system get credentialprovider agentry-oss-rw
kubectl --kubeconfig ~/.kube/agent-platform-config get pv agentry-workspace-oss
```

Preserve existing RAM roles and compatible managed add-ons. Review drift before
applying declarations. Do not print Secret data, signed URLs or runtime token
annotations into logs. See the [deployment and recovery guide](../../docs/oss-workspace-deployment.md)
for Host settings, mount attestation and failure handling.

## Credential refresh verification

`verify-credential-refresh.mjs` targets `auto-story-v2`. It creates its own
random OSS prefix and Sandbox, attests the real mount and scoped identity,
writes as UID/GID 1000, checks Host OSS readback, waits 65 minutes and repeats.
It cleans only those test resources in `finally`. This is an active integration
probe that writes cloud resources, not a read-only inspection command.

Run it only as part of an authorized live verification, with dependencies
installed and access to the existing `welltop` CLI profile:

```bash
pnpm --dir server install --frozen-lockfile
OMA_SHANGHAI_KUBECONFIG="$HOME/.kube/agent-platform-config" \
  OMA_PROBE_REPORT=/tmp/oma-oss-workspace-verification.json \
  node deploy/oss-workspace/verify-credential-refresh.mjs
```

It reads the E2B key into process memory, never into command arguments. Verify
`credential-refresh-passed`, `sandbox-cleaned` and `prefix-cleaned` in the
report. If execution or cleanup is interrupted, use its exact resource IDs to
complete cleanup; Sandbox expiry alone does not remove OSS objects.

Historical evidence for the original OSS migration is retained under
[`docs/verification/oss-workspace`](../../docs/verification/oss-workspace/README.md).
Those snapshots describe their original versions. The former isolated
application probe used Session file routes and a write gate superseded by
ADR-0009, and has been removed. Current file behavior is covered by the API's
Workspace route tests and [the file API contract](../../docs/adr/0009-workspace-file-api.md).

## Console read CORS

`console-cors.json` records the read rule applied to the private `agentry` Bucket.
It permits only `https://agentry.welltop.tech` with GET/HEAD, Range and conditional
read headers; it grants no object access without a valid signature. Keep other
Bucket rules when updating CORS. Verify with `getBucketCORS("agentry")` and a
signed GET carrying the console Origin; the SDK requires the explicit Bucket
argument. See `docs/oss-workspace-deployment.md` for browser checks.
