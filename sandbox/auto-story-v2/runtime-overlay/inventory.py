"""Capture inherited packages/assets; fail if an overlay changes existing ones."""
import hashlib
import importlib.metadata as metadata
import json
from pathlib import Path
import subprocess
import sys


def inventory():
    packages = {d.metadata['Name'].lower().replace('_', '-'): d.version for d in metadata.distributions()}
    files = [Path('/usr/local/bin') / name for name in
             ['node', 'ffmpeg', 'ffprobe', 'mediakit-cli', 'ossutil', 'rg', 'fd', 'python3', 'pip3']]
    files += [Path(p) for p in ['/opt/oma-pi-tools/package-lock.json',
              '/opt/auto-story/whisper-packages.txt', '/opt/auto-story/whisper-models.json',
              '/opt/auto-story/prepare-whisper.py', '/root/.jupyter/start-up.sh']]
    files += sorted(p for p in Path('/opt/auto-story/models').rglob('*') if p.is_file())
    hashes = {}
    for path in files:
        h = hashlib.sha256()
        with path.open('rb') as f:
            for block in iter(lambda: f.read(1024 * 1024), b''):
                h.update(block)
        hashes[str(path)] = h.hexdigest()
    debian = dict(line.split('\t', 1) for line in subprocess.check_output(
        ['dpkg-query', '-W', '-f=${binary:Package}\t${Version}\n'], text=True).splitlines())
    return {'python': packages, 'files': hashes, 'debian': debian}


if __name__ == '__main__':
    path = Path('/opt/auto-story/runtime-overlay/parent-inventory.json')
    current = inventory()
    if sys.argv[1] == 'capture':
        path.write_text(json.dumps(current, indent=2) + '\n')
        Path('/opt/auto-story/runtime-overlay/constraints.txt').write_text(
            '\n'.join(f'{name}=={version}' for name, version in sorted(current['python'].items())) + '\n')
    else:
        original = json.loads(path.read_text())
        changes = [(kind, name, value, current[kind].get(name))
                   for kind, values in original.items() for name, value in values.items()
                   if current[kind].get(name) != value]
        if changes:
            raise SystemExit('Inherited runtime changed: ' + json.dumps(changes))
        print(json.dumps({'inheritedRuntimeUnchanged': True,
                          'checked': {k: len(v) for k, v in original.items()}}))
