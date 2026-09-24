"""Build-time, fail-closed PCM-only adaptation of faster-whisper 1.2.1 (MIT).

The gateway passes float32 arrays, never encoded audio. Remove the unused
compressed-file decoder and its dependency rather than importing absent codecs.
Keep all inference/VAD behavior and upstream notices. Record the modification
in wheel metadata and regenerate RECORD so artifact scanners see honest metadata.
"""
import base64
import csv
import hashlib
import importlib.metadata
from pathlib import Path


def patch():
    dist = importlib.metadata.distribution('faster-whisper')
    if dist.version != '1.2.1':
        raise ValueError('Only the reviewed faster-whisper version can be adapted')
    path = Path(dist.locate_file('faster_whisper/audio.py'))
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != '60a1d8638f718cbf6d245aed3e5a5aa61c1f822a0b0fe9b48a7c928d47c23909':
        raise ValueError('Upstream audio module changed; review the adaptation')
    original = data.decode()
    path.write_text('''"""Josi PCM-only adaptation of faster-whisper 1.2.1, 2026-09-12.

Copyright SYSTRAN and contributors, MIT; see the installed upstream LICENSE.
Voice Box decodes PCM16 frames with NumPy and writes WAV using stdlib wave.
The unsupported encoded-file entry point fails explicitly, without codecs.
"""
import numpy as np


def decode_audio(input_file, sampling_rate=16000, split_stereo=False):
    raise ValueError("This build accepts decoded float32 PCM arrays only")


''' + original[original.index('def pad_or_trim('):])
    metadata = Path(dist.locate_file('faster_whisper-1.2.1.dist-info/METADATA'))
    text = metadata.read_text()
    lines = text.splitlines(keepends=True)
    dependencies = [line for line in lines if line.startswith('Requires-Dist: av')]
    if dependencies != ['Requires-Dist: av>=11\n']:
        raise ValueError('Upstream codec dependency changed')
    metadata.write_text(text.replace(dependencies[0], '').replace('Version: 1.2.1\n', 'Version: 1.2.1+josi.pcm1\n'))
    record = metadata.with_name('RECORD')
    with record.open(newline='') as stream:
        rows = list(csv.reader(stream))
    for row in rows:
        if row[0] in ('faster_whisper/audio.py', 'faster_whisper-1.2.1.dist-info/METADATA'):
            content = Path(dist.locate_file(row[0])).read_bytes()
            row[1] = 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(content).digest()).decode().rstrip('=')
            row[2] = str(len(content))
    with record.open('w', newline='') as stream:
        csv.writer(stream, lineterminator='\n').writerows(rows)


if __name__ == '__main__':
    patch()
