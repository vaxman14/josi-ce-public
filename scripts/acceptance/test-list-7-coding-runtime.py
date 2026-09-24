"""Run inside the installer helper image with only Docker socket and test sources.
Uses real disposable containers; no live application/gate mutation.
"""
import importlib.util, json, shutil, time, uuid
spec=importlib.util.spec_from_file_location('coding','/test/coding_helper.py'); mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
m=mod.Manager('node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5',shutil.which('docker'))
def run(source,mode='run',cancel=False):
 id=str(uuid.uuid4());m.start({'id':id,'mode':mode,'source':source})
 if cancel:
  time.sleep(1);m.status({'id':id},True)
 deadline=time.monotonic()+45
 while time.monotonic()<deadline:
  result=m.status({'id':id})
  if result['status']!='running':return result
  time.sleep(.1)
 raise AssertionError('runner did not terminate')
results=[]
def check(name,source,predicate,**kwargs):
 result=run(source,**kwargs);assert predicate(result),(name,{k:v for k,v in result.items() if k!='output'},len(result.get('output','')));results.append({'check':name,'status':result['status']})
check('execute JavaScript',"console.log(6*7)",lambda r:r['status']=='completed' and r['output'].strip()=='42')
check('syntax failure',"const = ;",lambda r:r['status']=='failed',mode='check')
check('host credentials and sockets unavailable',"const fs=require('fs');for(const p of ['/home/roman/.ssh','/var/run/docker.sock','/app','/data/roots','/run/secrets'])if(fs.existsSync(p))throw Error('host exposed');console.log('isolated')",lambda r:r['status']=='completed')
check('read-only root and unprivileged uid',"const fs=require('fs');if(process.getuid()===0)throw Error('root');try{fs.writeFileSync('/escape','x');throw Error('writable')}catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e}console.log('restricted')",lambda r:r['status']=='completed')
check('network denied',"fetch('https://example.com',{signal:AbortSignal.timeout(2000)}).then(()=>process.exit(1)).catch(()=>console.log('blocked'))",lambda r:r['status']=='completed' and 'blocked' in r['output'])
check('cancel runaway code','while(true){}',lambda r:r['status']=='cancelled',cancel=True)
check('output bounded',"while(true)console.log('x'.repeat(8192))",lambda r:r['status']=='failed' and len(r['output'])<=65536 and 'Output limit' in r['error'])
check('memory bounded',"const a=[];while(true)a.push(Buffer.alloc(16*1024*1024,1))",lambda r:r['status']=='failed')
check('time bounded','while(true){}',lambda r:r['status']=='failed' and 'Time limit' in r['error'])
print(json.dumps({'result':'PASS','runtime':'Docker isolated pinned Node image','checks':results},indent=2))
