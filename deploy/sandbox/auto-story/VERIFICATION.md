# Image verification — 2026-09-07

## auto-story 0.1.1 preparation

The 0.1.1 recipe pins VFS CLI v0.3.14 and retains MediaKit 0.2.1, Gemini SDK
2.22.0, FFmpeg and the inherited OpenMontage runtime. The incremental build
selects the published 0.1.0 digest below as `RUNTIME_IMAGE`; the normal full
runtime build remains available.

The new offline audio checks passed against the local SeedAudio CLI before
release-image construction:

- Exact `seed-audio-1.0` schema, enabled subtitles and audio reference limits.
- Pure-text audio generation request preview with unchanged Unicode prompt.
- Audio Resource type discovery and URL/local-WAV registration previews.
- Successful dry-run exit code 10; no real token or endpoint used.

The release image's verification and publication evidence will be recorded
after the v0.3.14 release binary has been staged and the image built.

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

## Publication and live acceptance

After deployment authorization, this exact image was pushed to the existing
Shanghai registry and deployed by immutable digest. The auto-story SandboxSet
became available. Real Agent/Skill/Cloud acceptance subsequently passed; see
[the live acceptance report](../../../docs/auto-story-e2e-2026-09-07.md).
