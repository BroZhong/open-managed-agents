"""Print a sandbox image's preinstalled inventory as JSON (no network, no secrets).

On an amd64 Docker host that has pulled IMAGE:

    python3 -I sandbox-inventory.py IMAGE > inventory.json

This records the image config, then reruns this file inside the image as root
with `--network none` and the ACS Jupyter interpreter (/opt/venv/bin/python3),
which every image derived from the ACS code-interpreter base has. The same
script captures the live auto-story-v2 baseline and a built Environment image,
so the acceptance diff compares like with like.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

PYTHON_PROBE = r"""
import importlib.metadata as m, json, os, sys
seen = {}
for d in m.distributions():
    name = (d.metadata.get('Name') or '').lower().replace('_', '-')
    if name and name not in seen:
        seen[name] = {'version': d.version, 'location': str(d.locate_file(''))}
print(json.dumps({'executable': sys.executable, 'prefix': sys.prefix, 'version': sys.version.split()[0],
                  'path': [p for p in sys.path if p], 'packages': dict(sorted(seen.items()))}))
"""

# name -> argv; the first line containing a version number is recorded.
BINARIES = {
    "vfs-cli": ["vfs-cli", "--version"],
    "mediakit-cli": ["mediakit-cli", "--version"],
    "ossutil": ["ossutil", "version"],
    "ffmpeg": ["ffmpeg", "-version"],
    "ffprobe": ["ffprobe", "-version"],
    "node": ["node", "--version"],
    "npm": ["npm", "--version"],
    "rg": ["rg", "--version"],
    "fd": ["fd", "--version"],
    "tini": ["tini", "--version"],
    "jq": ["jq", "--version"],
    "git": ["git", "--version"],
    "curl": ["curl", "--version"],
    "unzip": ["unzip", "-v"],
    "ps": ["ps", "--version"],
    "python3": ["python3", "--version"],
    "pip3": ["pip3", "--version"],
    "jupyter": ["jupyter", "--version"],
    "java": ["java", "-version"],
    "deno": ["deno", "--version"],
    "R": ["R", "--version"],
    "fc-list": ["fc-list", "--version"],
}

TEXT_FILES = ["/etc/pip.conf", "/etc/oma/proxy.env", "/opt/auto-story/versions.json",
              "/opt/auto-story/requirements.txt", "/opt/auto-story/whisper-requirements.txt",
              "/opt/auto-story/tool-sha256.txt", "/opt/oma/manifest.json"]
HASHED_FILES = ["/root/.jupyter/start-up.sh", "/opt/oma-pi-tools/package-lock.json",
                "/usr/local/bin/auto-story-smoke", "/opt/auto-story/runtime-overlay/smoke.py",
                "/opt/oma-pi-tools/smoke.mjs"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def run(argv, **kw):
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=60, **kw)
        return r.returncode, (r.stdout + r.stderr)
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, str(e)


def binaries():
    out = {}
    env = dict(os.environ, MEDIAKIT_SURFACE="skill", MEDIAKIT_RUNTIME="pi-agent", HOME="/tmp/oma-inventory-home")
    for name, argv in BINARIES.items():
        path = shutil.which(argv[0])
        if not path:
            out[name] = None
            continue
        code, text = run(argv, env=env)
        line = next((l.strip() for l in text.splitlines() if re.search(r"\d+\.\d+", l)), text.strip()[:200])
        real = os.path.realpath(path)
        out[name] = {"path": path, "realpath": real, "version": line, "exit": code,
                     "sha256": sha256(real) if os.path.isfile(real) else None}
    return out


def python_envs():
    candidates = ["/usr/local/bin/python3", "/opt/venv/bin/python3", "/usr/bin/python3"]
    candidates += sorted(str(p) for p in Path("/opt").glob("*/*/bin/python3"))
    candidates += sorted(str(p) for p in Path("/opt").glob("*/bin/python3"))
    out = {}
    for exe in dict.fromkeys(candidates):
        if not os.path.exists(exe):
            continue
        code, text = run([exe, "-I", "-c", PYTHON_PROBE])
        entry = {"realpath": os.path.realpath(exe)}
        if code == 0:
            entry.update(json.loads(text.strip().splitlines()[-1]))
        else:
            entry["error"] = text[-500:]
        code, text = run([exe, "-I", "-m", "pip", "freeze", "--all", "--disable-pip-version-check"])
        entry["pipFreeze"] = sorted(l for l in text.splitlines() if l and not l.startswith("WARNING")) if code == 0 else None
        if os.path.isfile(exe) and os.path.getsize(exe) < 4096:
            try:
                entry["wrapper"] = Path(exe).read_text()
            except UnicodeDecodeError:
                pass
        out[exe] = entry
    return out


def dpkg():
    code, text = run(["dpkg-query", "-W", "-f=${binary:Package}\t${Version}\t${db:Status-Abbrev}\n"])
    rows = [l.split("\t") for l in text.splitlines() if l.count("\t") == 2]
    return {p: v for p, v, s in rows if s.startswith("ii")}


def npm():
    out = {}
    # Read global package directories directly: the image's NPM_CONFIG_PREFIX
    # points at a per-user prefix that need not exist.
    for root in ["/usr/lib/node_modules", "/usr/local/lib/node_modules"]:
        found = {}
        for manifest in sorted(Path(root).glob("*/package.json")) + sorted(Path(root).glob("@*/*/package.json")):
            try:
                data = json.loads(manifest.read_text())
                found[data.get("name") or manifest.parent.name] = data.get("version")
            except ValueError:
                found[manifest.parent.name] = None
        out[root] = found if Path(root).is_dir() else None
    lock = Path("/opt/oma-pi-tools/package-lock.json")
    if lock.exists():
        packages = json.loads(lock.read_text()).get("packages", {})
        out["/opt/oma-pi-tools"] = {"direct": packages.get("", {}).get("dependencies"),
                                    "lockedPackages": len(packages) - 1,
                                    "pi-coding-agent": packages.get("node_modules/@earendil-works/pi-coding-agent", {}).get("version")}
    return out


def listing(root):
    p = Path(root)
    if not p.is_dir():
        return None
    out = {}
    for child in sorted(p.iterdir()):
        st = child.lstat()
        kind = "link" if child.is_symlink() else "dir" if child.is_dir() else "file"
        item = {"kind": kind, "mode": oct(st.st_mode & 0o7777), "uid": st.st_uid, "gid": st.st_gid}
        if kind == "link":
            item["target"] = os.readlink(child)
        elif kind == "file":
            item["size"] = st.st_size
            item["sha256"] = sha256(child)
        out[child.name] = item
    return out


def files():
    out = {"text": {}, "sha256": {}}
    for f in TEXT_FILES:
        out["text"][f] = Path(f).read_text() if Path(f).is_file() else None
    for f in HASHED_FILES:
        out["sha256"][f] = sha256(f) if Path(f).is_file() else None
    out["profile.d"] = {p.name: p.read_text() for p in sorted(Path("/etc/profile.d").glob("*"))
                        if p.is_file()} if Path("/etc/profile.d").is_dir() else None
    for d in ["/usr/local/bin", "/opt", "/opt/auto-story", "/etc/vfs-cli", "/etc/oma", "/opt/oma", "/home/user"]:
        out.setdefault("listings", {})[d] = listing(d)
    return out


def home_ownership():
    not_user = []
    total = 0
    for current, dirs, names in os.walk("/home/user"):
        for name in dirs + names:
            total += 1
            st = os.lstat(os.path.join(current, name))
            if st.st_uid != 1000 or st.st_gid != 1000:
                not_user.append(os.path.relpath(os.path.join(current, name), "/home/user"))
    prefixes = {}
    for p in not_user:
        key = "/".join(p.split("/")[:2])
        prefixes[key] = prefixes.get(key, 0) + 1
    return {"entries": total, "notOwnedByUser": len(not_user), "notOwnedByUserByPrefix": dict(sorted(prefixes.items()))}


def fonts():
    code, text = run(["fc-list", "--format", "%{family[0]}\n"])
    families = sorted(set(l for l in text.splitlines() if l)) if code == 0 else None
    return {"families": families, "count": len(families) if families else 0}


def login_env():
    # What a command sees from the image alone (envd runs bash -l -c with only create/command envs).
    code, text = run(["su", "-s", "/bin/bash", "user", "-c",
                      "cd /home/user && env -i HOME=/home/user PATH=/usr/local/bin:/usr/bin:/bin bash -l -c env"])
    if code != 0:
        return {"error": text[-500:]}
    return dict(sorted(l.split("=", 1) for l in text.splitlines() if "=" in l and not l.startswith("_=")))


def users():
    code, text = run(["getent", "passwd", "user"])
    return {"passwd": text.strip(), "id": run(["id", "user"])[1].strip()}


def inside():
    return {
        "schema": 1,
        "dpkg": dpkg(),
        "python": python_envs(),
        "npm": npm(),
        "binaries": binaries(),
        "files": files(),
        "homeOwnership": home_ownership(),
        "fonts": fonts(),
        "loginEnv": login_env(),
        "users": users(),
    }


def outside(image):
    config = json.loads(subprocess.check_output(["docker", "image", "inspect", image]))[0]
    me = os.path.abspath(__file__)
    inventory = json.loads(subprocess.check_output([
        "docker", "run", "--rm", "--network", "none", "--user", "root",
        "--entrypoint", "/opt/venv/bin/python3", "-v", f"{me}:/tmp/oma-inventory.py:ro",
        image, "-I", "/tmp/oma-inventory.py", "--inside"]))
    inventory["image"] = {
        "ref": image, "id": config["Id"], "repoDigests": config.get("RepoDigests"),
        "architecture": config.get("Architecture"), "layers": len(config["RootFS"]["Layers"]),
        "size": config.get("Size"),
        "config": {k: config["Config"].get(k) for k in ("Entrypoint", "Cmd", "User", "WorkingDir", "Env", "Labels")},
    }
    inventory["capturedAt"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return inventory


if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["--inside"]:
        result = inside()
    elif len(sys.argv) == 2:
        result = outside(sys.argv[1])
    else:
        raise SystemExit("usage: sandbox-inventory.py IMAGE")
    print(json.dumps(result, indent=1, sort_keys=True))
