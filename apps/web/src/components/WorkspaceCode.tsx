import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
export function WorkspaceCode({mappingId}:{mappingId:string}){
 const [source,setSource]=useState(''),[mode,setMode]=useState('check'),[id,setId]=useState(''),[status,setStatus]=useState(''),[output,setOutput]=useState(''),[error,setError]=useState('');
 useEffect(()=>{if(status!=='running'||!id)return;let stopped=false;const timer=setInterval(()=>{void api.get<{status:string;output?:string;error?:string}>(`/workspace/code/${id}`).then(r=>{if(!stopped){setStatus(r.status);setOutput(r.output??r.error??'');}}).catch(e=>{if(!stopped)setError(e.message);});},1000);return()=>{stopped=true;clearInterval(timer);};},[id,status]);
 useEffect(()=>{setId('');setStatus('');setSource('');setOutput('');},[mappingId]);
 return <section className="space-y-3 rounded border p-3"><h2 className="font-semibold">Coding sandbox</h2><p>Administrator opt-in required. Each run is isolated: JavaScript only, 30 seconds, 128 MiB, no network or host files. Dependency installation, Git, shell commands and automatic workspace writes are unavailable. Review every source line before approval.</p>
 {error&&<p role="alert">{error}</p>}<label className="block">Operation <select disabled={status==='pending'||status==='running'} className="rounded border bg-background p-2" value={mode} onChange={e=>setMode(e.target.value)}><option value="check">Check syntax</option><option value="run">Execute JavaScript</option></select></label>
 <label className="block">Exact source<textarea disabled={status==='pending'||status==='running'} className="block min-h-32 w-full rounded border bg-background p-2 font-mono" value={source} onChange={e=>setSource(e.target.value)} maxLength={262144}/></label>
 {!['pending','running'].includes(status)&&<button onClick={()=>{setError('');void api.post<{id:string;status:string}>(`/workspace/${mappingId}/code`,{mode,source}).then(r=>{setId(r.id);setStatus(r.status);}).catch(e=>setError(e.message));}}>Prepare for review</button>}
 {status==='pending'&&<button onClick={()=>{setError('');void api.post<{status:string}>(`/workspace/code/${id}/start`,{confirm:true}).then(r=>setStatus(r.status)).catch(e=>setError(e.message));}}>Approve this exact source and {mode==='check'?'check syntax':'execute'}</button>}
 {['pending','running'].includes(status)&&<button className="ml-4" onClick={()=>{void api.post<{status:string}>(`/workspace/code/${id}/cancel`).then(r=>setStatus(r.status)).catch(e=>setError(e.message));}}>Cancel run</button>}
 {status&&<p role="status">Run {id}: {status}</p>}{output&&<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border p-3">{output}</pre>}
 </section>;
}
