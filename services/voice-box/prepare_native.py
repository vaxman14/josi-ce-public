"""Reconstruct the pinned CPU CTranslate2 source tree without network or git."""
import json
from pathlib import Path
import tarfile

root = Path('/native-build')
for entry in json.loads(Path('/build/sources.lock.json').read_text())['files']:
    if entry.get('kind') != 'native-source':
        continue
    target = root / entry['destination']
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(Path('/redistribution/sources') / entry['path']) as archive:
        members = []
        for member in archive.getmembers():
            parts = member.name.split('/', 1)
            if len(parts) == 2 and parts[1]:
                member.name = parts[1]
                members.append(member)
        archive.extractall(target, members=members, filter='data')
# Mark the variant honestly; do not claim the upstream CUDA/MKL wheel build.
p = root / 'ctranslate2/python/ctranslate2/version.py'
p.write_text(p.read_text().replace('4.8.2', '4.8.2+josi.cpu1'))
p = root / 'ctranslate2/python/setup.py'
p.write_text('\n'.join(line for line in p.read_text().split('\n') if 'Environment :: GPU' not in line))
(root / 'ctranslate2/python/LICENSE').write_bytes((root / 'ctranslate2/LICENSE').read_bytes())
