# Sandbox runtime 0.3.1 — build-only verification

Built and pushed on vfs-dev on 2026-10-20 from source commit
`7714959c04e408bcf5ca8fdb29329f6fa68af659`, branch
`codex/sandbox-runtime-0.3.1`. The recipe is
[`runtime-overlay`](../../sandbox/auto-story-v2/runtime-overlay/README.md).
Builder checkout: `~/workspace/yuzhong/oma-sandbox-runtime-0.3.1`.
Command: `PUSH=1 bash sandbox/auto-story-v2/runtime-overlay/build.sh`.

## Artifact

- Tag: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:auto-story-v2-0.3.1-20261020`
- Registry-verified OCI index digest: `sha256:d0a845742fc6fd1b435a5066c5911ce52100e97678addecd04b17c49be8ee095`
- Linux amd64 manifest digest: `sha256:023ca089873c2d38e9d9504676bacf7f5665659d1acfb50fd4230d0ba334c64c`
- Parent: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:6f5eedfc6c0b68056c79d316b9676487a481eb28dcc2f035ffed28d8db591eb8`

The parent is the actual live 0.3.0 runtime with offline Whisper and Pi, not the
repository's clean ACS recipe. The parent's entire ordered RootFS layer list is
a prefix of this image. Entrypoint, Cmd, user, working directory, healthcheck and
all inherited environment values are preserved. Only new proxy defaults are
added to the environment.

## Changes and preservation

- Add libgl1 1.6.0-1 and its dependencies: 32 new Debian packages; zero existing
  package upgrades/removals. All 288 inherited Debian package versions match.
- Add SceneDetect 0.7.1. All 185 inherited Python package versions match.
- Retain Pillow 11.3.0 and fonttools 4.61.1, satisfying the requested ranges.
- Retain NumPy 1.26.4, pandas 2.2.3 and OpenCV 4.11.0.86. No overlapping headless
  OpenCV installation or scientific package upgrade.
- Upgrade vfs-cli 0.3.18 to 0.3.19, checking the official archive and binary hashes.
- Add `/etc/pip.conf` with `https://mirrors.aliyun.com/pypi/simple/`.
- Add HTTP_PROXY/HTTPS_PROXY and lowercase variants pointing to
  `http://sing-box.oma-infra.svc.cluster.local:7890`, plus loopback/cluster
  NO_PROXY defaults; also record them in `/etc/oma/proxy.env`.
- All 24 retained critical asset hashes match, including media/search/Node/Python
  executables, Pi lockfile, Jupyter startup and offline Whisper model assets.

## Acceptance

Passed as ordinary `user` with no network and minimal PATH:

- Complete inherited smoke suite: 15 checks, including Gemini SDK API surface,
  Python/scientific imports, search and runtime utilities, VFS audio/Skill dry
  runs, H.264/AAC encoding, subtitle burn-in and MediaKit trim/concat/subtitle.
- Actual offline Whisper inference with both `base.en` and `small`, int8 CPU.
- All seven native Pi 0.83.0 tools: read, write, edit, ls, find, grep, bash.
- `libGL.so.1` and cv2 import; SceneDetect identifies the fixture cut at frame 20.
- Pillow PNG round-trip, fonttools system-font cmap parsing, Python aliases.
- Effective merged pip configuration selects Aliyun without environment setup.
- Separately, inherited ACS startup serves a healthy Jupyter status endpoint.

The initial additional smoke used `pip config get`, which selected a writable
configuration variant rather than the merged effective configuration. It was
corrected to verify `pip config list`; `pip config debug` independently confirmed
that `/etc/pip.conf` was readable. Final packaged acceptance passed before push.

## Runtime boundary

No SandboxSet or existing Sandbox mutation, Runner rollout or new OMA Session
was performed in this build-only step. A final read confirmed the production
SandboxSet still uses the parent digest above.

Image proxy defaults do not establish E2B command inheritance. New-Sandbox
creation-time injection and a real Session network/download test remain required
at rollout. Existing sing-box business-domain routing was not changed here.
