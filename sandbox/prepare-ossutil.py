#!/usr/bin/env python3
"""Stage the pinned official Linux amd64 ossutil binary for sandbox builds."""

import hashlib
import io
import os
from pathlib import Path
import sys
import urllib.request
import zipfile


VERSION = "2.2.0"
URL = f"https://gosspublic.alicdn.com/ossutil/v2/{VERSION}/ossutil-{VERSION}-linux-amd64.zip"
# SHA-256 of the official HTTPS archive and its binary, verified 2026-09-16.
ARCHIVE_SHA256 = "9e02837d806cfe976ae6c1fc22557d8e0a394ca6d298b45fb9f48a360d3a67f4"
BINARY_SHA256 = "de09edc5649d00bf9495040b09c70a52174f7ae6b812097411f46def16d47c2f"


def main():
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "bin")
    target.mkdir(parents=True, exist_ok=True)
    destination = target / "ossutil"
    source = os.environ.get("OSSUTIL_SRC")
    if source:
        binary = Path(source).read_bytes()
    elif destination.exists():
        binary = destination.read_bytes()
    else:
        with urllib.request.urlopen(URL, timeout=90) as response:
            archive = response.read()
        if hashlib.sha256(archive).hexdigest() != ARCHIVE_SHA256:
            raise RuntimeError("ossutil: pinned release archive checksum mismatch")
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            binary = bundle.read(f"ossutil-{VERSION}-linux-amd64/ossutil")
    if hashlib.sha256(binary).hexdigest() != BINARY_SHA256:
        raise RuntimeError("ossutil: pinned release binary checksum mismatch")
    destination.write_bytes(binary)
    destination.chmod(0o755)
    print(f"Pinned Linux amd64 ossutil {VERSION} verified")


if __name__ == "__main__":
    main()
