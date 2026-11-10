# Production Runner resources — 2026-11-10

The maintainer requested 1 CPU and then clarified that container memory should
remain 8 GiB, preserving the existing 6 GiB V8 old-space limit. Production
`oma-infra/oma-runner` now has those settings; the test overlay remains 1C4G.

Before the change, the live Deployment and Pod were **1 CPU / 5 GiB** with
`NODE_OPTIONS=--max-old-space-size=6144`. Managed fields attribute the resource
limits to `OneConsole-App-CS` at 16:25:23 CST. The HPA manager owns only the
Deployment's `scale` subresource replica count, not its container resources.
The repository still declared 2C8G, so a future full apply of that old manifest
could restore the old CPU setting; the manifest now declares 1C8G.

A JSON Patch with UID/container/resource preconditions changed only the Runner's
container resources. Server dry-run preserved replica count and rollout strategy.
No image, ConfigMap, ScaledObject, HPA policy, or other Deployment was changed.
The existing `maxSurge=25%`, `maxUnavailable=0` rollout kept the old Pod until
the replacement was ready. Rollout completed at **16:33:18 CST**.

Verification:

- New Pod `oma-runner-5bb7495c5b-sq26t`: **1/1 Ready, 0 restarts**. Old Pod gone.
- Deployment: desired/updated/ready/available all **1**, terminating **0**.
- Container limits and admission-defaulted requests: **1 CPU / 8 GiB**.
- Actual cgroup CPU quota/period: **100000 / 100000**, i.e. one core.
- Actual cgroup memory limit: **8589934592 bytes**, i.e. 8 GiB.
- `NODE_OPTIONS=--max-old-space-size=6144`; V8 reports total heap limit
  6492782592 bytes (old-space plus other V8 heap areas).
- Runner `/health` and `/ready` both returned HTTP **200**.
- ScaledObject minimum **1**, maximum **50**; demand target remains **40**.
- Deployment's last-applied configuration still omits `spec.replicas`.
- Deployment/rendering tests: **49 passed, 1 skipped, 0 failed**.

This verifies the resource change and health, not a new capacity/stress baseline
for the smaller CPU allocation. Raw before/after, managed-field, and runtime
evidence was saved locally under `/tmp/oma-runner-resources-20261110/` and
`/tmp/oma-production-release-20261109/runner-resource-managed.json`.
