#!/usr/bin/env bash
# Built-in Environment video-production (env_video_production): ADR-0024, #305.
#
# The image builder runs this once per build, as root in /home/user on the
# oma-media Base Image (FFmpeg 9.0.1, CJK fonts, Node 22, Pi tool runtime,
# rg/fd), with `bash -euo pipefail` after sourcing the bind-mounted build.env.
# build.env carries HTTP(S)_PROXY for the cluster's sing-box and an explicit
# NO_PROXY: GitHub and Hugging Face need the proxy, Aliyun mirrors stay
# direct. Nothing here writes proxy settings into the image.
#
# Every version and checksum reproduces the live auto-story-v2 0.3.3 image
# (oma-sandbox@sha256:67a46af6…, recipe on branch codex/sandbox-runtime-0.3.1).
# README.md lists the sources and what deliberately differs.
set -euo pipefail

# --- Pinned inputs -----------------------------------------------------------
# Each *_URL is checked against *_SHA256; the installed file against
# *_BINARY_SHA256.
VFS_CLI_URL=https://github.com/welltop-cn/vfs-cli-dist/releases/download/v0.3.21/vfs-cli_v0.3.21_linux_amd64.tar.gz
VFS_CLI_SHA256=13a8125d6083d4747fe74b6d74142121c8c272c10f77b23e5b22334ab48abacb
VFS_CLI_BINARY_SHA256=d4493416139db06f69cbaffd7edf80b64355fd98e77c7f904a06da737295e020
MEDIAKIT_CLI_URL=https://github.com/volcengine/mediakit-cli/releases/download/v0.2.1/mediakit-cli_0.2.1_linux_amd64.tar.gz
MEDIAKIT_CLI_SHA256=8c25ebd7c9446813dabb27700a9d4357c7d2325e528fe9caab31696aa1326987
MEDIAKIT_CLI_BINARY_SHA256=2c962efef686307e8e839face4a347634e939b84b2a4df5caf292b035e5f96ca
OSSUTIL_URL=https://gosspublic.alicdn.com/ossutil/v2/2.2.0/ossutil-2.2.0-linux-amd64.zip
OSSUTIL_SHA256=9e02837d806cfe976ae6c1fc22557d8e0a394ca6d298b45fb9f48a360d3a67f4
OSSUTIL_BINARY_SHA256=de09edc5649d00bf9495040b09c70a52174f7ae6b812097411f46def16d47c2f
LIBGL1_VERSION=1.6.0-1
PYPI_INDEX=https://mirrors.aliyun.com/pypi/simple/
VFS_CLI_POLICY='{"environment":"test"}'

BASE_PYTHON=/opt/venv/bin/python3          # ACS Jupyter environment; never installed into
GEMINI_VENV=/opt/auto-story/venv           # python3 / pip3 on PATH
WHISPER_VENV=/opt/auto-story/whisper-venv  # offline subtitles of the story-audio Skill
MODELS=/opt/auto-story/models

work="$(mktemp -d)"
user_home="$(mktemp -d)"
trap 'rm -rf "$work" "$user_home"' EXIT

step() { printf '\n== video-production: %s\n' "$*"; }

# fetch URL SHA256 FILE: the only network download; fails unless the checksum matches.
fetch() {
  curl -fsSL --retry 5 --retry-all-errors --connect-timeout 20 \
    --speed-limit 10240 --speed-time 60 --max-time 1800 -o "$3" "$1" </dev/null
  echo "$2  $3" | sha256sum -c --strict -
}

# installed NAME SHA256: /usr/local/bin/NAME is already the pinned binary.
installed() {
  [[ -f "/usr/local/bin/$1" ]] && echo "$2  /usr/local/bin/$1" | sha256sum -c --status --strict -
}

# install_binary FILE SHA256 NAME: verify an extracted binary, install it root-owned.
install_binary() {
  echo "$2  $1" | sha256sum -c --strict -
  install -o root -g root -m 0755 "$1" "/usr/local/bin/$3"
}

pip_in() { local venv="$1"; shift; "$venv/bin/python3" -I -m pip --disable-pip-version-check --no-input "$@"; }
site_packages() { "$1/bin/python3" -I -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])'; }
new_venv() { [[ -x "$1/bin/python3" ]] || "$BASE_PYTHON" -m venv "$1"; }

# constrained_install VENV LOCK REQUIREMENT...: every package the venv already
# sees is a constraint, so nothing present (numpy, OpenCV, Pillow, …) changes.
constrained_install() {
  local venv="$1" lock="$2"
  shift 2
  pip_in "$venv" list --format=freeze > "$work/installed.txt"
  pip_in "$venv" install --no-cache-dir --only-binary :all: --progress-bar off \
    -c "$work/installed.txt" -c "$lock" "$@"
}

# check_venv VENV LOCK: the venv's own packages are exactly the lock.
check_venv() {
  pip_in "$1" freeze --all --path "$(site_packages "$1")" | LC_ALL=C sort -f > "$work/actual.txt"
  LC_ALL=C sort -f "$2" | diff -u - "$work/actual.txt"
}

