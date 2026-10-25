# oma-media

The media **Base Image** (ADR-0024): `oma-base` (pinned by digest in
`versions.json`, equal to `../oma-base/image.lock.json`) plus FFmpeg 9.0.1
built from the official source archive (SHA-256 and signing key in
`versions.json`), its runtime libraries and fonts:

- encoders libopenh264, libx264, libx265, libvpx (VP9), libaom (AV1),
  libmp3lame, libopus, libvorbis, libwebp, AAC; filters `subtitles`/`ass`
  (libass) and `drawtext`;
- `fontconfig`, `fonts-dejavu-core`, `fonts-noto-cjk`.

The compiler and `-dev` packages stay in the build stage. Startup (tini),
mirrors, `/home/user` and the empty image `Env` are inherited from oma-base.
Video tools that change often — vfs-cli, mediakit-cli, ossutil, google-genai,
SceneDetect — belong to the `video-production` Environment's init script, not
here.

## Build and publish

On `vfs-dev` (no ffmpeg.org access: `FFMPEG_SRC` names a local copy, checked
against the same SHA-256):

```bash
FFMPEG_SRC=… bash sandbox/oma-media/build.sh
FFMPEG_SRC=… PUSH=1 bash sandbox/oma-media/build.sh
```

Verification runs oma-base's `verify-image.sh` with both smokes: the oma-base
contract, then `smoke.py` here (FFmpeg version and linked libraries, encoders
and filters, OpenH264 and x264 encodes, CJK subtitles burned through libass
from SRT and ASS, Noto CJK and DejaVu fonts, `/home/user` untouched). The
build also checks that the image extends oma-base's layers. The published
digest is the lock in `image.lock.json`.
