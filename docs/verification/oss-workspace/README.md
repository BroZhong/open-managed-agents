# Historical OSS migration evidence — 2026-09-14

These immutable verification snapshots support the original OSS migration:

- `verification.json`: infrastructure, mounted I/O and real STS refresh checks.
- `production-verification.json` and `production-verification.png`: the release's
  live application and browser observations.

Template names, source paths, commands and image digests inside these records
belong to the original runs. Some templates and probes have since been removed.
They are evidence, not current deployment instructions. The old Session file
routes and HTTP 423 write gate were superseded by
[ADR-0009](../../adr/0009-workspace-file-api.md).

Use [the deployment guide](../../../deploy/README.md),
[current Sandbox template](../../../sandbox/README.md) and
[storage infrastructure](../../../deploy/oss-workspace/README.md) for operations.
