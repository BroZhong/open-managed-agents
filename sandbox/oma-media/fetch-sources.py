#!/usr/bin/env python3
"""Stage the pinned FFmpeg source archive, checking its SHA-256.

FFMPEG_SRC may name a local copy (a builder without ffmpeg.org access); it is
checked against the same pin.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
SPEC = json.loads((ROOT / "versions.json").read_text())["ffmpeg"]
SOURCES = ROOT / "sources"
SOURCES.mkdir(exist_ok=True)
archive = SOURCES / Path(urlparse(SPEC["url"]).path).name


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


if not archive.exists() or sha256(archive) != SPEC["sha256"]:
    partial = archive.with_suffix(archive.suffix + ".partial")
    local = os.environ.get("FFMPEG_SRC")
    if local:
        shutil.copyfile(local, partial)
    else:
        subprocess.run(["curl", "--fail", "--location", "--retry", "3", "--connect-timeout", "20",
                        "--max-time", "300", "--output", str(partial), SPEC["url"]], check=True)
    if sha256(partial) != SPEC["sha256"]:
        partial.unlink()
        raise SystemExit("FFmpeg source SHA-256 mismatch")
    partial.replace(archive)
print(f"Verified FFmpeg {SPEC['version']}: {SPEC['sha256']}")
