> Historical recipe, no longer maintained. Use [auto-story-v2](../auto-story/README.md).

# `code-interpreter-vfscli` Sandbox image

This is the application template for Shanghai `agent-platform`
(`c4d4dbd36064d4341835496ed01023600`). The image adds `vfs-cli`, a stable
`story-seed` launcher, and Python on the E2B command PATH. It preserves the ACS
base's `ENTRYPOINT` and `CMD` so the injected `agent-runtime` continues to work.
The deployed image digest and infrastructure inventory are recorded in
[`../oss-workspace/README.md`](../oss-workspace/README.md).

## Workspace and local directories

The Host, parent Agent, child Agents, and launcher use the same persistent
Workspace: `/home/user/workspace`. CSI creates a root-owned symlink to the real
`fuse.ossfs` mount. The image leaves this path absent; image build checks reject
an existing directory or symlink there. Building an image cannot prove that a
runtime OSS mount works.

Before tools execute, the Host checks E2B identity metadata, the real mount and
ordinary-user read/write access. It reads a temporary probe back through the
Host OSS store to prove the exact bucket and Tenant/Workspace prefix, then
cleans the probe. A failed check blocks execution. The launcher does not create
a Workspace directory or fall back to HOME.

`HOME=/home/user` stays local. Dependency and cache defaults match
[`workspace-environment.ts`](../../../server/packages/session-router/src/workspace-environment.ts):

| Purpose | Directory |
| --- | --- |
| Node packages | `/home/user/.local/oma-node/node_modules` (`NODE_PATH`) |
| npm global prefix | `/home/user/.local/npm` (`NPM_CONFIG_PREFIX`) |
| Python packages | `/home/user/.local/oma-python` (`PYTHONPATH`) |
| Python virtual environments | `/home/user/.local/venvs/<name>` |
| npm / pip caches | `/home/user/.cache/npm`, `/home/user/.cache/pip` |
| Other caches / temporary files | `/home/user/.cache`, `/tmp` |

Supported installation examples inside the Sandbox:

```bash
npm install --prefix "$HOME/.local/oma-node" --no-save is-number
node -e 'console.log(require("is-number")(42))'
python3 -m pip install --target "$PYTHONPATH" packaging
python3 -c 'import packaging; print(packaging.__version__)'
```

CommonJS uses `NODE_PATH`; native ESM does not. ESM callers can use
`createRequire` from `node:module` or an explicit local import path. An isolated
Python environment can use `python3 -m venv "$HOME/.local/venvs/project"`.
These directories may be lost when a Sandbox is rebuilt; reinstall then. Shell
commands are not rewritten: installing `node_modules` or `.venv` under the
Workspace can persist them, so follow the local installation conventions.

## Skills and `story-seed`

Equipped Skills are read-only projections under `/skills/<skill-name>/`, outside
the Workspace. Skill IDs remain internal storage coordinates. The launcher
finds `/skills/<skill-name>/scripts/story-seed` and invokes that file with Node;
it contains no additional copy of the business script. Identical equipped
copies are accepted; conflicting copies or a missing script fail clearly.

The launcher defaults `STORY_SEED_WORKSPACE` to `/home/user/workspace` and changes
cwd to it, so relative CLI input arguments and generated files use the same
root. `STORY_SEED_WORKSPACE` and `OMA_SKILLS_ROOT` can be overridden deliberately
for local tests. A missing Workspace fails before Node runs and is not created.

## Runtime credentials

No cloud key, E2B key, VFS token or WW bearer is baked into this image. OSS
credentials are supplied by Agent Identity with bucket/subPath-scoped STS
permissions. `VFS_TOKEN` is injected for the relevant Agent at runtime.

The optional story-seed WW integration remains off by default. Its Host-side
allowlist and all-or-nothing secret configuration are documented in
[`../../k8s.yaml`](../../k8s.yaml). When enabled, the allowlisted Sandbox receives
`OPENGROVE_WW_BASE_URL` and `OPENGROVE_WW_ACCESS_TOKEN`. Sandbox code can access
its own environment; this is not a mechanism for hiding the bearer from that
Agent's code. Do not print either value during verification.

## Build and release

`bin/vfs-cli` is a gitignored build artifact. Use an approved linux/amd64 binary
and a build host that can reach the Shanghai VPC ACS mirror, such as `vfs-dev`.
An alternate build environment must supply an approved reachable `BASE_IMAGE`.

```bash
# Build locally on the chosen build host; this does not publish or deploy.
VFS_CLI_SRC=/path/to/linux-amd64/vfs-cli ./build.sh

# Run only when publishing this image is authorized.
VFS_CLI_SRC=/path/to/linux-amd64/vfs-cli PUSH=1 ./build.sh
```

The default target is
`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:code-interpreter-vfscli-0.5.0`.
`REGISTRY`, `TAG`, `VERSION`, `BASE_IMAGE` and `CACHE_DIR` are explicit overrides.
The build always targets linux/amd64 and uses a persistent buildx cache. The
local cache is excluded from Git and Docker build context. It runs
`test-story-seed-launcher.sh` before Docker starts; the tests exercise named
Skill discovery, identical/conflicting scripts, the default root, a local cwd
override and a missing Workspace.

A local build and ordinary-user smoke passed on 2026-09-14; see
[`local-build-verification.json`](./local-build-verification.json) for the exact
base digest, binary hash and checks. It was not pushed to a registry.

The new image must be published and its registry digest reviewed before
application cutover.
Update [`../sandboxset-code-interpreter-vfscli.yaml`](../sandboxset-code-interpreter-vfscli.yaml)
with that digest. During the approved release window use the explicit Shanghai
kubeconfig from the inventory, without changing the default context:

```bash
kubectl --kubeconfig "$OMA_SHANGHAI_KUBECONFIG" apply \
  -f deploy/sandbox/sandboxset-code-interpreter-vfscli.yaml
kubectl --kubeconfig "$OMA_SHANGHAI_KUBECONFIG" -n sandbox-system \
  get sbs code-interpreter-vfscli
```

The `ali-shanghai` image-pull Secret must already exist in `sandbox-system`.
Follow the coordinated Host/storage/template release gate in the inventory;
changing only `SANDBOX_TEMPLATE` does not update existing Sandbox resources or
per-Agent template overrides. The stock `code-interpreter` reference template
has not passed this application's OSS Workspace acceptance tests.

## Runtime verification

Run these through the application's verified Sandbox tools using a disposable
Workspace and equipped story Skills:

```bash
whoami                                      # user
pwd                                         # /home/user/workspace
printf 'hello\n' > hello.txt
python3 -c 'from pathlib import Path; Path("中文.txt").write_text("已保存", encoding="utf-8")'
vfs-cli version
command -v story-seed                        # /usr/local/bin/story-seed
story-seed doctor
```

Check the same files through authenticated web upload/list/preview/download
routes, then recreate the Sandbox and read them again. Check that local
packages may be reinstalled and Skills still load outside the Workspace.
Successful file close defines a saved write; Turn completion is not a
transaction, a rollback point, or a guarantee for background/open file handles.
Concurrent Sessions may overwrite the same file and OSS caches can delay
visibility. Infrastructure-only checks do not replace the full release gate.