# --- System packages ---------------------------------------------------------
step "apt libgl1 ${LIBGL1_VERSION} (OpenCV's libGL.so.1)"
if [[ "$(dpkg-query -W -f='${db:Status-Abbrev}${Version}' libgl1 2>/dev/null || true)" != "ii ${LIBGL1_VERSION}" ]]; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "libgl1=${LIBGL1_VERSION}"
  apt-get clean
fi

step "pip index ${PYPI_INDEX}"
"$BASE_PYTHON" -I - "$PYPI_INDEX" <<'PY'
import configparser, os, sys
path, index = "/etc/pip.conf", sys.argv[1]
if not os.path.exists(path):
    open(path, "w").write(f"[global]\nindex-url = {index}\n")
else:
    config = configparser.ConfigParser()
    config.read(path)
    if not config.has_section("global"):
        config.add_section("global")
    if config["global"].get("index-url") != index:
        config["global"]["index-url"] = index
        with open(path, "w") as f:
            config.write(f)
PY
chmod 0644 /etc/pip.conf

# --- Command-line tools ------------------------------------------------------
step "vfs-cli v0.3.21"
if ! installed vfs-cli "$VFS_CLI_BINARY_SHA256"; then
  fetch "$VFS_CLI_URL" "$VFS_CLI_SHA256" "$work/vfs-cli.tar.gz"
  tar -xzf "$work/vfs-cli.tar.gz" -C "$work" --no-same-owner vfs-cli
  install_binary "$work/vfs-cli" "$VFS_CLI_BINARY_SHA256" vfs-cli
fi

step "mediakit-cli 0.2.1"
if ! installed mediakit-cli "$MEDIAKIT_CLI_BINARY_SHA256"; then
  fetch "$MEDIAKIT_CLI_URL" "$MEDIAKIT_CLI_SHA256" "$work/mediakit-cli.tar.gz"
  tar -xzf "$work/mediakit-cli.tar.gz" -C "$work" --no-same-owner mediakit-cli
  install_binary "$work/mediakit-cli" "$MEDIAKIT_CLI_BINARY_SHA256" mediakit-cli
fi

step "ossutil 2.2.0"
if ! installed ossutil "$OSSUTIL_BINARY_SHA256"; then
  fetch "$OSSUTIL_URL" "$OSSUTIL_SHA256" "$work/ossutil.zip"
  "$BASE_PYTHON" -I -c 'import sys, zipfile; open(sys.argv[3], "wb").write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))' \
    "$work/ossutil.zip" ossutil-2.2.0-linux-amd64/ossutil "$work/ossutil"
  install_binary "$work/ossutil" "$OSSUTIL_BINARY_SHA256" ossutil
fi

# --- Python: Gemini SDK, SceneDetect, Pillow, fonttools ----------------------
# As in the live image: an isolated venv resolves the Gemini SDK on its own
# (pinned to the live closure), then sees the ACS scientific stack through
# acs-base.pth, and SceneDetect/Pillow/fonttools are installed constrained by
# everything already visible. python3/pip3 on PATH are wrappers for this venv.
step "Gemini venv ${GEMINI_VENV}"
cat > "$work/gemini.lock" <<'LOCK'
annotated-types==0.8.0
anyio==4.15.1
certifi==2026.7.22
cffi==2.1.1
charset-normalizer==3.5.1
cryptography==50.0.1
distro==1.9.0
google-auth==2.58.0
google-genai==2.22.0
h11==0.16.0
httpcore==1.0.9
httpx==0.28.1
idna==3.19
pip==23.0.1
pyasn1==0.6.4
pyasn1_modules==0.4.2
pycparser==3.0
pydantic==2.13.5
pydantic_core==2.46.5
requests==2.34.2
scenedetect==0.7.1
setuptools==66.1.1
sniffio==1.3.1
tenacity==9.1.4
typing-inspection==0.4.4
typing_extensions==4.16.0
urllib3==2.7.0
websockets==16.1.1
LOCK
mkdir -p /opt/auto-story
new_venv "$GEMINI_VENV"
constrained_install "$GEMINI_VENV" "$work/gemini.lock" google-genai==2.22.0
printf '%s\n' "$(site_packages /opt/venv)" > "$(site_packages "$GEMINI_VENV")/acs-base.pth"
constrained_install "$GEMINI_VENV" "$work/gemini.lock" \
  scenedetect==0.7.1 'Pillow>=10.4,<13' 'fonttools>=4.50,<5'
check_venv "$GEMINI_VENV" "$work/gemini.lock"
printf '#!/bin/sh\nexec %s/bin/python3 "$@"\n' "$GEMINI_VENV" > "$work/python3"
printf '#!/bin/sh\nexec %s/bin/python3 -m pip "$@"\n' "$GEMINI_VENV" > "$work/pip3"
install -o root -g root -m 0755 "$work/python3" "$work/pip3" /usr/local/bin/
ln -sfn /usr/local/bin/python3 /usr/local/bin/python
ln -sfn /usr/local/bin/pip3 /usr/local/bin/pip

