# auto-story sandbox

`auto-story` is an independent E2B template for media Agents. It keeps the ACS
code-interpreter startup contract and the writable `/home/user` Workspace.
Its SandboxSet targets the Shanghai registry used by `agentry.welltop.tech`.
It inherits the exact existing production sandbox digest
`sha256:0a3711009bf5aa907716f57364c8d69ad6e1b65e93d967c6f15615baf286d383`,
including its VFS/OpenMontage toolchain and FFmpeg installation.

The image includes Linux amd64 `vfs-cli` v0.3.14, `mediakit-cli` 0.2.1,
FFmpeg/ffprobe, and the official `google-genai` Python SDK 2.22.0. VFS CLI
v0.3.14 adds SeedAudio generation and audio Resource registration. Python, pip, Node and
the CLIs resolve on a non-login PATH. MediaKit local output defaults to
`/home/user/media`, which participates in Workspace persistence.

Skills are equipped onto the Agent from the existing local Skill folders and
projected under `/skills` by the Host. They are not bundled into this image.

## Environment variables

The existing Agent `sandbox.env` map accepts runtime environment variables;
E2B receives them when the sandbox is created. Values must be strings. Supply
only the variables needed by that Agent. Credential values never belong in
this directory, Docker build arguments, a SandboxSet, or a Skill.

| Variable | Purpose | Local source |
| --- | --- | --- |
| `VFS_TOKEN` | VFS API authentication | Existing shell environment |
| `MEDIAKIT_API_KEY` | MediaKit cloud tasks and local-file uploads | Existing environment or `~/.mediakit/credentials.env` |
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Official Gemini Files/Interactions APIs used by video-analysis | Existing shell environment |
| `MEDIAKIT_OUTPUT_PATH` | Local result directory; default `/home/user/media` | Optional per-Agent override |
| `MEDIAKIT_SURFACE` | Skill invocation provenance; default `skill` | Non-secret image default |
| `MEDIAKIT_RUNTIME` | Agent host provenance; default `pi-agent` | Non-secret image default |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | Optional outbound network routing where required | A sandbox-reachable proxy address |

Google's SDK gives `GOOGLE_API_KEY` precedence if both Google key variables
are present. Prefer supplying one. Local configuration also contains
`VFS_ACCESS_TOKEN`, `VFS_OSS_AK` and `VFS_OSS_SK`; these are not required by
the tested VFS query/media flows and should be supplied only for a workflow
that explicitly needs them. A Mac loopback proxy such as `127.0.0.1:7890`
does not refer to the Mac from a remote sandbox.

`sandbox.env` is ordinary Agent configuration and is visible to principals
that can read that Agent's configuration. Prefer the Host's scoped secret
injection for production credentials. Environment variables remain readable
by code executing inside the target sandbox.

## Prepare, build and verify

Stage the existing Linux VFS build artifact. The Mac executable cannot run in
the sandbox; preparation rejects non-amd64 ELF inputs. The default MediaKit
download comes from its official GitHub release and its archive is verified
against the published SHA-256 checksum.

```bash
cd deploy/sandbox/auto-story
VFS_CLI_SRC=/path/to/linux-amd64/vfs-cli ./build.sh --prepare-only
./build.sh
```

`MEDIAKIT_CLI_SRC` can supply an already downloaded Linux binary when staging
for a host without GitHub access. Supplying a custom MediaKit version also
requires its matching `MEDIAKIT_ARCHIVE_SHA256` when downloading. CLI versions
are checked again inside the Linux image.

On `vfs-dev`, transfer this directory with its prepared `bin/` contents into a
new temporary build directory, then run `./build.sh`. The default pinned parent
is available on the Shanghai VPC. `BASE_IMAGE` can also select the raw ACS
base `registry-vpc.cn-shanghai.aliyuncs.com/welltop/sandbox-base:code-interpreter-v1.6@sha256:1a06c588ce966fe23f1b2662751a80ea881b26c777d246a6f8f7e3e4b53f6fb4`;
the recipe installs FFmpeg only when it is missing. Production verification
uses the pinned Shanghai parent. No credentials are needed to run image checks.
Debian packages and Python wheels use the public Aliyun mirrors for build-host
connectivity. `PIP_INDEX_URL=https://pypi.org/simple/` selects official PyPI
instead; do not put credentials into a build argument.

