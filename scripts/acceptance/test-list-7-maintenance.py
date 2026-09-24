#!/usr/bin/env python3
"""Exercise the actual isolated supervisor and LAN HTTPS controller; no live stack."""
import hashlib, http.client, json, os, pathlib, socket, ssl, subprocess, tempfile, time, urllib.request

def docker(*args):
    return subprocess.run(['docker', *args], check=True, capture_output=True, text=True).stdout.strip()

image = os.environ.get('JOSI_TEST_INSTALLER_IMAGE', 'josi-list7-installer:validation')
with tempfile.TemporaryDirectory(prefix='josi-list7-controller-') as directory:
    root=pathlib.Path(directory); gid=os.stat('/var/run/docker.sock').st_gid
    name='josi-list7-proof-'+hashlib.sha256(directory.encode()).hexdigest()[:8]
    controller='josi-ce-maintenance-'+hashlib.sha256(directory.encode()).hexdigest()[:12]
    try:
        docker('run','-d','--name',name,'--network','none','--user',f'{os.getuid()}:{os.getgid()}',
               '--group-add',str(gid),'--cap-drop','ALL','--security-opt','no-new-privileges',
               '-v','/var/run/docker.sock:/var/run/docker.sock','-v',f'{root}:{root}',
               '--entrypoint','python3',image,'/opt/josi-installer/maintenance_helper.py',
               '--root',str(root),'--socket',str(root/'helper.sock'),'--image',image,
               '--uid',str(os.getuid()),'--gid',str(os.getgid()),'--docker-gid',str(gid),'--socket-gid',str(os.getgid()))
        for _ in range(100):
            if (root/'helper.sock').exists(): break
            time.sleep(.1)
        conn=http.client.HTTPConnection('localhost',timeout=90)
        conn.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);conn.sock.connect(str(root/'helper.sock'))
        conn.request('POST','/launch',body=json.dumps({'host':'public.example.invalid'}),headers={'Content-Type':'application/json'})
        response=conn.getresponse(); result=json.loads(response.read()); assert response.status==201,result
        ctx=ssl._create_unverified_context()
        def request(path,body=None,cookie=None):
            headers={'X-Josi-Installer':'1','Content-Type':'application/json'}
            if cookie:headers['Cookie']=cookie
            req=urllib.request.Request(result['url']+path,data=json.dumps(body).encode() if body is not None else None,headers=headers)
            try:
                with urllib.request.urlopen(req,context=ctx,timeout=5) as res:return res.status,json.load(res),res.headers
            except urllib.error.HTTPError as res:return res.code,json.load(res),res.headers
        assert request('/health')[1]['ok'] is True
        assert request('/api/status')[0]==401
        assert request('/api/pair',{'code':'incorrect'})[0]==403
        status,_,headers=request('/api/pair',{'code':result['code']});assert status==200
        assert 'HttpOnly' in headers['Set-Cookie'] and 'Secure' in headers['Set-Cookie']
        assert request('/api/pair',{'code':result['code']})[0]==409
        print('PASS isolated --network none supervisor launches real LAN HTTPS controller; /health 200; unauthorized, wrong code and replay denied; secure session cookie')
    finally:
        for target in (controller,name):
            subprocess.run(['docker','rm','-f',target],capture_output=True)
