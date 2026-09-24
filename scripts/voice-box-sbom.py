#!/usr/bin/env python3
"""Scan an immutable local OCI archive and supplement SPDX with image evidence.

Never pulls, publishes, or changes a release catalog. Syft must be installed by
an operator; version and archive digest are recorded. Checks every image layer,
including deleted files, for codec binaries rather than trusting a package label.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile

FORBIDDEN = re.compile(rb'(?:libav(?:codec|format|filter|device|util)|libsw(?:resample|scale)|libx26[45]|libmp3lame|libvorbis|libtheora|libopus|libespeak)[^\x00/ ]*\.so')


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inspect(path, architecture):
    captured = {}
    hashes = {}
    with tarfile.open(path) as outer:
        def blob(digest):
            return outer.extractfile('blobs/' + digest.replace(':', '/'))
        def obj(digest):
            return json.load(blob(digest))
        index = json.load(outer.extractfile('index.json'))
        descriptor = index['manifests'][0]
        manifest = obj(descriptor['digest'])
        while 'manifests' in manifest:
            descriptor = next(d for d in manifest['manifests'] if d.get('platform', {}).get('architecture') == architecture)
            manifest = obj(descriptor['digest'])
        config = obj(manifest['config']['digest'])
        if config['architecture'] != architecture or config['os'] != 'linux':
            raise ValueError('Image architecture does not match its report')
        for layer in manifest['layers']:
            with tarfile.open(fileobj=blob(layer['digest']), mode='r|*') as archive:
                for member in archive:
                    name = member.name.removeprefix('./').lstrip('/')
                    if FORBIDDEN.search(name.encode()):
                        raise ValueError('Codec in an image layer: ' + name)
                    if not member.isfile():
                        continue
                    stream = archive.extractfile(member)
                    first = stream.read(4)
                    if first == b'\x7fELF':
                        data = first + stream.read()
                        if FORBIDDEN.search(data) or b'libcudart_static_' in data or b'Intel(R) oneAPI Math Kernel Library Version' in data:
                            raise ValueError('Codec dependency in ELF: ' + name)
                    elif name in ('usr/share/voice-box/artifacts.json', 'usr/share/voice-box/build/models.lock.json',
                                  'usr/share/voice-box/build/sources.lock.json'):
                        captured[name] = json.loads(first + stream.read())
                    elif name.startswith('models/') or name.startswith('usr/share/voice-box/sources/'):
                        digest = hashlib.sha256(first)
                        while chunk := stream.read(1024 * 1024):
                            digest.update(chunk)
                        hashes[name] = digest.hexdigest()
    audit = captured['usr/share/voice-box/artifacts.json']
    expected_arch = {'amd64': 'x86_64', 'arm64': 'aarch64'}[architecture]
    if audit['architecture'] != expected_arch or audit['codecLibraries']:
        raise ValueError('Runtime audit mismatch')
    models = captured['usr/share/voice-box/build/models.lock.json']['files']
    sources = captured['usr/share/voice-box/build/sources.lock.json']['files']
    for entries, prefix in ((models, 'models/'), (sources, 'usr/share/voice-box/sources/')):
        for entry in entries:
            if hashes.get(prefix + entry['path']) != entry['sha256']:
                raise ValueError('Image artifact differs from lock: ' + entry['path'])
    return descriptor['digest'], manifest['config']['digest'], audit, models, sources


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('archive', type=Path)
    parser.add_argument('--architecture', choices=['amd64', 'arm64'], required=True)
    parser.add_argument('--syft', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--schema', type=Path, required=True, help='Official SPDX 2.3 JSON schema')
    args = parser.parse_args()
    manifest, config, audit, models, sources = inspect(args.archive, args.architecture)
    args.output.mkdir(parents=True, exist_ok=True)
    output = args.output / (args.architecture + '.spdx.json')
    subprocess.run([args.syft, 'scan', 'oci-archive:' + str(args.archive.resolve()), '-o', 'spdx-json=' + str(output)], check=True)
    doc = json.loads(output.read_text())
    packages = doc['packages']
    # Conclusions from the actual upstream notices preserved in this candidate.
    # Do not relabel Debian's complex license sets or infer terms from names.
    reviewed = {
        'addict': ('2.4.0', 'MIT'), 'cloudpathlib': ('0.25.0', 'MIT'),
        'jinja2': ('3.1.6', 'BSD-3-Clause'), 'langcodes': ('3.5.1', 'MIT'),
        'markdown-it-py': ('4.2.0', 'MIT'), 'smart-open': ('7.7.1', 'MIT'),
        'tokenizers': ('0.23.2', 'Apache-2.0'),
    }
    for package in packages:
        if package['name'] in reviewed:
            version, license_id = reviewed[package['name']]
            if package['versionInfo'] != version:
                raise ValueError('Unreviewed package version in license conclusion')
            package['licenseConcluded'] = license_id
            package['licenseComments'] = 'Reviewed upstream notice retained in the image or its corresponding source archive; see THIRD_PARTY_NOTICES.txt and native/source evidence.'
    forbidden = {'av', 'ffmpeg'}
    if any(p['name'].lower() in forbidden for p in packages):
        raise ValueError('Unapproved installed package in SBOM')
    root = next(r['relatedSpdxElement'] for r in doc['relationships'] if r['relationshipType'] == 'DESCRIBES' and r['spdxElementId'] == doc['SPDXID'])
    for entry in models:
        if not entry['path'].endswith(('.bin', '.onnx')):
            continue
        identifier = 'SPDXRef-VoiceModel-' + entry['sha256'][:24]
        packages.append({'SPDXID': identifier, 'name': 'voice-box/' + entry['path'],
                         'versionInfo': entry['sha256'], 'downloadLocation': entry['url'],
                         'filesAnalyzed': False, 'licenseConcluded': entry['license'],
                         'licenseDeclared': entry['license'], 'copyrightText': 'NOASSERTION',
                         'checksums': [{'algorithm': 'SHA256', 'checksumValue': entry['sha256']}]})
        doc['relationships'].append({'spdxElementId': root, 'relationshipType': 'CONTAINS', 'relatedSpdxElement': identifier})
    records = [(x['path'], x['sha256']) for x in audit['nativeLibraries'] + audit['notices']]
    records += [('/usr/share/voice-box/sources/' + x['path'], x['sha256']) for x in sources]
    records += [('/models/' + x['path'], x['sha256']) for x in models]
    doc.setdefault('files', [])
    existing = {x['fileName'] for x in doc['files']}
    for path, digest in sorted(set(records)):
        if path in existing:
            continue
        identifier = 'SPDXRef-VoiceFile-' + hashlib.sha256(path.encode()).hexdigest()[:24]
        doc['files'].append({'SPDXID': identifier, 'fileName': path,
                             'checksums': [{'algorithm': 'SHA256', 'checksumValue': digest}],
                             'licenseConcluded': 'NOASSERTION', 'copyrightText': 'NOASSERTION'})
        doc['relationships'].append({'spdxElementId': root, 'relationshipType': 'CONTAINS', 'relatedSpdxElement': identifier})
    doc.setdefault('comment', '')
    doc['comment'] += '\nSupplemented with verified Voice Box model, source, notice and native-file hashes; all OCI layers checked for codec binaries.'
    import jsonschema
    if sha(args.schema) != '239208b7ac287b3cf5d9a9af23f9d69863971102a5e1587a27a398b43490b89b':
        raise ValueError('Unreviewed SPDX schema')
    jsonschema.Draft7Validator(json.loads(args.schema.read_text())).validate(doc)
    identifiers = {doc['SPDXID']} | {p['SPDXID'] for p in packages} | {f['SPDXID'] for f in doc['files']}
    for relationship in doc['relationships']:
        if relationship['spdxElementId'] not in identifiers or relationship['relatedSpdxElement'] not in identifiers:
            raise ValueError('Dangling SPDX relationship')
    output.write_text(json.dumps(doc, indent=2) + '\n')
    raw_sha = sha(output)
    compressed = output.with_suffix(output.suffix + '.gz')
    compressed.write_bytes(gzip.compress(output.read_bytes(), mtime=0))
    if hashlib.sha256(gzip.decompress(compressed.read_bytes())).hexdigest() != raw_sha:
        raise ValueError('Compressed SPDX evidence changed')
    output.unlink()  # Complete original bytes are preserved in the gzip artifact.
    report = {'architecture': args.architecture, 'imageManifest': manifest, 'imageConfig': config,
              'ociArchiveSha256': sha(args.archive), 'sbom': compressed.name, 'sbomSha256': sha(compressed), 'spdxJsonSha256': raw_sha,
              'syftVersion': subprocess.check_output([args.syft, 'version', '-o', 'json'], text=True),
              'packages': len(packages), 'sourceFiles': len(sources),
              'sourceBytes': sum(x['size'] for x in sources), 'codecLibraries': [],
              'allImageLayersChecked': True, 'spdxSchemaValidated': True, 'spdxSchemaSha256': sha(args.schema), 'sourceLockSha256': audit['sourceLockSha256']}
    (args.output / (args.architecture + '.audit.json.gz')).write_bytes(gzip.compress((json.dumps(audit, indent=2) + '\n').encode(), mtime=0))
    (args.output / (args.architecture + '.report.json')).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k:v for k,v in report.items() if k != 'syftVersion'}, indent=2))


if __name__ == '__main__':
    main()
