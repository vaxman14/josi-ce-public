#!/usr/bin/env python3
"""Narrow supervisor that may only launch the short-lived Josi installer UI."""
import argparse, hashlib, ipaddress, json, os, re, secrets, socket, socketserver, ssl, subprocess, time, urllib.request
from http.server import BaseHTTPRequestHandler
from pathlib import Path

HOST=re.compile(r'^[A-Za-z0-9.-]{1,253}$')
class Manager:
 def __init__(self,root:Path,image:str,uid:int,gid:int,docker_gid:int): self.root=root.resolve();self.image=image;self.uid=uid;self.gid=gid;self.docker_gid=docker_gid;self.name='josi-ce-maintenance-'+hashlib.sha256(str(self.root).encode()).hexdigest()[:12]
 def launch(self,body):
  host=str(body.get('host','')).strip()
  if not HOST.fullmatch(host): raise ValueError('browser host is invalid')
  state=self.root/'installer-state';state.mkdir(mode=0o700,exist_ok=True);os.chmod(state,0o700);os.chown(state,self.uid,self.gid)
  code='-'.join((secrets.token_hex(2).upper(),secrets.token_hex(2).upper()))
  token=state/'bootstrap-token';token.write_text(code);os.chmod(token,0o600);os.chown(token,self.uid,self.gid)
  key,cert=state/'tls.key',state/'tls.crt'
  if not key.exists() or not cert.exists():
   subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=Josi Local Maintenance','-keyout',str(key),'-out',str(cert)],check=True,timeout=30,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   for path in (key,cert): os.chmod(path,0o600);os.chown(path,self.uid,self.gid)
  advertised=self.reachable_host(host)
  subprocess.run(['docker','rm','-f',self.name],check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  args=['docker','run','-d','--name',self.name,'--user',f'{self.uid}:{self.gid}','--group-add',str(self.docker_gid),'--rm','--read-only','--security-opt','no-new-privileges','--cap-drop','ALL','--tmpfs','/tmp:size=32m,mode=1777','-p',f'{advertised}:8080:8080','-v','/var/run/docker.sock:/var/run/docker.sock','-v',f'{self.root}:{self.root}','-w',str(self.root),'-e',f'JOSI_INSTALL_ROOT={self.root}','-e','JOSI_EXISTING_INSTALL=1','-e','JOSI_INSTALLER_PORT=8080','-e',f'JOSI_INSTALL_UID={self.uid}','-e',f'JOSI_INSTALL_GID={self.gid}','-e','JOSI_APP_GID=1000','-e',f'JOSI_DOCKER_GID={self.docker_gid}','-e',f'JOSI_INSTALLER_IMAGE={self.image}','-e','JOSI_VERSION=maintenance','--entrypoint','python3',self.image,'/opt/josi-installer/controller.py']
  try:
   subprocess.run(args,check=True,timeout=60,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
   self.wait_ready()
  except Exception:
   subprocess.run(['docker','rm','-f',self.name],check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   token.unlink(missing_ok=True)
   raise RuntimeError('temporary controller failed to start; verify that port 8080 is available') from None
  return {'url':f'https://{advertised}:8080','code':code,'expiresInSeconds':900}
 def reachable_host(self,browser_host):
  # The helper deliberately has no network. Ask Docker for the host route,
  # never advertise the helper/container's private bridge address.
  result=subprocess.run(['docker','run','--rm','--network','host',
   '--entrypoint','python3',self.image,'-c',
   "import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.connect(('192.0.2.1',9)); print(s.getsockname()[0]); s.close()"],
   check=True,capture_output=True,text=True,timeout=30)
  candidate=result.stdout.strip()
  address=ipaddress.ip_address(candidate)
  if not address.is_private or address.is_loopback: raise RuntimeError('no browser-reachable LAN address was found')
  return candidate
 def wait_ready(self):
  deadline=time.monotonic()+45
  # Probe inside the controller namespace. The supervisor has --network none.
  probe="import json,ssl,urllib.request; r=urllib.request.urlopen('https://127.0.0.1:8080/health',context=ssl._create_unverified_context(),timeout=2); assert r.status==200 and json.load(r).get('ok') is True"
  while time.monotonic()<deadline:
   running=subprocess.run(['docker','inspect','-f','{{.State.Running}}',self.name],capture_output=True,text=True,timeout=5).stdout.strip()
   if running!='true': raise RuntimeError('temporary controller exited before it became ready')
   result=subprocess.run(['docker','exec',self.name,'python3','-c',probe],capture_output=True,timeout=5)
   if result.returncode==0:return
   time.sleep(.5)
  raise RuntimeError('temporary controller readiness timed out')

class Handler(BaseHTTPRequestHandler):
 manager=None
 def do_POST(self):
  try:
   if self.path!='/launch': self.send_error(404);return
   size=int(self.headers.get('content-length','0'))
   if size>4096: raise ValueError('request is too large')
   result=self.manager.launch(json.loads(self.rfile.read(size) or b'{}'));self.send_response(201)
  except Exception as exc: result={'error':str(exc)};self.send_response(400)
  self.send_header('content-type','application/json');self.end_headers();self.wfile.write(json.dumps(result).encode())
 def log_message(self,*_): pass
def main():
 p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--socket',required=True);p.add_argument('--image',required=True);p.add_argument('--uid',type=int,required=True);p.add_argument('--gid',type=int,required=True);p.add_argument('--docker-gid',type=int,required=True);p.add_argument('--socket-gid',type=int,required=True);a=p.parse_args();Handler.manager=Manager(Path(a.root),a.image,a.uid,a.gid,a.docker_gid);path=Path(a.socket);path.unlink(missing_ok=True);path.parent.mkdir(parents=True,exist_ok=True)
 class Server(socketserver.ThreadingUnixStreamServer): daemon_threads=True
 with Server(str(path),Handler) as server: os.chmod(path,0o660);os.chown(path,-1,a.socket_gid);server.serve_forever()
if __name__=='__main__': main()
