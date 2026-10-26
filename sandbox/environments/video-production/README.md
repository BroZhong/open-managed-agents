# video-production

Built-in Environment `env_video_production` ([ADR-0024](../../../docs/adr/0024-environments.md),
#305). It replaces the `auto-story-v2` template, whose live image is 0.3.3
(`oma-sandbox@sha256:67a46af66d3a53f4034b5c4d2c482a0b411718a3e923194bc547ab9528f3ba8d`,
recipe on the unmerged branch `codex/sandbox-runtime-0.3.1`; main's
`sandbox/auto-story-v2/` is the older 0.2.3 recipe). The image builder upserts
`environment.json` and builds `init.sh` on the `oma-media` Base Image.

## Variables

- **Platform defaults (plain):** `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`,
  `https_proxy` = the cluster's sing-box; `NO_PROXY` / `no_proxy` =
  loopback, `.svc`, `.cluster.local`, `.aliyuncs.com`, `.aliyun.com`,
  `.npmmirror.com`, so GitHub and other foreign hosts go through sing-box while
  Aliyun mirrors, OSS and ACR stay direct. `base-secret` also carries these six
  keys, with a `NO_PROXY` that lacks the Aliyun suffixes; they are declared here
  as plain values, not references.
- **Platform secrets:** every other environment key of
  `sandbox-system/base-secret`, one to one by name, including the non-secret
  settings that only that Secret supplies today (`MEDIAKIT_SURFACE`,
  `MEDIAKIT_RUNTIME`, `OSSUTIL_BIN`, `RUNTIME_ENV`, `IS_TEST`, …). The Secret has
  no file entries today; a file entry such as `source.env` is not a variable
  and would not be declared.
- **Not declared:** the Host's Workspace variables (`HOME`, `WORKSPACE_DIR`,
  `MEDIAKIT_OUTPUT_PATH`, … in `WORKSPACE_ENV`), which are system-reserved and
  always injected; `GEMINI_API_KEY` and `GEMINI_AUDIO_MODEL`, which the old
  SandboxSet referenced as optional keys that `base-secret` does not have.

## init.sh

| Step | Pinned to | Source of the pin |
| --- | --- | --- |
| `libgl1` (OpenCV's `libGL.so.1`) | `1.6.0-1`; its 32 dependencies follow bookworm | 0.3.1 runtime overlay |
| vfs-cli | v0.3.21, archive `13a8125d…`, binary `d4493416…` | `vfs-cli-0.3.21/build.sh`; binary hash from the live `/opt/auto-story/versions.json` |
| mediakit-cli | 0.2.1, archive `8c25ebd7…`, binary `2c962efe…` | `versions.json` |
| ossutil | 2.2.0, archive `9e02837d…`, binary `de09edc5…` | `prepare-ossutil.py` |
| Gemini venv `/opt/auto-story/venv` | `google-genai==2.22.0` with its live closure, then `scenedetect==0.7.1`, `Pillow>=10.4,<13`, `fonttools>=4.50,<5` | live venv `pip freeze` |
| `/etc/pip.conf` | `https://mirrors.aliyun.com/pypi/simple/` | 0.3.1 runtime overlay |
| `/etc/vfs-cli/policy.json` | `{"environment":"test"}`, root, 0644, directory 0755 | ConfigMap `vfs-cli-policy-test-v1` |

The Python layout is the live one. The Gemini SDK is resolved in a fresh venv
first; `acs-base.pth` then exposes the ACS `/opt/venv` packages (NumPy 1.26.4,
OpenCV 4.11.0.86, Pillow 11.3.0, fonttools 4.61.1, …) after the venv's own, and
the remaining packages are installed with everything already visible as
constraints, so nothing from the base is upgraded or shadowed. `python3` and
`pip3` on `PATH` are wrappers for this venv. The venv's own packages must equal
the lock written in the script, or the build fails.

Downloads go only through `fetch`, which checks SHA-256. Re-running the script
on a built image changes nothing and needs no network.
`deploy/builtin-environments.test.mjs` checks the definition's shape, these
pins and that no Whisper is installed.

## Differences from auto-story-v2

Recorded with the inventory diff in
[the verification record](../../../docs/verification/video-production-2026-10-26.md).
In short, the following are not carried over:

- Image `ENV` (proxy, `HOME`, `MEDIAKIT_*`, cache paths). Only PID 1 saw it;
  commands get these from this definition and the Host's Workspace variables.
- `/etc/oma/proxy.env`.
- The build records under `/opt/auto-story` (`versions.json`, `tool-sha256.txt`,
  `*-packages.txt`, `runtime-overlay/`, `vfs-cli-0.3.2x/`). The build manifest
  `/opt/oma/manifest.json` replaces them.
- `/usr/local/bin/auto-story-smoke`. Acceptance runs the repository's copy.
- Offline Whisper: the faster-whisper venv `/opt/auto-story/whisper-venv`, the
  `base.en` / `small` models under `/opt/auto-story/models` (about 630 MB) and
  the legacy helpers `auto-story-transcribe`, `prepare-whisper.py` and
  `whisper-models.json`. Removed by maintainer decision (2026-10-26), so the
  offline transcription of the `story-audio` Skill
  (`welltop-cn/auto-story-skills`), which runs
  `/opt/auto-story/whisper-venv/bin/python3` with those models, is not
  available in video-production.
