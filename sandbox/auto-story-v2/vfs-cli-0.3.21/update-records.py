import json, hashlib, re
from pathlib import Path
root=Path('/opt/auto-story')
h=hashlib.sha256(Path('/usr/local/bin/vfs-cli').read_bytes()).hexdigest()
v=json.loads((root/'versions.json').read_text());v['imageVersion']='0.3.3';v['vfs-cli']={'version':'v0.3.21','binarySha256':h};v['parentImage']='registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:f95eebfa2adb297747d4ccb17d1c151ddf73e82549b76abecdc703ce39843309'
(root/'versions.json').write_text(json.dumps(v,indent=2)+'\n')
p=Path('/usr/local/bin/auto-story-smoke');s=p.read_text();assert '0.3.20' in s;p.write_text(s.replace('0.3.20','0.3.21'))
p=root/'tool-sha256.txt';p.write_text('\n'.join(h+'  /usr/local/bin/vfs-cli' if l.endswith('  /usr/local/bin/vfs-cli') else l for l in p.read_text().splitlines())+'\n')
