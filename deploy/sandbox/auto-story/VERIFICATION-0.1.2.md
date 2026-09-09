# Image verification records

## auto-story 0.1.2 — 2026-09-09

Built and pushed on `vfs-dev` from commit
`d6460a20c0e1a09f61601594bcd4e91dca68ab43` for Linux amd64:
`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:auto-story-0.1.2`.
Published digest:
`sha256:dd6437954752ff8527225bd2198245b89c75598a43c2e17d652d3d43279a4a72`.

The image reuses the exact 0.1.1 runtime digest below, retaining VFS CLI
v0.3.14, MediaKit 0.2.1, Gemini SDK 2.22.0, FFmpeg and OpenMontage. It adds
upstream rg 15.1.0 and fd 10.4.2, matching the native local/cloud parity tests.
Official GitHub release archive hashes were verified before extraction; the
Dockerfile independently checks the exact binary hashes:

- rg: `ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2`.
- fd: `0dff4a420feb3e57fd1d4402d3e29f46115aa38d962467d2f3b72e7439d3ada8`.

Both the build-time smoke and separate acceptance container passed, including
the retained media, audio dry-run and environment-injection checks documented
for 0.1.1 below. Additional checks exercise rg's Unicode regex, brace globs
and `.gitignore`, plus fd's recursive basename and path globs. Separate image
acceptance runs as `user`, with no network, no host mounts and a minimal PATH.

The published digest was applied to the auto-story SandboxSet on 2026-09-09;
its replacement warm Pod became Running and Ready. Sandbox image availability
and shared Host/Agent acceptance are separate checks. Current deployment and
end-to-end results are recorded in the
[2026-09-09 release verification](../../../docs/pi-native-search-release-verification-2026-09-09.md).

Build logs and the three-template image receipt are retained locally under
`/private/tmp/oma-pi-search-release-builds-20260909/`. The earlier sections
below preserve their historical verification results.

## auto-story 0.1.1 — 2026-09-07

Built and pushed on `vfs-dev` for Linux amd64:
`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:auto-story-0.1.1`.
Published digest:
`sha256:bdf9bdc74ad8e1f289b3993bb8154e388a505a43c3e24d47cbaae874e5ad49f4`.

The recipe was committed as `eee6247d7333d55ab19746d80a41c8b2db43a11f`
on `codex/auto-story-narration-test`. Dockerfile SHA-256:
`f182dfdf3889e42d7f727eb5cdc5295546556f57b376221d82232ba13cfa422d`.
The release uses the published 0.1.0 digest below as `RUNTIME_IMAGE`, retaining
MediaKit 0.2.1, Gemini SDK 2.22.0, FFmpeg and the OpenMontage runtime. An explicit
Docker inspection confirmed that all parent filesystem layers, ENTRYPOINT and
CMD are preserved. The normal full runtime build remains available.

The VFS binary came from the public v0.3.14 Linux amd64 release, built from
`ac531bc24f13ed9db1bd4ecc42ab6ddfb9377dc5` with `CGO_ENABLED=0` and
`vcs.modified=false`. Its archive matched the published checksum:

- Release archive SHA-256: `bbce352f858fafd3116c1849a96260982091846f09b15185e573c5b6af08831f`.
- Extracted binary SHA-256: `213e16ad0e717252e410ee52aa344b55269543b2ca9e481b4827a959fe6a1fdb`.

Both the build-time smoke and separate image acceptance passed. The latter
ran with `--network none`, no host mounts, user `user`, cwd `/home/user`, and
the minimal PATH `/usr/local/bin:/usr/bin:/bin`. Verified:

- VFS CLI v0.3.14, embedded Skill discovery, MediaKit 0.2.1 and Gemini SDK 2.22.0.
- Writable Workspace and a real H.264/AAC fixture with spaces in its filename.
- FFmpeg generation, ffprobe streams and actual MediaKit local metadata.
- Gemini Files upload/get/delete and Interactions SDK methods, without API calls.
- Injected `AUTO_STORY_SMOKE_VALUE` presence, without printing its value.
- Exact `seed-audio-1.0` schema, enabled subtitles and audio reference limits.
- Pure-text audio generation request preview with unchanged Unicode prompt.
- Audio Resource type discovery and URL/local-WAV registration previews.
- Successful dry-run exit code 10; no real token or endpoint used.

The build log is retained locally at
`/private/tmp/oma-auto-story/sandbox-0.1.1-build.log`. The SandboxSet manifest
now references the published 0.1.1 digest. Applying it and exercising real
audio generation in a fresh Agent Session are separate deployment acceptance
steps; the offline checks above do not establish cloud generation success.

The exact 0.1.1 digest was subsequently applied to the test auto-story
SandboxSet. Session `sess_HFJ2dDQcgt3GrsT27Df8B` ran on this runtime (initial
Pod `auto-story-hqn4j`) and generated a real 27-second SeedAudio master,
Resource `103932`, plus GPT Image 2 reference `103933`. Its 14-second and
13-second WAV slices were uploaded and registered as audio Resources `103935`
and `103934`. This supplies live evidence for generation and audio uploads;
the complete story acceptance is recorded in
[the narration report](../../../docs/auto-story-narration-e2e-2026-09-07.md).

## auto-story 0.1.0

Built on `vfs-dev` for Linux amd64. The image is locally available there as
`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:auto-story-0.1.0`.
Local manifest/image ID:
`sha256:96ab935b6d775aeac5cd8a3f0c8fc5f1faf1d715f1345ba8ab57bc8467b0fd3f`.
This build was not pushed and its SandboxSet was not applied during image
verification; publication and real Agent acceptance are separate steps.

The local and remote Dockerfiles have identical SHA-256:
`b959a3876213e7ebbf18d17cd5e1ea05601ec0de645c8dc478134e5683997f4a`.
All production parent filesystem layers, ENTRYPOINT and CMD are preserved.

Passed both during build and in a separate container with no network, no host
mounts, user `user`, cwd `/home/user`, and a minimal non-login PATH:

- Writable Workspace and temporary-file cleanup.
- Real one-second 160×90 H.264/AAC fixture, with spaces in its filename.
- FFmpeg generation and ffprobe video/audio stream verification.
- MediaKit 0.2.1 local metadata, including dimensions, AAC codec and duration.
- VFS CLI v0.3.13 version and embedded Skill discovery.
- Official Gemini SDK 2.22.0 Files upload/get/delete and Interactions methods.
- Runtime environment-variable presence without exposing its value.

An additional explicit `env -i HOME=/home/user
PATH=/usr/local/bin:/usr/bin:/bin python3` check passed as `user`, confirming
`sys.prefix == "/opt/auto-story/venv"` and successful SDK imports. Python uses
an exec launcher because a symlink outside a venv can lose `pyvenv.cfg`
discovery. Build-time checks explicitly enter `/home/user`, matching the
Environment Spec; the parent's `/root` working directory is inaccessible to
the runtime user and causes MediaKit to reject `stat .`.

These are image and local-processing checks. They do not claim remote VFS,
MediaKit cloud, Gemini authentication, or a provisioned Agent Session passed.

### 0.1.0 publication and live acceptance

After deployment authorization, this exact image was pushed to the existing
Shanghai registry and deployed by immutable digest. The auto-story SandboxSet
became available. Real Agent/Skill/Cloud acceptance subsequently passed; see
[the live acceptance report](../../../docs/auto-story-e2e-2026-09-07.md).
