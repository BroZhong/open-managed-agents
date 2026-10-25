# oma-base

The platform **Base Image** every Environment builds on (ADR-0024). It is the
pinned ACS `code-interpreter` image plus only what the platform needs inside
every Sandbox:

| Component | Version | Source |
| --- | --- | --- |
| ACS code-interpreter | digest in `versions.json` | `registry-cn-shanghai-vpc.ack.aliyuncs.com/acs/code-interpreter` |
| Node.js | 22.23.2 | `/usr/local/bin/node` from the Host's pinned `welltop/node-base` |
| Pi tool runtime | `@earendil-works/pi-coding-agent` 0.83.0 | `/opt/oma-pi-tools`, `npm ci` from `pi-tools/package-lock.json` |
| rg / fd | 15.1.0 / 10.4.2 | `../prepare-search-binaries.py` (pinned archives and binaries) |
| tini, procps, unzip | Debian versions in `versions.json` | Aliyun Debian mirror |
| `write-manifest` | | `/opt/oma/bin/write-manifest` |

- **Mirrors**: apt uses `https://mirrors.aliyun.com/debian` (the base's
  nodesource list is removed; its apt Node 20 only provides npm), pip uses
  `/etc/pip.conf` → Aliyun PyPI, npm uses `/usr/local/etc/npmrc` →
  `registry.npmmirror.com`.
- **Startup**: `ENTRYPOINT ["/usr/bin/tini", "-g", "--"]` in front of the
  original `bash /root/.jupyter/start-up.sh`. tini forwards SIGTERM to the
  whole startup process group, so an in-place swap no longer waits out the
  30 s grace period.
- **No image ENV**: the config's `Env` equals the ACS base's. Sandbox commands
  (envd `bash -l -c`) never see image ENV, and a proxy or secret there would
  override every Environment build. `python3`/`python`/`pip3`/`pip` in
  `/usr/local/bin` exec the ACS venv (`/opt/venv`), so the login shell's PATH
  reaches it.
- **`/home/user`** holds only the skeleton dotfiles, all owned by `user`;
  `/home/user/workspace` is absent (CSI mounts it).
- **Manifest**: `write-manifest` prints JSON (dpkg packages, Python
  distributions per interpreter and venv under `/opt`, npm globals and
  `/opt/*` lockfile projects, versions of known binaries, `/usr/local/bin`
  hashes, `/opt/oma/images/*.json`). It writes nothing but stdout; the image
  builder runs `write-manifest > /opt/oma/manifest.json`.

The Pi runtime must be the Host's exact version (ADR-0014): `build.sh` fails
unless `adapter/packages/pi-agent/package.json`, the lockfile and
`versions.json` agree. A Pi upgrade is a new oma-base, which rebuilds every
Environment; release Base Images, then the image builder, then the Runner.

## Build and publish

On `vfs-dev` (amd64, Shanghai VPC registry, Aliyun mirrors; no GitHub access,
so pass already-verified binaries):

```bash
RG_SRC=… FD_SRC=… bash sandbox/oma-base/build.sh          # build + verify
RG_SRC=… FD_SRC=… PUSH=1 bash sandbox/oma-base/build.sh   # then push a new tag
```

`verify-image.sh` checks the config (tini entrypoint, original command, `Env`
equal to the ACS base, no proxy variables), runs `smoke.py` as `user` with no
network (versions, Pi's seven tools, rg/fd syntax, python/pip/npm/apt mirrors,
`/home/user`, `write-manifest`), starts the image until Jupyter is healthy and
requires PID 1 to exit with 143 within 5 s of SIGTERM. A push never overwrites
an existing tag (`oma-base-<imageVersion>`). The published digest is the lock
in `image.lock.json`; `../oma-media/versions.json` pins it.
