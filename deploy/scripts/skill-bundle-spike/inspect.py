# In-Sandbox inspection for the #261 Skill bundle install spike, driven by
# deploy/scripts/verify-skill-bundle-install.mts. Prints one JSON document; it
# never prints file contents, command lines or environment values.
#   tree <dir>           hash and stat every entry, then probe write denial
#   sample <stop> <max>  scan /proc/*/{cmdline,environ} for signed-URL markers
#   unzip <zip>          compare Info-ZIP unzip (C / C.UTF-8) with Python zipfile
import errno, hashlib, json, os, stat, subprocess, sys, tempfile, time, zipfile

def entries(top):
    out = []
    for parent, dirs, files in os.walk(top):
        for name in sorted(dirs) + sorted(files):
            path = os.path.join(parent, name)
            st = os.lstat(path)
            rel = os.path.relpath(path, top).encode("utf-8", "surrogateescape").hex()
            row = {"p": rel, "m": stat.S_IMODE(st.st_mode), "u": st.st_uid, "g": st.st_gid}
            if stat.S_ISDIR(st.st_mode): row["t"] = "d"
            elif stat.S_ISREG(st.st_mode):
                row["t"], row["s"] = "f", st.st_size
                with open(path, "rb") as fh: row["h"] = hashlib.sha256(fh.read()).hexdigest()
            else: row["t"] = "o"
            out.append(row)
    return out

def attempt(fn):
    try:
        fn()
        return "ALLOWED"
    except OSError as error:
        return errno.errorcode.get(error.errno, str(error.errno))

def tree(link):
    real = os.path.realpath(link)
    st = os.lstat(real)
    result = {"uid": os.getuid(), "isLink": os.path.islink(link), "target": os.readlink(link) if os.path.islink(link) else None,
              "root": {"m": stat.S_IMODE(st.st_mode), "u": st.st_uid, "g": st.st_gid}, "entries": entries(real)}
    skill = next(os.path.join(real, n) for n in sorted(os.listdir(real)))
    sample = next(os.path.join(p, f) for p, _, fs in os.walk(skill) for f in sorted(fs))
    result["denial"] = {
        "create": attempt(lambda: open(os.path.join(skill, ".probe"), "x").close()),
        "overwrite": attempt(lambda: open(sample, "r+b").close()),
        "delete": attempt(lambda: os.unlink(sample)),
        "chmod": attempt(lambda: os.chmod(sample, 0o666)),
        "mkdir": attempt(lambda: os.mkdir(os.path.join(skill, ".probe-dir"))),
        "rename": attempt(lambda: os.rename(sample, sample + ".probe")),
        "relink": attempt(lambda: os.symlink(real, os.path.join(os.path.dirname(link) or "/", ".skills-probe"))),
        "unlinkLink": attempt(lambda: os.unlink(link)),
    }
    return result

def sample(stop_file, max_seconds):
    # Markers are hex so this scanner's own command line cannot match them.
    markers = [bytes.fromhex(h) for h in ("782d6f73732d", "616c6979756e6373", "4f5353342d484d4143")]
    me, parent = str(os.getpid()), str(os.getppid())
    deadline = time.monotonic() + float(max_seconds)
    samples = curl_samples = 0
    curl_pids, hits = set(), []
    while time.monotonic() < deadline and not os.path.exists(stop_file):
        samples += 1
        saw_curl = False
        for pid in os.listdir("/proc"):
            if not pid.isdigit() or pid in (me, parent): continue
            for kind in ("cmdline", "environ"):
                try:
                    with open(f"/proc/{pid}/{kind}", "rb") as fh: data = fh.read()
                except OSError: continue
                if kind == "cmdline" and os.path.basename(data.split(b"\0", 1)[0]) == b"curl":
                    saw_curl = True
                    curl_pids.add(pid)
                hits += [f"{kind}:{i}" for i, marker in enumerate(markers) if marker in data]
        curl_samples += saw_curl
        time.sleep(0.003)
    return {"samples": samples, "samplesWithCurl": curl_samples, "curlProcesses": len(curl_pids), "markerHits": len(hits), "hitKinds": sorted(set(hits))}

def tree_modes(top):
    return {row["p"]: row["m"] for row in entries(top) if row["t"] == "f"}

def unzip_probe(archive):
    result = {}
    for locale in ("C", "C.UTF-8"):
        target = tempfile.mkdtemp(prefix="oma-unzip-")
        env = dict(os.environ, LC_ALL=locale, LANG=locale)
        run = subprocess.run(["unzip", "-qq", archive, "-d", target], env=env, capture_output=True)
        result["unzip:" + locale] = {"rc": run.returncode, "modes": tree_modes(target)}
    target = tempfile.mkdtemp(prefix="oma-pyzip-")
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(target)
        result["zipfile:externalAttrModes"] = {info.filename.encode().hex(): stat.S_IMODE(info.external_attr >> 16)
                                               for info in bundle.infolist() if not info.is_dir()}
    result["python-zipfile"] = {"rc": 0, "modes": tree_modes(target)}
    return result

command = sys.argv[1]
if command == "tree": print(json.dumps(tree(sys.argv[2])))
elif command == "sample": print(json.dumps(sample(sys.argv[2], sys.argv[3])))
elif command == "unzip": print(json.dumps(unzip_probe(sys.argv[2])))
else: sys.exit(2)
