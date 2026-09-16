# Sandbox templates

`auto-story-v2` is the only maintained template, deployed in `sandbox-system`
on the Shanghai (`cn-shanghai`) `agent-platform` cluster. Its SandboxSet name
is the E2B template ID. The Host default and SDK fallback both select it.

- [Image recipe and verification](auto-story-v2/README.md)
- [SandboxSet manifest](auto-story-v2/sandboxset.yaml), including the deployed image digest
- [OSS Workspace infrastructure](../deploy/oss-workspace/README.md)
- [Host and Web deployment](../deploy/README.md)

Image recipes and template manifests belong in this directory. Application
and shared infrastructure declarations belong in `deploy/`. Business Agent
presets, prompts, workflows and Skill content are supplied outside this
repository; the platform's Skill Library and Agent Skill projections remain
supported. The image retains its existing VFS, MediaKit, FFmpeg and Gemini tools.

## Build and deploy

From the repository root, build the image and run its offline checks:

```bash
bash build.sh --tag <tag> sandbox
```

Use an amd64 builder with access to the Shanghai registry. Add `--push` to
publish the verified image. Building does not update a running SandboxSet.
To validate or deploy a published image, use the explicit cluster entrypoint:

```bash
bash deploy/scripts/deploy-sandbox.sh --image <immutable-image>
bash deploy/scripts/deploy-sandbox.sh --image <immutable-image> --apply --confirm-production
```

The first command performs a server-side dry-run. The deployment script uses
`~/.kube/agent-platform-config` and never switches the default context.

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

Existing Session sandboxes require rebuilding to use a new image. Agent
`sandbox.image` overrides remain a platform capability, but this repository
ships only `auto-story-v2`; retired template names cannot provision a pool.
