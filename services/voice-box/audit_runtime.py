"""Artifact checks executed inside each image, with no network access needed."""
import argparse
import hashlib
import importlib.metadata as metadata
import importlib.util
import json
from pathlib import Path
import platform
import re
import subprocess
import sysconfig

CODECS = re.compile(rb'(?:libav(?:codec|format|filter|device|util)|libsw(?:resample|scale)|libx26[45]|libmp3lame|libvorbis|libtheora|libopus|libespeak)[^\x00/ ]*\.so')


def digest(path):
    return hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()


def audit(root=Path('/usr/share/voice-box')):
    for package in ('av',):
        if importlib.util.find_spec(package) is not None:
            raise ValueError('Unapproved runtime is installed: ' + package)
    from faster_whisper import WhisperModel, decode_audio
    import numpy as np
    from faster_whisper.audio import pad_or_trim
    assert metadata.version('faster-whisper') == '1.2.1+josi.pcm1'
    assert metadata.version('ctranslate2') == '4.8.2+josi.cpu1'
    assert not any(re.match(r'av\b', x) for x in metadata.requires('faster-whisper'))
    try:
        decode_audio(b'encoded input')
    except ValueError:
        pass
    else:
        raise ValueError('Encoded audio must not enter the PCM-only build')
    assert pad_or_trim(np.zeros((2, 4)), 3).shape == (2, 3)
    site = Path(sysconfig.get_paths()['purelib'])
    natives = []
    for base in (Path('/usr/lib'), Path('/lib'), Path('/usr/local/lib')):
        for path in base.rglob('*'):
            if not path.is_file() or '.so' not in path.name:
                continue
            with path.open('rb') as stream:
                if stream.read(4) != b'\x7fELF':
                    continue
            data = path.read_bytes()
            if CODECS.search(data) or CODECS.search(path.name.encode()) or b'libcudart_static_' in data or b'Intel(R) oneAPI Math Kernel Library Version' in data:
                raise ValueError('Unapproved codec library: ' + str(path))
            natives.append({'path': str(path), 'sha256': hashlib.sha256(data).hexdigest(),
                            'target': str(path.resolve())})
    for folder in site.glob('*.libs'):
        for path in folder.iterdir():
            if path.name.startswith(('libgomp', 'libgfortran', 'libquadmath')):
                if not path.is_symlink() or not str(path.resolve()).startswith('/usr/lib/'):
                    raise ValueError('Opaque bundled compiler runtime: ' + str(path))
    lock = json.loads((root / 'build/sources.lock.json').read_text())
    for entry in lock['files']:
        path = root / 'sources' / entry['path']
        if not path.is_file() or path.stat().st_size != entry['size'] or digest(path) != entry['sha256']:
            raise ValueError('Missing or changed corresponding source: ' + entry['path'])
    available = {(e['package'], e['version']) for e in lock['files'] if e['kind'] == 'debian-source'}
    debian = subprocess.check_output(['dpkg-query', '-W', '-f=${Package}\t${Version}\t${source:Package}\t${source:Version}\n'], text=True)
    packages = []
    for line in debian.splitlines():
        name, version, source, source_version = line.split('\t')
        if (source, source_version) not in available:
            raise ValueError('Missing Debian source version: ' + source + ' ' + source_version)
        packages.append({'name': name, 'version': version, 'source': source, 'sourceVersion': source_version})
    python = sorted([{'name': d.metadata['Name'], 'version': d.version,
                      'license': d.metadata.get('License-Expression') or d.metadata.get('License') or '',
                      'classifiers': d.metadata.get_all('Classifier') or []} for d in metadata.distributions()], key=lambda x:x['name'].lower())
    vendor = metadata.distribution('setuptools').locate_file('setuptools/_vendor')
    vendored = {d.metadata['Name'].lower(): d.version for d in metadata.distributions(path=[str(vendor)])}
    if vendored.get('autocommand') != '2.2.2' or not any(e['package'] == 'autocommand' and e['version'] == '2.2.2' for e in lock['files']):
        raise ValueError('Missing vendored LGPL source')
    for name in ('num2words', 'certifi', 'tqdm', 'pip', 'setuptools'):
        if not any(e['package'] == name and e['version'] == metadata.version(name) for e in lock['files']):
            raise ValueError('Missing Python copyleft source: ' + name)
    notices = []
    for base in (site.parent, Path('/usr/share/doc'), Path('/usr/share/common-licenses'), Path('/models/licenses')):
        for path in base.rglob('*'):
            if path.is_file() and (re.search(r'license|copying|copyright|notice', path.name, re.I)
                                   or base.name in ('common-licenses', 'licenses')):
                notices.append({'path': str(path), 'sha256': digest(path)})
    return {'architecture': platform.machine(), 'codecLibraries': [], 'python': python,
            'debian': packages, 'nativeLibraries': natives, 'notices': notices,
            'sourceFiles': len(lock['files']), 'sourceLockSha256': digest(root / 'build/sources.lock.json')}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(json.dumps(audit(), indent=2) + '\n')
