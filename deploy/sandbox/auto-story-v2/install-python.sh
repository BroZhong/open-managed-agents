#!/bin/sh
# Isolate Gemini from Jupyter while keeping the base scientific packages visible.
set -eu
/opt/venv/bin/python3 -m venv /opt/auto-story/venv
python=/opt/auto-story/venv/bin/python3
"$python" -m pip install --cache-dir /root/.cache/pip \
  --index-url "$PIP_INDEX_URL" -r /opt/auto-story/requirements.txt
"$python" - <<'PY'
import pathlib
import site
pathlib.Path(site.getsitepackages()[0], "acs-base.pth").write_text(
    "/opt/venv/lib/python3.11/site-packages\n"
)
PY
mkdir -p /out/bin
cat > /out/bin/python3 <<'WRAPPER'
#!/bin/sh
exec /opt/auto-story/venv/bin/python3 "$@"
WRAPPER
cat > /out/bin/pip3 <<'WRAPPER'
#!/bin/sh
exec /opt/auto-story/venv/bin/python3 -m pip "$@"
WRAPPER
chmod 0755 /out/bin/python3 /out/bin/pip3
ln -s python3 /out/bin/python
ln -s pip3 /out/bin/pip
"$python" -m pip freeze > /opt/auto-story/python-packages.txt
