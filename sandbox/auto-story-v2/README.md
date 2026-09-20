# auto-story-v2 sandbox image

This recipe builds the sole maintained `auto-story-v2` template (auto-story 0.2.2) for the Shanghai `agent-platform` cluster
from the original ACS `code-interpreter` image, pinned by digest. It does not
derive from the OpenMontage image: OpenMontage, Whisper, their source trees,
and model weights are absent from every added layer. FFmpeg is compiled with
`--disable-whisper`.

The deployed image digest is recorded in [sandboxset.yaml](sandboxset.yaml).
`versions.json` pins the inputs for future builds; build verification runs
again for each release and is not implied by historical reports.

The ACS Jupyter runtime, Node.js, and E2B startup contract are retained. Agent
commands use the mounted `/home/user/workspace`; Python on a minimal PATH runs the Gemini environment
at `/opt/auto-story/venv`. Its packages take precedence, with `acs-base.pth`
providing access to scientific packages from the clean ACS `/opt/venv` after
them. Installing the Gemini SDK does not modify Jupyter's environment. Python
and pip use exec wrappers so venv discovery survives envd's minimal PATH.

Skills are equipped onto an Agent and projected by the Host under `/skills`.
They are not bundled into the image, and there is no dependency on the removed
story-seed launcher or its former repository Skill folders.

## Pinned releases

Component releases checked on 2026-09-09; the search versions match native Pi
parity tests:

