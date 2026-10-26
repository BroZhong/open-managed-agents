# Sandboxes

Every Sandbox is claimed from one **Warm Pool** per deployment environment
and runs an image pinned by digest (ADR-0024). The Runner's `SANDBOX_TEMPLATE`
names the pool (the SandboxSet in `sandbox-system` on the Shanghai
`agent-platform` cluster); each claim passes the image of the Session's
Environment as `e2b.agents.kruise.io/image`: the pool's own image, byte for
byte, is a plain claim; any other is swapped into the claimed Sandbox in
place.

| Directory | Contents |
| --- | --- |
| [oma-base](oma-base/README.md) | Base Image: ACS code-interpreter, Aliyun mirrors, Node 22 + Pi tool runtime, rg/fd, tini, `write-manifest` |
| [oma-media](oma-media/README.md) | Base Image: oma-base + FFmpeg 9.0.1 (OpenH264, libass) and CJK fonts |
| [warm-pool](warm-pool/) | Warm Pool manifests: `oma-sandbox` (production, 8 replicas), `oma-test-sandbox` (oma-test, 1 replica) |
| [environments](environments/video-production/README.md) | Built-in Environments (`video-production`) built on a Base Image |
| [auto-story-v2](auto-story-v2/README.md) | Production's pool and image before Environments; kept for rollback until their production release is accepted |

- [OSS Workspace infrastructure](../deploy/oss-workspace/README.md)
- [Host and Web deployment](../deploy/README.md)

Base Images are built by hand on `vfs-dev` (amd64) and pushed to
`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox` under new tags
(`oma-base-<version>`, `oma-media-<version>`); each recipe records its
published digest in `image.lock.json`. Building never changes a pool.

## Warm Pools

| Environment | SandboxSet | Image |
| --- | --- | --- |
| oma-test | `oma-test-sandbox` ([manifest](warm-pool/oma-test-sandbox.yaml)) | in the manifest; the image builder sets it to `video-production`'s |
| production | `oma-sandbox` ([manifest](warm-pool/oma-sandbox.yaml)) | in the manifest; the image builder sets it to `video-production`'s |

Neither template carries secrets (auto-story-v2 set base-secret as pod env,
which only PID 1 sees): every command gets its
Session's Environment variables from the Runner, which resolves platform
secret references from `sandbox-system/base-secret`; envd commands see those,
the create's Workspace paths and `/etc/profile.d`. Create an ACS
ImageCache for a new pool image before patching the pool: an uncached refill pulls
the whole image (about 1.9 GB, 73–81 s). `sandbox-system` and the ACS vCPU
quota are shared with production; `oma-test-sandbox` carries
`oma.dev/test-only: "true"`.

## Runtime contract

The Host checks Workspace ownership and supplies the trusted
`<tenantId>/<workspaceId>/` OSS prefix. Agent Identity issues credentials
restricted to that prefix. `/home/user/workspace` is the persistent CSI mount;
HOME `/home/user`, dependencies and caches remain local. Equipped Skills are
projected at `/skills/<skill-name>/`, outside the Workspace.

Before tools execute, the Host verifies storage identity, the `fuse.ossfs`
mount, ordinary-user write/close/read and exact-prefix OSS readback. Failure
blocks execution; no local Workspace fallback is created. Completed writes
survive Sandbox disposal, errors and Interrupt. Concurrent Sessions can write
the same Workspace; there is no Turn transaction or write lock.

A Sandbox keeps the image it was claimed with; existing Session Sandboxes
need a rebuild to pick up a new image. `span.sandbox_prepare_end` of the
preparation that claimed a Sandbox records its `image`, whether the claim
`swapped` it in place, and `claimMs`.

## Built-in Environments

`environments/<name>/` holds the repository's Built-in Environments
([ADR-0024](../docs/adr/0024-environments.md)): `environment.json` and the
`init.sh` that the image builder runs on its Base Image.
[`video-production`](environments/video-production/README.md) replaces
`auto-story-v2`.
