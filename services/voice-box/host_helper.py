#!/usr/bin/env python3
"""Operator-started Unix-socket helper. Never mount Docker's socket in Josi.

Only a fixed, generated Compose service is manageable. The catalog and private
state belong to the host operator, outside the directory mounted into the app.
HTTP callers cannot choose images, mounts, ports, project names or executables.
"""
import argparse
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socketserver
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler
from settings import DEFAULTS, validate
from bounded_http import BoundedRequests
from unix_http import UnixHTTPConnection


def atomic(path, value, uid=None, gid=None):
    temp = path.with_suffix('.tmp')
    with open(temp, 'w', opener=lambda p, flags: os.open(p, flags, 0o600)) as f:
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
        if uid is not None and gid is not None:
            os.fchown(f.fileno(), uid, gid)
    os.replace(temp, path)


class Manager:
    def __init__(self, directory, catalog, development=False, runtime_uid=None, runtime_gid=None):
        self.runtime_uid = os.getuid() if runtime_uid is None else runtime_uid
        self.runtime_gid = os.getgid() if runtime_gid is None else runtime_gid
        self.docker_path = shutil.which('docker')
        if self.docker_path not in ('/usr/bin/docker', '/usr/local/bin/docker'):
            raise ValueError('Docker CLI is unavailable')
        self.root = Path(directory).resolve()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.stat().st_mode & 0o077:
            raise ValueError('Private state directory must be mode 0700')
        self.catalog = json.loads(Path(catalog).read_text())['releases']
        for item in self.catalog:
            image = item['image']
            if not re.fullmatch(r'ghcr\.io/vaxman14/josi-voice-box:\d+\.\d+\.\d+(?:-gpu)?@sha256:[a-f0-9]{64}', image):
                if not development or not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
                    raise ValueError('Catalog requires a version and immutable image digest')
        self.lock = threading.Lock()
        (self.root / 'gateway').mkdir(mode=0o700, exist_ok=True)
        os.chown(self.root / 'gateway', self.runtime_uid, self.runtime_gid)
        self.project = 'josi-voice-' + hashlib.sha256(str(self.root).encode()).hexdigest()[:12]
        self.statefile = self.root / 'state.json'
        self.state = json.loads(self.statefile.read_text()) if self.statefile.exists() else {
            'phase': 'absent', 'verified': False, 'current': None, 'previous': None,
            'settings': dict(DEFAULTS), 'error': None}
        if self.state['phase'] == 'working':
            self.state['phase'] = 'failed'
            self.state['error'] = 'Host helper stopped during an operation. Restart or uninstall to recover.'
        tokenpath = self.root / 'token'
        if not tokenpath.exists():
            fd = os.open(tokenpath, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as f:
                f.write(secrets.token_hex(32))
            os.chown(tokenpath, self.runtime_uid, self.runtime_gid)
        self.token = tokenpath.read_text().strip()

    def save(self):
        atomic(self.statefile, self.state)

    def selected_release(self, gpu=False):
        matching = [entry for entry in self.catalog if bool(entry.get('gpu')) == gpu]
        if not matching:
            raise ValueError('No approved image is available for the selected device')
        return matching[-1]

    def compose(self, image, settings):
        service = {
            'image': image, 'restart': 'unless-stopped', 'user': f'{self.runtime_uid}:{self.runtime_gid}',
            'read_only': True, 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
            'pids_limit': 128, 'mem_limit': '4g', 'cpus': min(4, os.cpu_count() or 2),
            'network_mode': 'none', 'tmpfs': ['/tmp:size=64m,mode=1777'],
            'volumes': [f'{self.root}/token:/run/voice/token:ro', f'{self.root}/settings.json:/run/voice/settings.json:ro',
                        f'{self.root}/gateway:/run/voice/gateway'],
            'environment': {'HF_HUB_OFFLINE': '1', 'PYTHONDONTWRITEBYTECODE': '1'},
            'healthcheck': {'test': ['CMD', 'python', '/app/health.py'], 'interval': '10s',
                            'timeout': '5s', 'retries': 6, 'start_period': '90s'}}
        if settings['device'] == 'cuda':
            service['deploy'] = {'resources': {'reservations': {'devices': [
                {'driver': 'nvidia', 'count': 1, 'capabilities': ['gpu']}]}}}
        return {'services': {'voice-box': service}}

    def run(self, *args):
        # No inherited COMPOSE_FILE/DOCKER_HOST/DOCKER_CONTEXT or shell expansion.
        subprocess.run([self.docker_path, '--host', 'unix:///var/run/docker.sock', 'compose',
                        '--project-name', self.project, '--project-directory', str(self.root),
                        '--file', str(self.root / 'compose.json'), *args],
                       env={'PATH': '/usr/bin:/bin', 'HOME': str(self.root)},
                       check=True, timeout=600, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def gateway(self, method, path, body=None, timeout=45):
        connection = UnixHTTPConnection(self.root / 'gateway/gateway.sock', timeout=timeout)
        try:
            connection.request(method, path, json.dumps(body) if body is not None else None,
                               {'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
            response = connection.getresponse()
            data = response.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise ValueError('Voice response exceeded its limit')
            return response.status, response.getheader('Content-Type', 'application/json'), data
        finally:
            connection.close()

    def healthy(self):
        try:
            status, _, body = self.gateway('GET', '/ready', timeout=3)
            return status == 200 and json.loads(body).get('modelsReady') is True
        except (OSError, ValueError, http.client.HTTPException):
            return False

    def status(self):
        health = {'apiReady': False, 'modelsReady': False}
        if self.state['current'] or self.state['phase'] == 'working':
            try:
                code, _, data = self.gateway('GET', '/health', timeout=3)
                if code == 200:
                    health = json.loads(data)
            except (OSError, ValueError, http.client.HTTPException):
                pass
        healthy = health.get('apiReady') is True and health.get('modelsReady') is True
        return {**self.state, **health, 'healthy': healthy, 'helperAvailable': True,
                'releaseAvailable': bool(self.catalog), 'gpuAvailable': any(x.get('gpu') for x in self.catalog),
                'requirements': ['64-bit Linux, Docker Engine and Compose v2',
                                 '4 GB available RAM, 5 GB free disk, CPU with 2+ cores',
                                 'HTTPS or localhost for the browser microphone',
                                 'Initial image download; speech processing then runs locally']}

    def activate(self, image, settings, pull=True):
        atomic(self.root / 'settings.json', settings, self.runtime_uid, self.runtime_gid)
        atomic(self.root / 'compose.json', self.compose(image, settings))
        if pull and not image.startswith('sha256:'):
            self.run('pull', 'voice-box')
        self.run('up', '--detach', '--no-deps', '--force-recreate', '--pull', 'never', 'voice-box')
        for _ in range(90):
            if self.healthy():
                return
            time.sleep(2)
        raise ValueError('Voice Box did not pass the model and speech health check')

    def start(self, operation, body):
        if operation not in ('install', 'update', 'restart', 'uninstall', 'rollback', 'settings'):
            raise ValueError('Unsupported operation')
        if operation == 'settings':
            body = validate(body)
        elif body != {}:
            raise ValueError('This operation accepts no parameters')
        if not self.lock.acquire(blocking=False):
            raise ValueError('An operation is already running')
        try:
            if operation in ('settings', 'update', 'rollback') and not self.state['verified']:
                raise ValueError('Install and verify Voice Box first')
            if operation == 'install' and self.state['current']:
                raise ValueError('Voice Box is already installed')
            if operation in ('install', 'update') and not self.catalog:
                raise ValueError('No Voice Box image has been authorized for release yet')
            if operation == 'rollback' and not self.state['previous']:
                raise ValueError('No previous version is available')
            if operation == 'restart' and not self.state['current']:
                raise ValueError('Voice Box is not installed')
            if operation == 'settings' and body['device'] == 'cuda' and not any(
                    x.get('gpu') for x in self.catalog):
                raise ValueError('This image does not support GPU acceleration')
            self.state.update(phase='working', error=None)
            self.save()
            threading.Thread(target=self.perform, args=(operation, body), daemon=True).start()
        except Exception:
            self.lock.release()
            raise

    def perform(self, operation, body):
        old = {key: self.state[key] for key in ('current', 'settings', 'verified')}
        try:
            if operation == 'uninstall':
                if (self.root / 'compose.json').exists():
                    self.run('down')  # Own project only; retain configuration for recovery.
                self.state.update(current=None, previous=None, verified=False, phase='absent')
            else:
                if operation == 'install':
                    if shutil.disk_usage(self.root).free < 5 * 1024 ** 3:
                        raise ValueError('At least 5 GB of free disk is required')
                    available = next(int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()
                                     if line.startswith('MemAvailable:'))
                    if available < 4 * 1024 ** 2:
                        raise ValueError('At least 4 GB of available RAM is required')
                target = self.state['previous'] if operation == 'rollback' else {
                    'current': old['current'], 'settings': body if operation == 'settings' else old['settings']}
                if operation in ('install', 'update'):
                    target['current'] = self.selected_release(target['settings']['device'] == 'cuda')['image']
                elif operation == 'settings' and body['device'] == 'cuda':
                    target['current'] = self.selected_release(True)['image']
                self.activate(target['current'], target['settings'],
                              operation in ('install', 'update') or target['current'] != old['current'])
                self.state.update(current=target['current'], settings=target['settings'], verified=True, phase='ready')
                if old['current'] and operation in ('update', 'settings', 'rollback'):
                    self.state['previous'] = old
        except Exception as error:
            recovered = False
            try:
                if old['current']:
                    self.activate(old['current'], old['settings'], False)
                    recovered = True
                elif (self.root / 'compose.json').exists():
                    self.run('down')
            except Exception:
                pass
            self.state.update(**old, phase='ready' if recovered else 'failed',
                              error=str(error) if isinstance(error, ValueError) else 'Voice Box operation failed. Inspect host service logs.')
        finally:
            try:
                self.save()
            finally:
                self.lock.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Never log audio, transcript, credentials or user identifiers.

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def dispatch(self):
        try:
            if self.headers.get('Transfer-Encoding'):
                raise ValueError('Chunked requests are not supported')
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 <= length <= 100000:
                raise ValueError('Request is too large')
            self.connection.settimeout(10)
            body = json.loads(self.rfile.read(length)) if length else {}
            manager = self.server.manager
            if self.command == 'GET' and self.path == '/status':
                result = manager.status()
            elif self.command == 'POST' and self.path.startswith('/operation/'):
                manager.start(self.path.removeprefix('/operation/'), body)
                result = {'accepted': True}
            elif self.command == 'POST' and self.path in ('/session', '/audio', '/close', '/speech'):
                if not manager.state['verified'] or manager.state['phase'] != 'ready':
                    raise ValueError('Voice Box is not ready')
                status, content_type, data = manager.gateway('POST', self.path, body)
                self.reply(status, data, content_type)
                return
            else:
                self.reply(404, b'{"error":"Unknown operation"}')
                return
            self.reply(200, json.dumps(result).encode())
        except (ValueError, KeyError):
            self.reply(400, b'{"error":"Voice Box request refused. Check its status and settings."}')
        except Exception:
            self.reply(503, b'{"error":"Voice Box is unavailable"}')

    def reply(self, status, data, content_type='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(BoundedRequests, socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    block_on_close = False


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', required=True)
    parser.add_argument('--socket', required=True)
    parser.add_argument('--catalog', default=str(Path(__file__).with_name('catalog.json')))
    parser.add_argument('--development', action='store_true')
    parser.add_argument('--runtime-uid', type=int)
    parser.add_argument('--runtime-gid', type=int)
    parser.add_argument('--socket-gid', type=int)
    args = parser.parse_args()
    manager = Manager(args.state, args.catalog, args.development, args.runtime_uid, args.runtime_gid)
    process_lock = open(manager.root / 'helper.lock', 'a')
    fcntl.flock(process_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    socket = Path(args.socket)
    socket.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    if socket.exists():
        if not socket.is_socket():
            raise ValueError('Refusing to replace a non-socket file')
        socket.unlink()
    with Server(str(socket), Handler) as server:
        os.chmod(socket, 0o660)
        if args.socket_gid is not None:
            os.chown(socket, manager.runtime_uid, args.socket_gid)
        server.manager = manager
        server.serve_forever()