The Gemini SDK lives in `/opt/auto-story/venv` so installing it cannot upgrade
Jupyter's `/opt/venv` dependencies. The new Python interpreter can still import
the base environment's scientific packages. `python3` and `python` use an exec
launcher so Python locates its venv even through a minimal PATH. CLI version records, binary
checksums and the Python package inventory live under `/opt/auto-story`.

The build verifies the image before an optional push:

```bash
PUSH=1 ./build.sh
```

`REGISTRY`, `TAG` and `VERSION` select the release destination. The default is
`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:auto-story-0.1.1`.
Record the resulting digest in the SandboxSet before a production rollout.

For the 0.1.1 CLI update, reuse the verified 0.1.0 runtime by immutable digest.
This skips reinstalling unchanged Python/OpenMontage dependencies while the
final stage still verifies both CLI versions and reruns all image checks:

```bash
RUNTIME_IMAGE=registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:96ab935b6d775aeac5cd8a3f0c8fc5f1faf1d715f1345ba8ab57bc8467b0fd3f \
  VFS_CLI_SRC=/path/to/verified-v0.3.14-linux-amd64/vfs-cli \
  PUSH=1 ./build.sh
```

Omit `RUNTIME_IMAGE` to build the runtime stage from the original pinned
OpenMontage parent. Skills remain Host projections in either build mode.

`verify-image.sh IMAGE` runs the actual binaries as `user`, with no network,
no host mounts and a minimal PATH. It generates a one-second H.264/AAC fixture,
checks ffprobe and MediaKit's metadata result, verifies embedded VFS skill
discovery, imports Gemini Files/Interactions APIs, and checks environment
injection without printing values. Audio contract checks inspect the exact
`seed-audio-1.0` schema and preview audio generation plus URL/local-WAV Resource
registration. They explicitly accept the CLI's successful dry-run exit code
10 and use a synthetic token, isolated HOME and a reserved invalid endpoint.
They do not submit uploads or paid generation. All temporary media is removed.

## Deploy and select

After pushing and verifying the image, apply the independent pool:

```bash
kubectl --kubeconfig ~/.kube/agent-platform-config apply -f deploy/sandbox/sandboxset-auto-story.yaml
kubectl --kubeconfig ~/.kube/agent-platform-config get sbs -n sandbox-system auto-story
```

The `ali-shanghai` image pull Secret must already exist in `sandbox-system`.
Use `sandbox.enabled: true` and `sandbox.image: "auto-story"` on the Agent.
Existing Session sandboxes must be rebuilt or new Sessions created to pick
up a changed image or environment. The default sandbox pool is unaffected.

## Test through the Agent

Equip the existing local `vfs-skill`, `video-analysis` and MediaKit shared plus
domain Skills onto the Agent. In a fresh Session, first run:

```bash
auto-story-smoke --require-env VFS_TOKEN --require-env MEDIAKIT_API_KEY --require-env GEMINI_API_KEY
```

Use `GOOGLE_API_KEY` in that check if that is the selected Google credential.
This checks the provisioned sandbox but does not prove remote authentication.
Follow it with real VFS queries, a MediaKit cloud operation and terminal task
polling, and a video-analysis Files upload/analysis/delete cycle on a synthetic
test clip. A missing key, failed upload or remote API error must be reported
as an incomplete cloud check, not an image success. See the task's E2E report
for the actual run results.

Sources: [MediaKit 0.2.1 release](https://github.com/volcengine/mediakit-cli/releases/tag/v0.2.1),
[official Google Python SDK](https://googleapis.github.io/python-genai/).
