#!/usr/bin/env python3
"""Opt-in code runner. No host file mounts, credentials, shell or network grants.

The app only gets this Unix socket. Docker authority remains in this helper.
Each run receives submitted JavaScript on stdin in a new isolated container.
"""
import argparse
import json
import os
import re
import selectors
import shutil
import socketserver
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
IMAGE = re.compile(r'^[a-zA-Z0-9./:_-]+@sha256:[0-9a-f]{64}$')
MAX_SOURCE = 262144
MAX_OUTPUT = 65536

class Manager:
    def __init__(self, image, docker=None):
        if not IMAGE.fullmatch(image):
            raise ValueError('The sandbox image must be pinned by sha256 digest')
        self.image, self.docker = image, docker or shutil.which('docker')
        if self.docker not in ('/usr/bin/docker','/usr/local/bin/docker'):
            raise ValueError('Docker CLI unavailable')
        self.runs, self.lock = {}, threading.Lock()

    def recover(self):
        # A restarted helper must not leave a timed-out or cancelled container running.
        found = subprocess.run([self.docker, '--host', 'unix:///var/run/docker.sock', 'ps', '-aq',
                                '--filter', 'label=josi.coding-sandbox=true'], check=True,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, text=True)
        for container in found.stdout.split():
            if re.fullmatch(r'[0-9a-f]{12,64}',container):
                subprocess.run([self.docker,'--host','unix:///var/run/docker.sock','rm','-f',container],
                               stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,check=True)

    def command(self, run_id, mode):
        if not UUID.fullmatch(run_id) or mode not in ('check', 'run'):
            raise ValueError('Invalid run or command')
        return [self.docker, '--host', 'unix:///var/run/docker.sock', 'run', '--rm', '--pull=never',
                '--name', 'josi-code-' + run_id, '--label', 'josi.coding-sandbox=true',
                '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                '--user=65534:65534', '--pids-limit=32', '--memory=128m', '--memory-swap=128m',
                '--cpus=0.5', '--ulimit=nofile=64:64', '--ulimit=fsize=1048576:1048576',
                '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777', '--workdir=/tmp',
                '--env=HOME=/tmp', '--env=NODE_OPTIONS=', '--log-driver=none', '-i',
                '--entrypoint=node', self.image, *(['--check'] if mode == 'check' else []), '-']

    def start(self, body):
        run_id, mode, source = body.get('id', ''), body.get('mode', ''), body.get('source', '')
        command = self.command(run_id, mode)
        if not isinstance(source, str) or len(source.encode()) > MAX_SOURCE:
            raise ValueError('Source exceeds 256 KiB')
        with self.lock:
            # Expire completed receipts; never discard a running cancellation handle.
            self.runs = {k:v for k,v in self.runs.items() if v['status']=='running' or time.monotonic()-v['created']<3600}
            if run_id in self.runs:
                raise ValueError('Run already exists')
            if sum(v['status']=='running' for v in self.runs.values()) >= 2:
                raise ValueError('Sandbox is busy; retry after current work completes')
            state = {'status':'running', 'output':'', 'created':time.monotonic(), 'cancel':threading.Event()}
            self.runs[run_id] = state
        threading.Thread(target=self.execute, args=(run_id, command, source, state), daemon=True).start()
        return {'id':run_id, 'status':'running'}

    def remove(self, run_id):
        subprocess.run([self.docker, '--host', 'unix:///var/run/docker.sock', 'rm', '-f', 'josi-code-'+run_id],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, check=False)

    def execute(self, run_id, command, source, state):
        proc = None
        output = bytearray()
        try:
            proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    env={'PATH':'/usr/bin:/bin','HOME':'/tmp'}, start_new_session=True)
            def send_source():
                try:
                    proc.stdin.write(source.encode()); proc.stdin.close()
                except (BrokenPipeError, OSError):
                    pass
            threading.Thread(target=send_source, daemon=True).start()
            selector = selectors.DefaultSelector()
            selector.register(proc.stdout, selectors.EVENT_READ)
            deadline = time.monotonic()+30
            reason = None
            while True:
                if state['cancel'].is_set(): reason='cancelled'; break
                if time.monotonic()>deadline: reason='Time limit (30 seconds) exceeded'; break
                ready = selector.select(0.1)
                if ready:
                    chunk = os.read(proc.stdout.fileno(), 8192)
                    if not chunk: break
                    output.extend(chunk)
                    if len(output)>MAX_OUTPUT: reason='Output limit (64 KiB) exceeded'; break
                elif proc.poll() is not None:
                    break
            selector.close()
            if reason:
                # Close the attach client before removal: a full stdout pipe can
                # otherwise backpressure Docker and stall container teardown.
                proc.kill()
                proc.stdout.close()
                self.remove(run_id)
            exit_code = proc.wait(timeout=5)
            with self.lock:
                state.update(status='cancelled' if reason=='cancelled' else 'failed' if reason or exit_code else 'completed',
                             output=output[:MAX_OUTPUT].decode('utf8', errors='replace'), exitCode=exit_code, error=reason)
        except Exception as exc:
            with self.lock:
                state.update(status='failed', output=output[:MAX_OUTPUT].decode('utf8', errors='replace'), error='Sandbox unavailable. Check pinned image and helper permissions.', errorCode=type(exc).__name__)
        finally:
            if proc and proc.poll() is None: proc.kill()
            try: self.remove(run_id)
            except Exception: pass

    def status(self, body, cancel=False):
        run_id=body.get('id','')
        if not UUID.fullmatch(run_id): raise ValueError('Invalid run')
        with self.lock:
            state=self.runs.get(run_id)
            if state is None:
                return {'status':'failed','error':'Run unavailable after helper restart; no changes were applied to workspace files.'}
            if cancel: state['cancel'].set()
            return {k:v for k,v in state.items() if k not in ('cancel','created')}

class Handler(BaseHTTPRequestHandler):
    manager = None
    def do_POST(self):
        try:
            size=int(self.headers.get('content-length','0'))
            if size<0 or size>MAX_SOURCE*6+4096: raise ValueError('Request too large')
            body=json.loads(self.rfile.read(size))
            if self.path=='/run': result=self.manager.start(body)
            elif self.path=='/status': result=self.manager.status(body)
            elif self.path=='/cancel': result=self.manager.status(body, True)
            else: self.send_error(404); return
            self.send_response(200); self.send_header('content-type','application/json'); self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        except Exception:
            self.send_response(400); self.send_header('content-type','application/json'); self.end_headers()
            self.wfile.write(b'{"error":"Sandbox request refused. Check command, source size, image and concurrency limits."}')
    def log_message(self, *_): pass

def main():
    p=argparse.ArgumentParser(); p.add_argument('--socket',required=True); p.add_argument('--socket-gid',type=int,default=1000); p.add_argument('--image',required=True); a=p.parse_args()
    Handler.manager=Manager(a.image)
    Handler.manager.recover()
    os.makedirs(os.path.dirname(a.socket),exist_ok=True)
    try: os.unlink(a.socket)
    except FileNotFoundError: pass
    class Server(socketserver.ThreadingUnixStreamServer): daemon_threads=True
    with Server(a.socket,Handler) as server:
        os.chmod(a.socket,0o660); os.chown(a.socket,-1,a.socket_gid); server.serve_forever()
if __name__=='__main__': main()
