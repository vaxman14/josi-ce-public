"""Build-time downloads from the reviewed lockfile, verified before use."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import urllib.request
import urllib.error
import time
import socket


def download(root, lock):
    root.mkdir(parents=True, exist_ok=True)
    def one(entry):
        target = root / entry['path']
        if not target.resolve().is_relative_to(root.resolve()):
            raise ValueError('Invalid model path')
        target.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        size = 0
        with urllib.request.urlopen(entry['url'], timeout=60) as source, target.with_suffix('.download').open('wb') as out:
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                if size > entry['size']:
                    raise ValueError('Model exceeds pinned size')
                digest.update(chunk)
                out.write(chunk)
        if size != entry['size'] or digest.hexdigest() != entry['sha256']:
            raise ValueError('Model checksum mismatch: ' + entry['path'])
        target.with_suffix('.download').replace(target)

    def verified(entry):
        for attempt in range(3):
            try:
                one(entry)
                print('Verified ' + entry['path'], flush=True)
                return
            except urllib.error.URLError as error:
                if attempt == 2 or isinstance(error, urllib.error.HTTPError) and error.code < 500:
                    raise
                time.sleep(2 ** attempt)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(verified, lock['files']))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--lock', type=Path, default=Path(__file__).with_name('models.lock.json'))
    parser.add_argument('--architecture', choices=('amd64', 'arm64'))
    args = parser.parse_args()
    # Hundreds of immutable source archives share a handful of hosts. Reuse
    # DNS answers for this short-lived build command instead of flooding the
    # operator's resolver; TLS still verifies each original hostname.
    socket.getaddrinfo = lru_cache(maxsize=32)(socket.getaddrinfo)
    lock = json.loads(args.lock.read_text())
    if args.architecture:
        lock['files'] = [entry for entry in lock['files'] if entry.get('architecture') == args.architecture]
        if not lock['files']:
            raise ValueError('No artifacts locked for this architecture')
    download(args.root, lock)