# --- Python: offline Whisper for the story-audio Skill -----------------------
# The Skill runs /opt/auto-story/whisper-venv/bin/python3 with local models
# from /opt/auto-story/models/{base.en,small}; it never downloads at run time.
step "Whisper venv ${WHISPER_VENV}"
cat > "$work/whisper.lock" <<'LOCK'
PyYAML==6.0.3
anyio==4.15.1
av==18.1.0
certifi==2026.7.22
click==8.5.0
ctranslate2==4.8.2
faster-whisper==1.2.1
filelock==3.32.7
flatbuffers==25.12.19
fsspec==2026.7.0
h11==0.16.0
hf-xet==1.6.0
httpcore==1.0.9
httpx==0.28.1
huggingface_hub==1.31.0
idna==3.19
numpy==1.26.4
onnxruntime==1.30.0
packaging==26.3
pip==23.0.1
protobuf==7.36.1
setuptools==66.1.1
tokenizers==0.23.2
tqdm==4.70.1
typing_extensions==4.16.0
LOCK
new_venv "$WHISPER_VENV"
constrained_install "$WHISPER_VENV" "$work/whisper.lock" faster-whisper==1.2.1 ctranslate2==4.8.2 numpy==1.26.4
check_venv "$WHISPER_VENV" "$work/whisper.lock"

step "Whisper models ${MODELS}"
install -d -o root -g root -m 0755 "$MODELS" "$MODELS/base.en" "$MODELS/small"
while read -r model repository revision file sha256; do
  dest="$MODELS/$model/$file"
  if [[ -f "$dest" ]] && echo "$sha256  $dest" | sha256sum -c --status --strict -; then
    continue
  fi
  fetch "https://huggingface.co/$repository/resolve/$revision/$file" "$sha256" "$work/model.part"
  install -o root -g root -m 0644 "$work/model.part" "$dest"
done <<'MODELS'
base.en Systran/faster-whisper-base.en 3d3d5dee26484f91867d81cb899cfcf72b96be6c README.md 0360e1518671daf4064d44121ad1c4bbb0446dd5b0f8c724c8d3132fd33a1540
base.en Systran/faster-whisper-base.en 3d3d5dee26484f91867d81cb899cfcf72b96be6c config.json f3bc3821e9fc76a27bae538e11ae5b677dcdd352b4600429ce7951d398569aeb
base.en Systran/faster-whisper-base.en 3d3d5dee26484f91867d81cb899cfcf72b96be6c model.bin 2a166925539a16005f14ff328359f9b9adb9dc4fb631bb3b227526862e93e2ef
base.en Systran/faster-whisper-base.en 3d3d5dee26484f91867d81cb899cfcf72b96be6c tokenizer.json 929c5252409436dce1b38a75d1abbcb5e132d170d8e324e4e04ed915fa2d22df
base.en Systran/faster-whisper-base.en 3d3d5dee26484f91867d81cb899cfcf72b96be6c vocabulary.txt ff77588746d3a2595d32ab5b69ffd7b95ce2441ac57533cb66fc3eb575a115cf
small Systran/faster-whisper-small 536b0662742c02347bc0e980a01041f333bce120 README.md 329373481008c7c38654aff8ecdcf0163c211557cc7ba8e2ef6f2f84b4f75ec8
small Systran/faster-whisper-small 536b0662742c02347bc0e980a01041f333bce120 config.json b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828
small Systran/faster-whisper-small 536b0662742c02347bc0e980a01041f333bce120 model.bin 3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671
small Systran/faster-whisper-small 536b0662742c02347bc0e980a01041f333bce120 tokenizer.json fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab
small Systran/faster-whisper-small 536b0662742c02347bc0e980a01041f333bce120 vocabulary.txt 34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913
MODELS

# --- vfs-cli policy ----------------------------------------------------------
# Same bytes as ConfigMap sandbox-system/vfs-cli-policy-test-v1, which the warm
# pool no longer mounts; root-owned so the ordinary user cannot change it.
step "vfs-cli policy /etc/vfs-cli/policy.json"
install -d -o root -g root -m 0755 /etc/vfs-cli
printf '%s' "$VFS_CLI_POLICY" > "$work/policy.json"
install -o root -g root -m 0644 "$work/policy.json" /etc/vfs-cli/policy.json

# --- Self-check as the ordinary user -----------------------------------------
step "check as user"
cat > "$user_home/check.sh" <<'CHECK'
set -eu
python3 -I -c 'import ctypes, cv2, fontTools, google.genai, PIL, scenedetect; ctypes.CDLL("libGL.so.1"); assert scenedetect.__version__ == "0.7.1"'
/opt/auto-story/whisper-venv/bin/python3 -I -c 'import ctranslate2, faster_whisper'
vfs-cli --version
MEDIAKIT_SURFACE=skill MEDIAKIT_RUNTIME=pi-agent mediakit-cli --version
ossutil version
test "$(cat /etc/vfs-cli/policy.json)" = '{"environment":"test"}'
! test -w /etc/vfs-cli/policy.json
CHECK
chown -R user:user "$user_home"
su -s /bin/sh user -c "cd $user_home && exec env -i HOME=$user_home PATH=/usr/local/bin:/usr/bin:/bin sh $user_home/check.sh"
step "done"
