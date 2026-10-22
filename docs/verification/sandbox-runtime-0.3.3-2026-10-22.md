# Sandbox 0.3.3 / vfs-cli 0.3.21 rollout

User explicitly requested the production upgrade and a corresponding image cache.

- Build source: `15614181`, branch `codex/sandbox-runtime-0.3.1`.
- Builder: `vfs-dev:~/workspace/yuzhong/oma-sandbox-runtime-0.3.1`.
- Build: `PUSH=1 bash sandbox/auto-story-v2/vfs-cli-0.3.21/build.sh`.
- Tag: `auto-story-v2-0.3.3-20261022`.
- Digest: `sha256:67a46af66d3a53f4034b5c4d2c482a0b411718a3e923194bc547ab9528f3ba8d`.
- Parent: deployed 0.3.2 (`sha256:f95eebfa2adb297747d4ccb17d1c151ddf73e82549b76abecdc703ce39843309`).
- Published release archive SHA-256: `13a8125d6083d4747fe74b6d74142121c8c272c10f77b23e5b22334ab48abacb`.
- New ACS cache: `imc-uf6c2ys46pzt3c3grd74`, named
  `oma-sandbox-033-vfs0321-20261022`, matching the exact image digest.

Build tests passed: inherited runtime inventory, overlay smoke (libGL,
SceneDetect, Pillow, fonttools, pip mirror), Pi tools, and CLI version. Full
parent layer prefix and startup configuration including environment values
were compared and retained. Additional offline checks verified that production
environment parameters are rejected by the test policy with exit 2 and
`environment_policy_conflict` even with `--force --yes`, and that shot-table,
canvas and sketch are absent from default command help in v0.3.21.

The guarded production patch changes only the SandboxSet container image.
Existing immutable `vfs-cli-policy-test-v1` ConfigMap, read-only `/etc/vfs-cli`
mount, proxy setup, replicas and resources are preserved. No Runner restart or
mutation of old claimed Sandboxes is part of this release.

Live probe on `auto-story-v2-hmlbm` passed: v0.3.21, imageVersion 0.3.3,
exact test policy, O_WRONLY open rejected with EROFS, environment conflict
blocked with exit 2, and default hidden commands absent. The Pod matched ACS
cache `imc-uf6c2ys46pzt3c3grd74` (5 GiB). Cache was Ready before pool patch.

Pre-update snapshot: 396 claimed Sandboxes; 384 remained with identical UID
and image, 12 no longer present, none changed. No old Sandbox deletion was issued.

Final verification: generation 20, revision `f9bfdfdfb`, 8/8 updated and
available. All 8 observed new-image Pods reported the new ACS cache ID.
