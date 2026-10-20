import hashlib
import json
from pathlib import Path
import re

root = Path('/opt/auto-story')
release = json.loads((root / 'runtime-overlay/release.json').read_text())
spec = release['vfs-cli']
version = spec['version'].removeprefix('v')
assert hashlib.sha256(Path('/usr/local/bin/vfs-cli').read_bytes()).hexdigest() == spec['binarySha256']
versions = json.loads((root / 'versions.json').read_text())
versions.update(imageVersion=release['imageVersion'], parentImage=release['parent'])
versions['vfs-cli'] = spec
versions['runtimeOverlay'] = 'runtime-overlay/release.json'
(root / 'versions.json').write_text(json.dumps(versions, indent=2) + '\n')
smoke = Path('/usr/local/bin/auto-story-smoke')
pattern = re.compile(r'''(?m)^(\s*["']vfs-cli["']\s*:\s*["'])[^"']+(["'])''')
content, count = pattern.subn(rf'\g<1>{version}\g<2>', smoke.read_text())
assert count == 1, count
smoke.write_text(content)
hashes = root / 'tool-sha256.txt'
lines = hashes.read_text().splitlines()
indices = [i for i, line in enumerate(lines) if line.endswith('  /usr/local/bin/vfs-cli')]
assert len(indices) == 1
lines[indices[0]] = spec['binarySha256'] + '  /usr/local/bin/vfs-cli'
hashes.write_text('\n'.join(lines) + '\n')
