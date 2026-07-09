# `code-interpreter-vfscli` sandbox image

The custom sandbox image the brozhong HK cluster serves for Agents that opt in
with `sandbox.image: "code-interpreter-vfscli"`. It exists to fix three gaps in
the stock ACS `code-interpreter` base while keeping the E2B protocol intact.

## What it adds over the ACS base

| Gap in the stock base | Fix in this image |
| --- | --- |
| Old default `/workspace` sits under root-owned `/`; e2b `exec` runs as the non-privileged `user`, so `mkdir /workspace` failed silently and bash `>` / program writes to it failed (**#85**) | Default `WORKSPACE_DIR=/home/user` — E2B's recommended user home, owned by `user` by construction — plus a `chown` + `0775` for overridden paths |
| Workspace path is fixed | `WORKSPACE_DIR` build ARG/ENV (default `/home/user`); the chown tracks it, and it stays in sync with SandboxManager's `EnvSpec.workspaceDir` (same default) |
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

# Build + push to the HK personal ACR:
VFS_CLI_SRC=/path/to/linux-amd64/vfs-cli PUSH=1 ./build.sh
```

### On the Shanghai build host (vfs-dev)

The ACS base only pulls from a **region-local VPC** mirror. On vfs-dev
(Shanghai) that is `registry-cn-shanghai-vpc...`; the HK VPC / public variants
are unreachable from there (content is identical across regions). scp the
vfs-cli binary over (its release CDN is slow/flaky from CN hosts), then:

```bash
BASE_IMAGE=registry-cn-shanghai-vpc.ack.aliyuncs.com/acs/code-interpreter:v1.6 \
VFS_CLI_SRC=~/vfs-cli PUSH=1 ./build.sh
```

Shanghai → HK personal ACR pushes over the public endpoint (needs a separate
`docker login` to the HK ACR; it coexists with the Shanghai login — `auths` are
keyed per registry).

### Cache

`build.sh` uses a persistent buildx local cache (`.buildx-cache/`). The
Dockerfile is ordered cache-first: apt/symlink/chown sit in one rarely-changing
layer, and the vfs-cli binary is COPYd last — so a vfs-cli bump rebuilds only
the final two layers, not the whole image.

## Deploy

1. Bump the image tag in `../sandboxset-code-interpreter-vfscli.yaml` to match
   `VERSION` you built, then apply:

   ```bash
   kubectl apply -f ../sandboxset-code-interpreter-vfscli.yaml
   kubectl get sbs -n sandbox-system code-interpreter-vfscli   # AVAILABLE >= 1
   ```

   The `oma-acr` pull secret must exist in `sandbox-system` (copy from
   `oma-infra` if absent — that ns has no pull secret by default).

2. Point production at it. `SANDBOX_TEMPLATE` in the `oma-server-config`
   ConfigMap (`deploy/k8s.yaml`) is the *default* template; Agents can also opt
   in per-Agent with `sandbox.image: "code-interpreter-vfscli"` without changing
   the default. To make it the default, set
   `SANDBOX_TEMPLATE=code-interpreter-vfscli` and roll the server.

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
