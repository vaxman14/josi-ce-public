"""Regression tests for redistribution checks that package lists alone miss."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('voice_sbom', Path(__file__).parents[2] / 'scripts/voice-box-sbom.py')
sbom = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sbom)


def layer(files):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode='w:gz') as archive:
        for name, data in files.items():
            item = tarfile.TarInfo(name); item.size = len(data)
            archive.addfile(item, io.BytesIO(data))
    return result.getvalue()


class ArtifactTests(unittest.TestCase):
    def test_deleted_codec_or_static_proprietary_code_still_blocks_distribution(self):
        for payload in (b'\x7fELF\0libavcodec.so.61\0', b'\x7fELF\0libcudart_static_private\0',
                        b'\x7fELF\0Intel(R) oneAPI Math Kernel Library Version\0'):
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as directory:
                objects = {}
                def put(data):
                    digest = 'sha256:' + hashlib.sha256(data).hexdigest()
                    objects['blobs/' + digest.replace(':', '/')] = data
                    return {'digest': digest}
                config = put(json.dumps({'architecture': 'amd64', 'os': 'linux'}).encode())
                layers = [put(layer({'usr/lib/hidden.so': payload})), put(layer({'usr/lib/.wh.hidden.so': b''}))]
                manifest = put(json.dumps({'config': config, 'layers': layers}).encode())
                objects['index.json'] = json.dumps({'manifests': [manifest]}).encode()
                path = Path(directory) / 'image.tar'
                with tarfile.open(path, 'w') as archive:
                    for name, data in objects.items():
                        item = tarfile.TarInfo(name); item.size = len(data)
                        archive.addfile(item, io.BytesIO(data))
                with self.assertRaisesRegex(ValueError, 'ELF'):
                    sbom.inspect(path, 'amd64')

    def test_unreviewed_upstream_audio_cannot_be_silently_patched(self):
        import patch_whisper
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / 'audio.py'
            original = b'changed upstream implementation\n'; audio.write_bytes(original)
            class Distribution:
                version = '1.2.1'
                def locate_file(self, _name): return audio
            with patch.object(patch_whisper.importlib.metadata, 'distribution', return_value=Distribution()):
                with self.assertRaisesRegex(ValueError, 'audio module changed'):
                    patch_whisper.patch()
            self.assertEqual(audio.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
