#!/usr/bin/env python3
"""Stage versioned upstream archives, checking SHA-256 before extracting tools."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
VERSIONS = json.loads((ROOT / "versions.json").read_text())
SOURCES = ROOT / "sources"
BIN = ROOT / "bin"
SOURCES.mkdir(exist_ok=True)
BIN.mkdir(exist_ok=True)

for name in ("ffmpeg", "vfs-cli", "mediakit-cli"):
    spec = VERSIONS[name]
    override = os.environ.get(name.upper().replace("-", "_") + "_SRC")
    if name != "ffmpeg" and override:
        binary = Path(override).read_bytes()
        if hashlib.sha256(binary).hexdigest() != spec["binarySha256"]:
            raise SystemExit(f"Pinned release binary SHA-256 mismatch: {name}")
        (BIN / name).write_bytes(binary)
        (BIN / name).chmod(0o755)
        print(f"Verified local {name} {spec['version']}", flush=True)
        continue
    archive = SOURCES / Path(urlparse(spec["url"]).path).name
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != spec["sha256"]:
        partial = archive.with_suffix(archive.suffix + ".partial")
        subprocess.run([
            "curl", "--fail", "--location", "--retry", "3", "--connect-timeout", "20",
            "--max-time", "300", "--output", str(partial), spec["url"],
        ], check=True)
        if hashlib.sha256(partial.read_bytes()).hexdigest() != spec["sha256"]:
            partial.unlink()
            raise SystemExit(f"SHA-256 mismatch: {name}")
        partial.replace(archive)
    print(f"Verified {name} {spec['version']}: {spec['sha256']}", flush=True)
    if name != "ffmpeg":
        with tarfile.open(archive) as tar:
            matches = [m for m in tar.getmembers() if m.isfile() and Path(m.name).name == name]
            if len(matches) != 1:
                raise SystemExit(f"Expected exactly one {name} binary in {archive}")
            with tar.extractfile(matches[0]) as source, (BIN / name).open("wb") as dest:
                shutil.copyfileobj(source, dest)
        (BIN / name).chmod(0o755)
        if hashlib.sha256((BIN / name).read_bytes()).hexdigest() != spec["binarySha256"]:
            raise SystemExit(f"Binary SHA-256 mismatch: {name}")

subprocess.run(["python3", str(ROOT.parent / "prepare-search-binaries.py"), str(BIN)], check=True)
