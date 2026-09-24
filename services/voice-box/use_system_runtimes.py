"""Replace wheel-bundled GCC runtimes with source-matched Debian libraries.

The ABI-compatible dynamic libraries remain replaceable by the recipient.
This runs in the SAME image layer as pip installation: opaque wheel runtime
binaries do not survive in any distributable image layer.
"""
import base64
import csv
import hashlib
import platform
from pathlib import Path
import sysconfig


def replace():
    site = Path(sysconfig.get_paths()['purelib'])
    triplet = {'x86_64': 'x86_64-linux-gnu', 'aarch64': 'aarch64-linux-gnu'}[platform.machine()]
    libraries = {'libgomp': 'libgomp.so.1', 'libgfortran': 'libgfortran.so.5', 'libquadmath': 'libquadmath.so.0'}
    changed = set()
    for folder in site.glob('*.libs'):
        for path in folder.iterdir():
            for prefix, soname in libraries.items():
                if path.name.startswith(prefix) and '.so' in path.name:
                    target = Path('/usr/lib') / triplet / soname
                    if not target.is_file():
                        raise ValueError('Missing pinned runtime: ' + str(target))
                    path.unlink()
                    path.symlink_to(target)
                    changed.add(path.relative_to(site).as_posix())
    if not any('libgfortran' in name for name in changed):
        raise ValueError('Wheel runtime layout changed; review before redistribution')
    for record in site.glob('*.dist-info/RECORD'):
        with record.open(newline='') as stream:
            rows = list(csv.reader(stream))
        touched = False
        for row in rows:
            if row[0] in changed:
                data = (site / row[0]).read_bytes()
                row[1] = 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('=')
                row[2] = str(len(data)); touched = True
        if touched:
            with record.open('w', newline='') as stream:
                csv.writer(stream, lineterminator='\n').writerows(rows)
    return sorted(changed)


if __name__ == '__main__':
    print('\n'.join(replace()))
