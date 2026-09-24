"""Expose source-archive notices as one readable file without discarding originals."""
import json
from pathlib import Path
import re
import tarfile

root = Path('/redistribution')
entries = json.loads(Path('/build/sources.lock.json').read_text())['files']
with (root / 'THIRD_PARTY_NOTICES.txt').open('w') as output:
    output.write('Voice Box third-party notices\n\nExact original sources are in sources/; package versions and SHA-256 hashes\nare in build/sources.lock.json. Debian binary copyright notices also remain\nin /usr/share/doc and /usr/share/common-licenses. This index supplements them.\n')
    for entry in entries:
        if entry['kind'] == 'debian-source':
            continue
        path = root / 'sources' / entry['path']
        if entry['kind'] == 'license':
            output.write('\n\n' + entry['path'] + '\n' + path.read_text())
            continue
        with tarfile.open(path) as archive:
            for member in archive:
                if member.isfile() and re.search(r'^(LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE)([.-].*)?$', Path(member.name).name, re.I):
                    output.write('\n\n' + entry['path'] + ' :: ' + member.name + '\n')
                    output.write(archive.extractfile(member).read().decode('utf-8', errors='replace'))