| Component | Version | Source |
| --- | --- | --- |
| vfs-cli | 0.3.15 | [Official distribution](https://github.com/welltop-cn/vfs-cli-dist/releases/tag/v0.3.15) |
| FFmpeg / ffprobe | 9.0.1 | [Official releases](https://ffmpeg.org/download.html) |
| Gemini Python SDK (`google-genai`) | 2.22.0 | [Official SDK release](https://github.com/googleapis/python-genai/releases/tag/v2.22.0) |
| mediakit-cli | 0.2.1 | [Official release](https://github.com/volcengine/mediakit-cli/releases/tag/v0.2.1) |
| ripgrep (`rg`) | 15.1.0 | [Official release](https://github.com/BurntSushi/ripgrep/releases/tag/15.1.0) |
| fd | 10.4.2 | [Official release](https://github.com/sharkdp/fd/releases/tag/v10.4.2) |
| ossutil | 2.2.0 | [Official archive](https://gosspublic.alicdn.com/ossutil/v2/2.2.0/ossutil-2.2.0-linux-amd64.zip) |

The runtime also installs Debian `procps` (providing `ps`) and `unzip`.
`../prepare-ossutil.py` pins and verifies both the official archive and extracted
binary; Docker independently checks the binary hash. `OSSUTIL_SRC` may supply
the same pinned Linux amd64 binary for offline preparation. These utilities are
available to the ordinary sandbox user without an install during Skill execution.

`versions.json` records the FFmpeg/CLI source hashes, CLI binary hashes and
the base image digest. The shared `../prepare-search-binaries.py` pins the
rg/fd archives and binaries; Docker independently verifies the pinned CLI binary
hashes before executing them. Search versions and checksums are recorded under
`/opt/pi-search/`.
The FFmpeg source archive was also verified against its official detached
signature and signing fingerprint. Python dependencies resolved during the
build are recorded in `/opt/auto-story/python-packages.txt`; Debian packages
and executable hashes are recorded alongside it. A later build can receive
updated transitive Python/Debian dependencies; the source archive hashes and
the component versions and verified upstream inputs remain pinned.

Pi 0.83.0 is installed unmodified at `/opt/oma-pi-tools` using the committed npm
lockfile. The Host registers public custom tools and invokes these native tool
factories through ToolExecutor; model inference stays on Host. Image acceptance
executes all seven tools as the ordinary user. Upgrade/rebuild Sandboxes before
releasing the matching Host version; older Sandboxes lack the required runtime.
See [ADR-0014](../../docs/adr/0014-public-pi-sdk-boundary.md).

FFmpeg includes H.264 (x264 and OpenH264)/H.265, VP8/VP9, AV1, AAC, MP3, Opus, Vorbis and WebP
support, plus text/subtitle filters and DejaVu/Noto CJK fonts. The compiler and
development packages stay in the build stage. No older FFmpeg is silently
substituted for the requested release.

## Build and verify

Run on an amd64 builder with access to the Shanghai VPC image mirror, such as
`vfs-dev`. Authenticate to the Shanghai ACR before a push:

```bash
cd sandbox/auto-story-v2
bash build.sh --prepare-only # stages verified inputs without running Docker
bash build.sh                # builds and tests without pushing
PUSH=1 bash build.sh         # pushes only after all acceptance checks pass
```

`build.sh` always invokes `fetch-sources.py`. Preparation downloads official
FFmpeg/CLI archives, checks SHA-256, extracts only the requested binaries, and
calls the shared rg/fd preparation helper. Matching cached archives are reused.
`VFS_CLI_SRC` and `MEDIAKIT_CLI_SRC` may supply local Linux binaries; their
checksums must match the pinned releases. `RG_SRC` and `FD_SRC` provide the
same option for the search binaries.

To prepare on a machine with GitHub access and build elsewhere, copy the
`sandbox` recipe tree, including `prepare-search-binaries.py`, the
prepared `auto-story-v2/sources/` archives and `auto-story-v2/bin/` files. Both shared
helpers, `prepare-search-binaries.py` and `prepare-ossutil.py`, must remain beside
the auto-story-v2 directory. Python wheels and Debian
packages still need a reachable package mirror during the build.

The default tag is `auto-story-v2-0.2.2` in
`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox`.
`REGISTRY`, `TAG`, `VERSION`, `BUILD_JOBS`, `BASE_IMAGE`, and `PIP_INDEX_URL`
may be overridden. A base override must retain the clean ACS runtime contract
and pass the same exclusions and startup checks. The default pip mirror is
Aliyun; `PIP_INDEX_URL=https://pypi.org/simple/` selects official PyPI.
`RUNTIME_IMAGE` reuse is rejected. Component-version overrides such as
`VFS_CLI_VERSION` and `MEDIAKIT_CLI_VERSION` are also rejected: update the
version records, verified hashes and acceptance expectations together.
Build and acceptance outputs are saved to `build-metadata.json` and
`verification.json` (gitignored).

Acceptance runs with no network as the unprivileged `user`, on a minimal PATH:

- Exact component versions and Gemini Files/Interactions API availability.
- Minimal-PATH `python3 -I` selects the Gemini venv and can import the same
  numpy/pandas versions present in the clean ACS environment.
- rg Unicode regex, brace globs and `.gitignore`; fd recursive basename and path globs.
- ossutil version/copy-command help, `ps` process visibility and actual ZIP extraction.
- Embedded VFS Skill discovery, SeedAudio schema and reference limits,
  generation dry-run, and audio Resource URL/local-WAV registration dry-runs.
- Workspace write access, H.264/AAC encoding, probing, and subtitle burn-in.
- MediaKit local trim, concat, and subtitle output, including stream/duration checks.
- Absence of OpenMontage/Whisper binaries, packages and source directories.
- The inherited ACS entrypoint still starts a healthy Jupyter server.

MediaKit's local backend requires FFmpeg >=5.1 and selects OpenH264 on Linux
for its H.264 encoding operations. This build includes that encoder and tests
local processing against FFmpeg 9.0.1. VFS dry-runs explicitly accept exit code
10 and use a synthetic token, isolated HOME and the reserved `offline.invalid`
endpoint. They submit no uploads or generation. All checks run without network
access and require no service credentials; temporary media and fixtures are removed.

## Workspace and local directories

Only `/home/user/workspace` persists in OSS. The image leaves it absent so CSI
can provide the mount. HOME stays at `/home/user`; local dependency paths are
`/home/user/.local/npm`, `/home/user/.local/oma-node/node_modules`,
`/home/user/.local/oma-python` and `/home/user/.local/venvs`. npm/pip caches live
under `/home/user/.cache`, and temporary files use `/tmp`. Sandbox rebuilds can
discard these local files. Install a Python venv outside the Workspace and use
`npm install --prefix /home/user/.local/oma-node` for local Node dependencies.

The internal `/opt/auto-story` tool paths and `auto-story-smoke` executable are
part of the existing image contract; they do not name an additional template.

## Runtime configuration

Only non-secret defaults are included: `WORKSPACE_DIR=/home/user/workspace`,
`MEDIAKIT_OUTPUT_PATH=/home/user/workspace/media`, `MEDIAKIT_SURFACE=skill`, and
`MEDIAKIT_RUNTIME=pi-agent`. Runtime credentials must be injected by the Host
or the Agent's `sandbox.env`; they are not build arguments or image layers.

The Server is configured with `SANDBOX_TEMPLATE=auto-story-v2`, and the SDK
fallback also selects `auto-story-v2`. The UI's **Server default** choice inherits
this setting; an Agent's explicit `sandbox.image` keeps selecting its named
template. Selecting a default template does not expand the Agent allowlist for
Host-owned credentials in `oma-auto-story-env`.

Building and pushing an image does not change the running SandboxSet. Its
pinned digest and pool configuration are in
[sandboxset.yaml](sandboxset.yaml). Existing Session
sandboxes must be rebuilt, or new Sessions created, to pick up the new image.
Use `~/.kube/agent-platform-config` for the Shanghai cluster. From the repository
root, the standard deployment script validates auto-story-v2 by default:

```bash
bash deploy/scripts/deploy-sandbox.sh
bash deploy/scripts/deploy-sandbox.sh --apply --confirm-production
```

Changing the SandboxSet alone does not change the Server's default. Updating
`oma-server-config` requires a Server rollout; `deploy-app.sh` only updates
application images and does not apply ConfigMap changes.

To test a subsequent rollout through the running Host's E2B gateway:

```bash
kubectl --kubeconfig ~/.kube/agent-platform-config -n oma-infra exec -i deployment/oma-server -c server \
  -- node --input-type=module < sandbox/auto-story-v2/verify-live.mjs
```

Run this command from the repository root. It requires the Host's configured
default to be `auto-story-v2`, then uses its installed `E2BSandboxClient` to create
a short-lived sandbox without an image override. It checks environment
injection and file write/read/reconnect, runs the image acceptance checks
through E2B commands, and reclaims the sandbox.
