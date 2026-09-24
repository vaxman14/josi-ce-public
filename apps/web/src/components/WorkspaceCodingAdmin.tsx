import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
export function WorkspaceCodingAdmin(){
 const [people,setPeople]=useState<{user_id:string;username:string;coding_enabled:boolean}[]>([]),[error,setError]=useState('');
 useEffect(()=>{void api.get<{users:{user_id:string;username:string;coding_enabled:boolean}[]}>('/storage/admin/capabilities').then(r=>setPeople(r.users??[])).catch(e=>setError(e.message));},[]);
 return <section className="space-y-3 rounded border p-4"><h2 className="font-semibold">Coding sandbox access</h2><p>Disabled by default. Enabling permits a person to submit JavaScript to the separately installed sandbox helper. Every execution still needs that person’s approval. No host mounts or network are granted.</p>{error&&<p role="alert">{error}</p>}{people.map(p=><label className="flex gap-3" key={p.user_id}><input type="checkbox" checked={!!p.coding_enabled} onChange={e=>{const enabled=e.target.checked;void api.put(`/workspace/admin/coding/${p.user_id}`,{enabled}).then(()=>setPeople(a=>a.map(x=>x.user_id===p.user_id?{...x,coding_enabled:enabled}:x))).catch(e=>setError(e.message));}}/>{p.username}</label>)}</section>;
}
