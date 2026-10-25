#!/usr/bin/python3 -I
"""Offline acceptance checks of oma-base; run as `user` with a clean environment.

Also run against every image built on oma-base (oma-media): the platform
contract of the Base Image must survive the layers above it.
"""

import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import tempfile
import zipfile

HOME = Path("/home/user")
IDENTITY = json.loads(Path("/opt/oma/images/oma-base.json").read_text())
SKELETON = {".bashrc", ".profile", ".bash_logout"}
CHECKS = []


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def run(argv, *, cwd=None, env=None, timeout=60, expected_code=0):
    base = {"HOME": str(HOME), "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
    result = subprocess.run(argv, cwd=cwd, env={**base, **(env or {})}, capture_output=True, text=True,
                            timeout=timeout, check=False, stdin=subprocess.DEVNULL)
    if result.returncode != expected_code:
        raise RuntimeError(f"{argv[0]} exited {result.returncode}: {(result.stdout + result.stderr)[-2000:]}")
    return result.stdout


def check(name, operation):
    try:
        CHECKS.append({"name": name, "ok": True, "details": operation()})
    except Exception as error:  # noqa: BLE001 - every failure is reported
        CHECKS.append({"name": name, "ok": False, "error": str(error)})


def versions():
    node = run(["node", "--version"]).strip()
    require(node == "v" + IDENTITY["node"], f"node: expected v{IDENTITY['node']}, got {node}")
    pi = run(["node", "--input-type=module", "-e",
              "const pi = await import('/opt/oma-pi-tools/node_modules/@earendil-works/pi-coding-agent/dist/index.js');"
              " console.log(pi.VERSION)"]).strip()
    require(pi == IDENTITY["pi"], f"Pi: expected {IDENTITY['pi']}, got {pi}")
    found = {"node": node, "pi": pi}
    for binary, expected in (("rg", "15.1.0"), ("fd", "10.4.2"), ("tini", "0.19.0")):
        output = run([binary, "--version"])
        match = re.search(r"(\d+\.\d+\.\d+)", output)
        require(match and match.group(1) == expected, f"{binary}: expected {expected}, got {output[:120]}")
        found[binary] = match.group(1)
    for binary in ("ps", "unzip", "npm", "python3", "pip3"):
        require(shutil.which(binary, path="/usr/local/bin:/usr/bin:/bin"), f"Missing executable: {binary}")
    return found


def native_search(directory):
    """The exact rg/fd syntax Pi's grep and find tools use."""
    root = Path(directory) / "search"
    root.mkdir()
    (root / ".git").mkdir()
    (root / "src").mkdir()
    (root / "ignored").mkdir()
    (root / ".gitignore").write_text("ignored/\n", encoding="utf-8")
    names = ("root.ts", ".hidden.ts", "src/child.ts", "src/script.js")
    for name in (*names, "ignored/secret.ts"):
        (root / name).write_text("故事 hello\n", encoding="utf-8")
    events = [json.loads(line) for line in run([
        "rg", "--json", "--line-number", "--color=never", "--hidden", "--glob", "*.{ts,js}", "--", r"\p{L}+", str(root),
    ], cwd=root).splitlines()]
    matches = {Path(e["data"]["path"]["text"]).relative_to(root).as_posix() for e in events if e["type"] == "match"}
    require(matches == set(names), f"ripgrep Unicode/glob/gitignore check failed: {sorted(matches)}")
    found = {Path(line).relative_to(root).as_posix() for line in run([
        "fd", "--glob", "--color=never", "--hidden", "--max-results", "1000", "--", "*.ts", str(root),
    ], cwd=root).splitlines()}
    require(found == {"root.ts", ".hidden.ts", "src/child.ts"}, f"fd basename/gitignore check failed: {sorted(found)}")
    return {"rg": "unicode, brace glob, .gitignore", "fd": "basename glob, .gitignore"}


def python_and_mirrors(directory):
    prefix = run(["python3", "-I", "-c", "import sys; print(sys.prefix)"]).strip()
    require(prefix == "/opt/venv", f"python3 must be the ACS venv, got {prefix}")
    pip_version = run(["pip3", "--version"])
    require("/opt/venv/" in pip_version, f"pip3 must be the ACS venv's pip: {pip_version}")
    pip_config = run(["pip3", "config", "list"])
    require("global.index-url='https://mirrors.aliyun.com/pypi/simple/'" in pip_config, f"pip mirror: {pip_config}")
    registry = run(["npm", "config", "get", "registry"], env={"HOME": directory}).strip()
    require(registry == "https://registry.npmmirror.com/", f"npm registry: {registry}")
    uris = []
    for path in [Path("/etc/apt/sources.list"), *sorted(Path("/etc/apt/sources.list.d").glob("*"))]:
        if path.is_file():
            uris += re.findall(r"(?:URIs:|deb)\s+(?:\[[^]]*\]\s+)?(\S+)", path.read_text())
    require(uris and all(uri.startswith("https://mirrors.aliyun.com/") for uri in uris), f"apt sources: {uris}")
    return {"python3": prefix, "pip": "https://mirrors.aliyun.com/pypi/simple/", "npm": registry, "apt": sorted(set(uris))}


def home_layout():
    user = pwd.getpwnam("user")
    require(os.geteuid() == user.pw_uid, "Run the acceptance test as user")
    require(not (HOME / "workspace").exists() and not (HOME / "workspace").is_symlink(),
            "/home/user/workspace must be absent: CSI provides it")
    stat = HOME.stat()
    require((stat.st_uid, stat.st_gid) == (user.pw_uid, user.pw_gid), "/home/user must be owned by user")
    foreign = []
    for current, directories, files in os.walk(HOME):
        for name in directories + files:
            info = os.lstat(os.path.join(current, name))
            if (info.st_uid, info.st_gid) != (user.pw_uid, user.pw_gid):
                foreign.append(os.path.join(current, name))
    require(not foreign, f"Not owned by user: {foreign[:10]}")
    entries = {path.name for path in HOME.iterdir()}
    require(entries <= SKELETON, f"/home/user must hold no caches: {sorted(entries - SKELETON)}")
    probe = HOME / ".oma-base-smoke"
    probe.write_text("ok\n")
    probe.unlink()
    return {"owner": "user:user", "entries": sorted(entries), "writable": True}


def utilities(directory):
    processes = run(["ps", "-eo", "pid,comm"])
    require(any(line.split()[0] == str(os.getpid()) for line in processes.splitlines()[1:] if line.split()),
            "ps did not list the running smoke process")
    archive = Path(directory) / "fixture.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("nested/fixture.txt", "unzip works\n")
    run(["unzip", "-q", str(archive), "-d", str(Path(directory) / "out")])
    require((Path(directory) / "out/nested/fixture.txt").read_text() == "unzip works\n", "unzip lost contents")
    return {"ps": "own process listed", "unzip": "archive extracted"}


def manifest():
    before = sorted(str(path) for path in HOME.rglob("*"))
    data = json.loads(run(["/opt/oma/bin/write-manifest"], timeout=180))
    require(sorted(str(path) for path in HOME.rglob("*")) == before, "write-manifest wrote into /home/user")
    require(len(data["dpkg"]) > 200, "dpkg list is incomplete")
    require(any(env.get("prefix") == "/opt/venv" and len(env.get("packages", [])) > 50 for env in data["pip"]),
            "pip list of /opt/venv missing")
    pi = data["npm"]["projects"]["/opt/oma-pi-tools"]["dependencies"]
    require({"name": "@earendil-works/pi-coding-agent", "version": IDENTITY["pi"]} in pi, f"Pi missing from npm: {pi}")
    require(data["binaries"]["node"]["version"] == "v" + IDENTITY["node"], "node missing from binaries")
    require(any(image.get("name") == "oma-base" for image in data["baseImages"]), "oma-base identity missing")
    return {"dpkg": len(data["dpkg"]), "pip": {env.get("prefix"): len(env.get("packages", [])) for env in data["pip"]},
            "npmProjects": list(data["npm"]["projects"]), "binaries": sorted(data["binaries"])}


def main():
    check("versions", versions)
    check("pi_native_tools", lambda: json.loads(run(["node", "/opt/oma-pi-tools/smoke.mjs"])))
    with tempfile.TemporaryDirectory(prefix="oma-base-smoke-") as directory:
        check("native_search", lambda: native_search(directory))
        check("python_and_mirrors", lambda: python_and_mirrors(directory))
        check("utilities", lambda: utilities(directory))
    check("home_layout", home_layout)
    check("write_manifest", manifest)
    ok = all(item["ok"] for item in CHECKS)
    print(json.dumps({"image": IDENTITY, "ok": ok, "checks": CHECKS}, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
