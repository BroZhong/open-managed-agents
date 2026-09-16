#!/usr/bin/env python3
"""Stage the exact Linux amd64 search releases used by native Pi parity checks."""

import hashlib
import os
from pathlib import Path
import struct
import sys
import tarfile
import tempfile
import urllib.request


# Archive hashes match the publishers' GitHub release asset metadata (2026-09-09).
# Binary hashes are derived from those verified archives, not the local PATH.
RELEASES = {
    "rg": {
        "url": "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz",
        "archive_sha256": "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
        "member": "ripgrep-15.1.0-x86_64-unknown-linux-musl/rg",
        "binary_sha256": "ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2",
    },
    "fd": {
        "url": "https://github.com/sharkdp/fd/releases/download/v10.4.2/fd-v10.4.2-x86_64-unknown-linux-gnu.tar.gz",
        "archive_sha256": "def59805cd14b5651b68990855f426ad087f3b96881296d963910431ba3143c8",
        "member": "fd-v10.4.2-x86_64-unknown-linux-gnu/fd",
        "binary_sha256": "0dff4a420feb3e57fd1d4402d3e29f46115aa38d962467d2f3b72e7439d3ada8",
    },
}


def verify(binary, release, name):
    if (len(binary) < 20 or binary[:6] != b"\x7fELF\x02\x01"
            or struct.unpack("<H", binary[18:20])[0] != 62):
        raise RuntimeError(f"{name}: expected a Linux amd64 ELF binary")
    if hashlib.sha256(binary).hexdigest() != release["binary_sha256"]:
        raise RuntimeError(f"{name}: pinned release binary checksum mismatch")


def main():
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "bin")
    target.mkdir(parents=True, exist_ok=True)
    for name, release in RELEASES.items():
        source = os.environ.get(f"{name.upper()}_SRC")
        destination = target / name
        if source:
            binary = Path(source).read_bytes()
        elif destination.exists():
            binary = destination.read_bytes()
        else:
            with tempfile.TemporaryDirectory(prefix=f"oma-{name}-release-") as temp:
                archive = Path(temp) / "release.tar.gz"
                with urllib.request.urlopen(release["url"], timeout=90) as response:
                    archive.write_bytes(response.read())
                if hashlib.sha256(archive.read_bytes()).hexdigest() != release["archive_sha256"]:
                    raise RuntimeError(f"{name}: pinned release archive checksum mismatch")
                with tarfile.open(archive) as bundle:
                    binary = bundle.extractfile(release["member"]).read()
        verify(binary, release, name)
        destination.write_bytes(binary)
        destination.chmod(0o755)
    print("Pinned Linux amd64 rg 15.1.0 and fd 10.4.2 verified")


if __name__ == "__main__":
    main()
