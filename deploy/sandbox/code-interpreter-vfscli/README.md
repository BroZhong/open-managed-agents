# `code-interpreter-vfscli` sandbox image

This is an optional custom-image prototype. It is **not deployed on the current
agent-platform production cluster**; production uses the stock
`code-interpreter` SandboxSet. Keep this image only for experiments that need
the extra tools below, and do not treat these instructions as the production
runbook.

## What it adds over the ACS base

| Gap in the stock base | Fix in this image |
| --- | --- |
| Old default `/workspace` sits under root-owned `/`; e2b `exec` runs as the non-privileged `user`, so `mkdir /workspace` failed silently and bash `>` / program writes to it failed (**#85**) | Canonical `WORKSPACE_DIR=/home/user` — E2B's recommended user home, owned by `user` by construction |
| Parent/child tools and persistence could drift onto different roots | One fixed `/home/user` contract shared by Pi, subagents, SandboxManager, and the image |
| `vfs-cli` absent | Go static binary (linux/amd64) COPYd onto `/usr/local/bin` |
| `python`/`pip` live in `/opt/venv/bin`, absent from e2b exec's non-login PATH (`python: command not found`) | symlinked into `/usr/local/bin` |

python3, node, and jupyter come from the base. The base's `ENTRYPOINT`/`CMD`
(the jupyter start-up script the e2b `agent-runtime` hooks into) are inherited
**unchanged** — do not set them in the Dockerfile.

## `VFS_TOKEN` is NOT in the image

`VFS_TOKEN` is a **per-Agent secret**, injected at run time via `sandbox.env`
(→ e2b `create` envs). It is never baked into the image — the image is
token-free and safe to push to a shared registry, and every Agent supplies its
own token. Only non-secret vfs-cli defaults (if any) belong in the image.

## Build

The vfs-cli binary is a versioned build artifact, not source — it lives under
`bin/` (gitignored) and is staged by `build.sh`, not committed.

```bash
# Local build (amd64 via emulation on a Mac is fine — the image is small):
VFS_CLI_SRC=/path/to/linux-amd64/vfs-cli ./build.sh

# Build + push to the configured Shanghai ACR:
VFS_CLI_SRC=/path/to/linux-amd64/vfs-cli PUSH=1 ./build.sh
```

### On the Shanghai build host (vfs-dev)

The ACS base is mirrored into the `welltop` Shanghai ACR by
`deploy/scripts/build-base-images.sh`. Copy the vfs-cli binary to the build host
first because its release CDN can be slow or unreliable from mainland China,
then run from the repository root:

```bash
VFS_CLI_SRC=~/vfs-cli \
  deploy/scripts/build-images.sh --push --tag <tag> sandbox
```

Authenticate Docker to the target Shanghai ACR before using `PUSH=1`.

### Cache

`build.sh` uses a persistent buildx local cache (`.buildx-cache/`). The
Dockerfile is ordered cache-first: apt/symlink/chown sit in one rarely-changing
layer, and the vfs-cli binary is COPYd last — so a vfs-cli bump rebuilds only
the final two layers, not the whole image.

## Optional deployment

Do not perform these steps as part of a normal production release. Production
must continue to use `SANDBOX_TEMPLATE=code-interpreter` unless the custom pool
has been deliberately reviewed and enabled.

1. Validate the custom pool against `agent-platform`, then explicitly apply it:

   ```bash
   ../../scripts/deploy-sandbox.sh --pool custom --image <immutable-image>
   ../../scripts/deploy-sandbox.sh --pool custom --image <immutable-image> \
     --apply --confirm-production
   ```

   The `ali-shanghai` pull Secret must also exist in `sandbox-system`.

2. Opt in only the intended Agent with
   `sandbox.image: "code-interpreter-vfscli"`. Changing the production-wide
   `SANDBOX_TEMPLATE` is outside this prototype procedure.

## E2E verification (#85 acceptance)

Drive an Agent with `sandbox.image: "code-interpreter-vfscli"` and
`sandbox.env: { VFS_TOKEN: <token> }`, then via the bash tool:

```bash
whoami                                   # -> user
pwd                                      # -> /home/user  (the default cwd)
echo hello > /home/user/f.txt && cat /home/user/f.txt   # -> hello  (was: permission denied under /workspace)
python3 -c 'open("/home/user/p.txt","w").write("ok")'   # program write lands
vfs-cli version                          # vfs-cli on PATH
```

All four must succeed. The write failures were the #85 symptom; they are the
regression to watch.
