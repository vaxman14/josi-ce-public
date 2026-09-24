#!/usr/bin/env python3
"""Real temporary Compose address application and failed-health rollback.
Requires the isolated josi-list7-validation stack from clean-install acceptance.
Never points at the live installation or pulls an image.
"""
import importlib.util,json,os,pathlib,socket,subprocess
root=pathlib.Path(__file__).resolve().parents[2]
project='josi-list7-validation'
assert (root/'secrets/master.key').exists(),'Run isolated clean-install acceptance first'
assert not (root/'.env').exists(),'Use a clean proof worktree without an existing .env'
probe=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);probe.connect(('192.0.2.1',9));lan=probe.getsockname()[0];probe.close()
(root/'.env').write_text('JOSI_IMAGE=josi-list7-validation\nJOSI_TAG=local\nJOSI_COOKIE_SECURE=false\nJOSI_ACCESS_MODE=lan\nJOSI_HTTP_PORT=18480\nJOSI_HTTPS_PORT=18443\nJOSI_APP_URL=http://'+lan+':18480\n')
os.chmod(root/'.env',0o600)
os.environ.update(JOSI_INSTALL_ROOT=str(root),JOSI_INSTALLER_HTML=str(root/'services/installer/index.html'),JOSI_EXISTING_INSTALL='1',JOSI_INSTALL_UID=str(os.getuid()),JOSI_INSTALL_GID=str(os.getgid()),JOSI_PROJECT_NAME=project)
spec=importlib.util.spec_from_file_location('controller',root/'services/installer/controller.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
# Suppress only the controller process-exit timer in this imported test harness.
class Timer:
 def __init__(self,*_):pass
 def start(self):pass
m.threading.Timer=Timer
compose=['docker','compose','--project-name',project]
subprocess.run(compose+['up','-d','--wait'],cwd=root,check=True,capture_output=True)
plan=dict(mode='lan',domain='',appUrl=f'http://{lan}:18481',httpPort=18481,httpsPort=18444,webPort=18482,workspaceEnabled=False)
m.install(plan)
assert m.PROGRESS['state']=='complete',m.PROGRESS
before=(root/'.env').read_bytes();metadata=m.address_metadata('snapshot')
assert metadata['workspace']['origin']==plan['appUrl']
assert metadata['deployment']['domain']==lan
verify=m.verify_public_origin
m.verify_public_origin=lambda origin:verify(origin,timeout=2)
bad={**plan,'httpPort':18483,'appUrl':f'http://{lan}:19999'}
m.install(bad)
assert m.PROGRESS['state']=='failed' and m.PROGRESS['rollbackComplete'],m.PROGRESS
assert (root/'.env').read_bytes()==before
assert m.address_metadata('snapshot')==metadata
verify(plan['appUrl'],timeout=5)
print('PASS real Compose/Caddy LAN address transition, public health verification failure, file restoration, exact PostgreSQL metadata/timestamp restoration, old origin healthy again')
