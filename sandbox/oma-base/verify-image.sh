#!/usr/bin/env bash
# Docker-level acceptance of a Base Image (oma-base, or an image built on it):
# image config, the offline smoke as `user`, the inherited ACS startup, and
# PID 1 exiting promptly on SIGTERM. Prints one JSON document on stdout.
# Usage: verify-image.sh IMAGE [SMOKE...]   (SMOKE: in-image smoke scripts)
set -euo pipefail
cd "$(dirname "$0")"
image="${1:?Usage: verify-image.sh IMAGE [SMOKE...]}"
shift
smokes=("/opt/oma/smoke/oma-base.py" "$@")
acs_base="$(python3 -c 'import json; print(json.load(open("versions.json"))["baseImage"])')"
work="$(mktemp -d)"
cleanup() { docker rm --force oma-verify-$$ >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

# 1. Config: tini in front of the ACS startup; no environment variable added.
docker image inspect "$image" --format '{{json .Config}}' > "$work/config.json"
docker image inspect "$acs_base" --format '{{json .Config}}' > "$work/base-config.json"
python3 - "$work/config.json" "$work/base-config.json" > "$work/config-check.json" <<'PY'
import json, sys
config, base = (json.load(open(p)) for p in sys.argv[1:])
assert config["Entrypoint"] == ["/usr/bin/tini", "-g", "--"], config["Entrypoint"]
assert config["Cmd"] == base["Entrypoint"] + (base.get("Cmd") or []), config["Cmd"]
assert config.get("User") == base.get("User") and config.get("WorkingDir") == base.get("WorkingDir")
assert config["Env"] == base["Env"], sorted(set(config["Env"]) ^ set(base["Env"]))
assert not [e for e in config["Env"] if e.split("=", 1)[0].lower().endswith("_proxy")]
print(json.dumps({"entrypoint": config["Entrypoint"], "cmd": config["Cmd"], "user": config.get("User"),
                  "workingDir": config.get("WorkingDir"), "envEqualsAcsBase": True, "proxyEnv": [],
                  "labels": config.get("Labels") or {}}))
PY

# 2. Offline smoke as the ordinary user on a minimal PATH.
for smoke in "${smokes[@]}"; do
  name="$(basename "$smoke" .py)"
  if ! docker run --rm --platform linux/amd64 --network none --user user --workdir /home/user \
      --entrypoint /usr/bin/env "$image" -i HOME=/home/user PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 \
      "$smoke" > "$work/smoke-$name.json"; then
    cat "$work/smoke-$name.json" >&2
    echo "Smoke failed: $smoke" >&2
    exit 1
  fi
done

# 3. The inherited ACS startup serves Jupyter, then PID 1 exits on SIGTERM.
docker run --detach --name "oma-verify-$$" --platform linux/amd64 --network none "$image" >/dev/null
ready=0
for _ in $(seq 1 60); do
  if docker exec "oma-verify-$$" curl --fail --silent --max-time 2 http://127.0.0.1:8888/api/status >/dev/null; then
    ready=1; break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then docker logs --tail 30 "oma-verify-$$" >&2; echo 'ACS Jupyter startup failed' >&2; exit 1; fi
pid1="$(docker exec "oma-verify-$$" sh -c 'tr "\0" " " < /proc/1/cmdline')"
started="$(date +%s%N)"
docker kill --signal TERM "oma-verify-$$" >/dev/null
exit_code="$(timeout 30 docker wait "oma-verify-$$")"
elapsed_ms=$(( ($(date +%s%N) - started) / 1000000 ))
if [[ "$exit_code" != 143 || "$elapsed_ms" -gt 5000 ]]; then
  echo "PID 1 did not exit promptly on SIGTERM: exit ${exit_code}, ${elapsed_ms} ms" >&2
  exit 1
fi

python3 - "$work" "$image" "$pid1" "$exit_code" "$elapsed_ms" "${smokes[@]}" <<'PY'
import json, os, sys
work, image, pid1, code, elapsed, *smokes = sys.argv[1:]
result = {
    "image": image,
    "config": json.load(open(os.path.join(work, "config-check.json"))),
    "smoke": {os.path.basename(s)[:-3]: json.load(open(os.path.join(work, f"smoke-{os.path.basename(s)[:-3]}.json"))) for s in smokes},
    "startup": {"jupyter": "healthy", "pid1": pid1.strip()},
    "sigterm": {"exitCode": int(code), "elapsedMs": int(elapsed)},
}
print(json.dumps(result, ensure_ascii=False, indent=2))
PY
