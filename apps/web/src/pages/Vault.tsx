import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, Empty, ErrorNote, Input } from '@/components/ui';

type Kind = 'api_key'|'oauth_token'|'password'|'secure_note'|'recovery_code'|'certificate'|'private_key'|'other';
interface Item { id:string; kind:Kind; service:string; slot:string; label:string; lastFour:string|null; updatedAt:string }
interface View { status:{initialized:boolean;locked:boolean}; box:{unlocked:boolean;items:Item[]} }

export function Vault() {
  const [view,setView]=useState<View|null>(null); const [password,setPassword]=useState('');
  const [form,setForm]=useState({kind:'password' as Kind,service:'',slot:'primary',label:'',value:''});
  const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
  const load=useCallback(async()=>{try{setView(await api.get<View>('/vault'));setError('');}catch(e){setError(e instanceof Error?e.message:'Could not read the Vault.');}},[]);
  useEffect(()=>{void load();},[load]);
  async function unlock(){setBusy(true);try{await api.post('/vault/unlock',{password});setPassword('');await load();}catch(e){setError(e instanceof Error?e.message:'Could not unlock the Vault.');}finally{setBusy(false);}}
  async function save(){setBusy(true);try{await api.post('/vault/items',form);setForm({...form,label:'',value:''});await load();}catch(e){setError(e instanceof Error?e.message:'Could not save the credential.');}finally{setBusy(false);}}
  return <div className="mx-auto w-full max-w-3xl space-y-4">
    <div><h1 className="text-xl font-semibold">Vault</h1><p className="text-sm text-muted-foreground">Your encrypted credentials. Values are never shown again after they are saved.</p></div>
    {error?<ErrorNote>{error}</ErrorNote>:null}
    {view?.status.locked?<Card><CardTitle>Master Vault locked</CardTitle><p className="text-sm text-muted-foreground">Credential-dependent work is unavailable until an administrator unlocks it.</p></Card>:null}
    {!view?.box.unlocked?<Card><CardTitle>Unlock for five minutes</CardTitle><p className="mb-3 text-sm text-muted-foreground">Re-enter your login password. This authorizes access; it is not an encryption key and is not retained.</p><div className="flex gap-2"><Input aria-label="Password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/><Button disabled={busy||!password} onClick={()=>void unlock()}>Unlock</Button></div></Card>:<>
      <Card><CardTitle>Store a credential</CardTitle><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Type<select className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3" value={form.kind} onChange={e=>setForm({...form,kind:e.target.value as Kind})}>{['password','api_key','oauth_token','secure_note','recovery_code','certificate','private_key','other'].map(k=><option key={k} value={k}>{k.replace('_',' ')}</option>)}</select></label><label className="text-sm">Service<Input autoComplete="off" data-1p-ignore data-lpignore="true" value={form.service} onChange={e=>setForm({...form,service:e.target.value})}/></label><label className="text-sm">Account or slot<Input autoComplete="off" data-1p-ignore data-lpignore="true" value={form.slot} onChange={e=>setForm({...form,slot:e.target.value})}/></label><label className="text-sm">Label<Input autoComplete="off" data-1p-ignore data-lpignore="true" value={form.label} onChange={e=>setForm({...form,label:e.target.value})}/></label><label className="text-sm sm:col-span-2">Secret<Input type="password" autoComplete="off" data-1p-ignore data-lpignore="true" value={form.value} onChange={e=>setForm({...form,value:e.target.value})}/></label></div><Button className="mt-3" disabled={busy||!form.service.trim()||!form.label.trim()||!form.value} onClick={()=>void save()}>Save encrypted</Button></Card>
      <Card><CardTitle>Saved credentials</CardTitle>{view.box.items.length?<div className="mt-3 space-y-2">{view.box.items.map(item=><div key={item.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.label}</p><p className="text-xs text-muted-foreground">{item.service} · {item.slot}{item.lastFour?` · ends in ${item.lastFour}`:''}</p></div><Badge>{item.kind.replace('_',' ')}</Badge><Button variant="secondary" disabled={busy} onClick={()=>void api.post(`/vault/items/${item.id}/test`).then(load).catch(e=>setError(String(e)))}>Check</Button><Button variant="danger" disabled={busy} onClick={()=>void api.del(`/vault/items/${item.id}`).then(load).catch(e=>setError(String(e)))}>Delete</Button></div>)}</div>:<Empty title="No credentials saved">New connections and credentials will be stored here.</Empty>}</Card>
    </>}
  </div>;
}
