import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from host_helper import Manager
from settings import DEFAULTS, validate
from download_models import download

IMAGE = 'ghcr.io/vaxman14/josi-voice-box:0.1.0@sha256:' + 'a' * 64
NEXT = 'ghcr.io/vaxman14/josi-voice-box:0.1.1@sha256:' + 'b' * 64


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.catalog = self.root / 'catalog.json'
        self.catalog.write_text(json.dumps({'releases': [{'image': IMAGE}]}))
        self.manager = Manager(self.root / 'state', self.catalog)

    def tearDown(self):
        self.temp.cleanup()

    def test_secret_is_private_and_survives_restart(self):
        token = self.manager.token
        self.assertEqual(len(token), 64)
        self.assertEqual((self.manager.root / 'token').stat().st_mode & 0o777, 0o600)
        self.assertEqual(Manager(self.manager.root, self.catalog).token, token)

    def test_compose_is_private_and_cannot_mount_docker(self):
        config = self.manager.compose(IMAGE, DEFAULTS)
        self.assertEqual(list(config['services']), ['voice-box'])
        service = config['services']['voice-box']
        self.assertNotIn('ports', service)
        self.assertEqual(service['network_mode'], 'none')
        self.assertNotIn('docker.sock', json.dumps(config))
        self.assertTrue(service['read_only'])
        self.assertEqual(service['cap_drop'], ['ALL'])
        self.assertNotIn('deploy', service)

    def test_closed_settings_and_catalog(self):
        for change in ({'voice': '../../bin/sh'}, {'engine': 'shell'}, {'model': 'http://host'},
                       {'threshold': float('nan')}, {'speed': True}, {'silenceMs': 1}, {'device': 'all'}):
            with self.assertRaises(ValueError):
                validate({**DEFAULTS, **change})
        with self.assertRaises(ValueError):
            validate({**DEFAULTS, 'command': 'id'})
        for image in ('ubuntu:latest', 'ghcr.io/vaxman14/josi-voice-box:0.1.0', 'sha256:' + 'a'*64):
            self.catalog.write_text(json.dumps({'releases': [{'image': image}]}))
            with self.assertRaises(ValueError):
                Manager(self.root / 'state', self.catalog)

    def test_operation_allowlist_and_health_gate(self):
        for operation, body in [('exec', {}), ('install', {'image': IMAGE}), ('settings', DEFAULTS),
                                ('update', {}), ('restart', {}), ('rollback', {})]:
            with self.assertRaises(ValueError):
                self.manager.start(operation, body)
        self.assertFalse(self.manager.lock.locked())
        self.manager.catalog = []
        with self.assertRaisesRegex(ValueError, 'authorized'):
            self.manager.start('install', {})

    def test_update_rolls_back_on_failed_health_and_preserves_other_data(self):
        self.manager.state.update(current=IMAGE, verified=True)
        self.manager.catalog.append({'image': NEXT})
        calls = []
        def activate(image, settings, pull):
            calls.append((image, settings, pull))
            if image == NEXT:
                raise ValueError('Model failed warm-up')
        self.manager.lock.acquire()
        with patch.object(self.manager, 'activate', side_effect=activate):
            self.manager.perform('update', {})
        self.assertEqual([c[0] for c in calls], [NEXT, IMAGE])
        self.assertEqual(self.manager.state['current'], IMAGE)
        self.assertEqual(self.manager.state['phase'], 'ready')
        self.assertIn('warm-up', self.manager.state['error'])
        self.assertEqual(json.loads(self.manager.statefile.read_text())['current'], IMAGE)

    def test_uninstall_only_removes_own_project_and_retains_config(self):
        self.manager.state.update(current=IMAGE, verified=True)
        (self.manager.root / 'compose.json').write_text('{}')
        with patch.object(self.manager, 'run') as run:
            self.manager.lock.acquire()
            self.manager.perform('uninstall', {})
            run.assert_called_once_with('down')
        self.assertFalse(self.manager.state['verified'])
        self.assertTrue((self.manager.root / 'token').exists())
        self.assertTrue((self.manager.root / 'compose.json').exists())

    def test_cli_has_fixed_project_service_and_environment(self):
        with patch('subprocess.run') as run:
            self.manager.run('restart', 'voice-box')
        args, kwargs = run.call_args
        self.assertEqual(args[0][:4], ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', 'compose'])
        self.assertEqual(args[0][-2:], ['restart', 'voice-box'])
        self.assertNotIn('shell', kwargs)
        self.assertEqual(set(kwargs['env']), {'PATH', 'HOME'})

    def test_api_readiness_is_not_model_readiness(self):
        self.manager.state['current'] = IMAGE
        with patch.object(self.manager, 'gateway', return_value=(200, 'application/json', b'{"apiReady":true,"modelsReady":false}')):
            result = self.manager.status()
        self.assertTrue(result['apiReady'])
        self.assertFalse(result['modelsReady'])
        self.assertFalse(result['healthy'])

    def test_corrupt_model_download_never_becomes_an_activated_file(self):
        source = self.root / 'download-source'
        source.write_bytes(b'changed bytes')
        entry = {'path': 'voice.onnx', 'url': source.as_uri(), 'size': 13, 'sha256': '0' * 64}
        with self.assertRaisesRegex(ValueError, 'checksum'):
            download(self.root / 'models', {'files': [entry]})
        self.assertFalse((self.root / 'models/voice.onnx').exists())

    def test_gpu_variant_is_not_selected_for_cpu_installs(self):
        self.manager.catalog.append({'image': NEXT, 'gpu': True})
        self.assertEqual(self.manager.selected_release()['image'], IMAGE)
        self.assertEqual(self.manager.selected_release(True)['image'], NEXT)


if __name__ == '__main__':
    unittest.main()
