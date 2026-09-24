import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Button, Card, ErrorNote, Input } from '@/components/ui';

type Fields = { name:string; subject:string; heading:string; body:string; accentColor:string; ctaLabel:string; ctaUrl:string; footer:string };
type Template = Fields & {id:string};
type Preview = {subject:string;text:string;html:string};
const initial: Fields = {name:'Welcome',subject:'Welcome, {{name}}',heading:'A warm welcome',body:'Hello {{name}},\n\nThank you for getting in touch. We look forward to working with you.',accentColor:'#2563eb',ctaLabel:'',ctaUrl:'',footer:'Warm regards,\nYour team'};
const fields: [keyof Fields,string,number][] = [['name','Template name',120],['subject','Subject',300],['heading','Heading',300],['body','Body',30000],['accentColor','Accent color',7],['ctaLabel','Button label (optional)',120],['ctaUrl','Button URL (http or https)',2000],['footer','Footer / signature',2000]];

export function EmailTemplates() {
  const [templates,setTemplates] = useState<Template[]>([]);
  const [id,setId] = useState('');
  const [form,setForm] = useState<Fields>(initial);
  const [preview,setPreview] = useState<Preview|null>(null);
  const [previewError,setPreviewError] = useState('');
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [busy,setBusy] = useState(false);
  const [mobile,setMobile] = useState(false);
  const [recipient,setRecipient] = useState('');
  const [values,setValues] = useState({name:'',date:'',time:''});
  const [selection,setSelection] = useState('');
  const [plain,setPlain] = useState({subject:'',body:''});
  const [draft,setDraft] = useState<{summary:string;approval_id?:string}|null>(null);
  const [deleting,setDeleting] = useState(false);
  async function load() { const r = await api.get<{templates:Template[]}>('/mail/templates');setTemplates(r.templates); }
  useEffect(() => {void load().catch(e=>setError(e.message));},[]);
  useEffect(() => {
    let active=true;
    setPreview(null);
    const timer = setTimeout(() => {
      void api.post<Preview>('/mail/templates/preview',{template:form,recipient:'alex@example.test',merge_values:{name:'Alex',date:'September 18, 2026',time:'10:00 AM PDT'}})
        .then(r=>{if(active){setPreview(r);setPreviewError('');}}).catch(e=>{if(active)setPreviewError(e.message);});
    },200);
    return()=>{active=false;clearTimeout(timer);};
  },[form]);
  async function save() {
    setBusy(true);setError('');setNotice('');
    try {
      const r = id ? await api.put<{template:Template}>(`/mail/templates/${id}`,form) : await api.post<{template:Template}>('/mail/templates',form);
      setId(r.template.id);await load();setNotice('Template saved.');
    } catch(e){setError(e instanceof Error?e.message:'Could not save.');} finally{setBusy(false);}
  }
  async function remove() {
    setBusy(true);setError('');
    try{await api.del(`/mail/templates/${id}`);if(selection===id){setSelection('');setDraft(null);}setId('');setForm(initial);setDeleting(false);await load();setNotice('Template deleted. Approved drafts keep their original content.');}
    catch(e){setError(e instanceof Error?e.message:'Could not delete.');}finally{setBusy(false);}
  }
  async function prepare() {
    setBusy(true);setError('');setDraft(null);
    try {
      const r = await api.post<{state:string;summary:string;approval_id?:string;message?:string}>('/mail/templates/draft', {recipient,...(selection?{template_id:selection,merge_values:values}:plain)});
      if(r.state!=='prepared')throw new Error(r.message??'Complete the draft first.');
      setDraft(r);
    } catch(e){setError(e instanceof Error?e.message:'Could not prepare.');}finally{setBusy(false);}
  }
  return <div className="mx-auto w-full max-w-6xl space-y-5">
    <div><p className="text-sm text-muted-foreground">Email</p><h1 className="text-xl font-semibold">Templates</h1><p className="mt-1 text-sm text-muted-foreground">Private reusable messages, with a simple layout that works on desktop and mobile.</p></div>
    {error&&<ErrorNote>{error}</ErrorNote>}{notice&&<p role="status">{notice}</p>}
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-sm" htmlFor="template-picker">Saved template</label>
      <select id="template-picker" className="min-h-11 max-w-full rounded-md border border-input bg-background px-3" value={id} disabled={busy} onChange={e=>{const t=templates.find(t=>t.id===e.target.value);setId(t?.id??'');setForm(t?Object.fromEntries(fields.map(([k])=>[k,t[k]])) as Fields:initial);setDeleting(false);setNotice('');}}>
        <option value="">New template</option>{templates.map(t=><option key={t.id} value={t.id}>{t.name} · {t.id.slice(0,8)}</option>)}
      </select>
      <Button variant="secondary" disabled={busy} onClick={()=>{setId('');setForm(initial);setDeleting(false);}}>New template</Button>
    </div>
    {id&&<p className="break-all text-xs text-muted-foreground">Exact template ID for the assistant: <code>{id}</code></p>}
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <Card><form className="space-y-3" onSubmit={e=>{e.preventDefault();void save();}}>
        {fields.map(([key,label,max])=><label key={key} className="block space-y-1 text-sm"><span>{label}</span>
          {key==='body'||key==='footer'?<textarea className="w-full rounded-md border border-input bg-background p-3" rows={key==='body'?7:3} value={form[key]} maxLength={max} onChange={e=>setForm({...form,[key]:e.target.value})}/>:<Input type={key==='accentColor'?'color':'text'} required={['name','subject'].includes(key)} maxLength={max} value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})}/>}
        </label>)}
        <p className="text-xs text-muted-foreground">Text only. Blank lines create paragraphs; line breaks are preserved. HTML and Markdown are displayed as text.</p>
        <div className="flex flex-wrap gap-2"><Button disabled={busy}>Save template</Button>{id&&<Button type="button" variant="danger" disabled={busy} onClick={()=>setDeleting(true)}>Delete</Button>}</div>
        {deleting&&<div className="space-y-2"><p>Delete this saved template?</p><Button type="button" variant="danger" disabled={busy} onClick={()=>void remove()}>Confirm delete</Button> <Button type="button" variant="secondary" onClick={()=>setDeleting(false)}>Cancel</Button></div>}
      </form></Card>
      <Card><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Live preview</h2><div className="flex gap-2"><Button variant={mobile?'secondary':'primary'} aria-pressed={!mobile} onClick={()=>setMobile(false)}>Desktop</Button><Button variant={mobile?'primary':'secondary'} aria-pressed={mobile} onClick={()=>setMobile(true)}>Mobile</Button></div></div>
        <p className="mb-3 text-xs text-muted-foreground">Sample values: Alex, alex@example.test, September 18, 2026, 10:00 AM PDT.</p>
        {previewError&&!preview&&<ErrorNote>{previewError}</ErrorNote>}
        {preview&&<><p className="mb-3 break-words text-sm"><strong>Subject:</strong> {preview.subject}</p><iframe title="Email template preview" sandbox="" referrerPolicy="no-referrer" srcDoc={preview.html} className="mx-auto h-[540px] max-w-full rounded-md border border-border bg-white" style={{width:mobile?375:'100%'}}/><details className="mt-3"><summary className="cursor-pointer py-2 text-sm">Plain-text fallback</summary><pre className="whitespace-pre-wrap break-words text-sm">{preview.text}</pre></details></>}
      </Card>
    </div>
    <Card><h2 className="font-semibold">Merge fields</h2><p className="mt-2 text-sm">Use exactly <code>{'{{recipient}}'}</code> for the To address, <code>{'{{name}}'}</code> for the recipient’s supplied name, <code>{'{{date}}'}</code> for your supplied date text, and <code>{'{{time}}'}</code> for your supplied time text (include the time zone). Fields work in subject, heading, body, button label, and footer. Missing values stop the draft. Dates and times are never inferred or reformatted. Button URLs cannot contain merge fields.</p></Card>
    <Card><h2 className="font-semibold">Draft an email</h2><p className="mt-1 text-sm text-muted-foreground">Choose a saved template or write a plain message. Review the final content before approving on the Approvals page.</p>
      <form className="mt-4 space-y-3" onSubmit={e=>{e.preventDefault();void prepare();}}>
        <label className="block space-y-1 text-sm">Template<select className="min-h-11 w-full rounded-md border border-input bg-background px-3" value={selection} onChange={e=>{setSelection(e.target.value);setDraft(null);}}><option value="">No template — plain text</option>{templates.map(t=><option key={t.id} value={t.id}>{t.name} · {t.id.slice(0,8)}</option>)}</select></label>
        <label className="block space-y-1 text-sm">To<Input type="email" required value={recipient} onChange={e=>{setRecipient(e.target.value);setDraft(null);}}/></label>
        {selection?<div className="grid gap-3 sm:grid-cols-3">{(['name','date','time'] as const).map(k=><label className="block space-y-1 text-sm" key={k}>{k==='name'?'Recipient name':k==='date'?'Date text':'Time text + zone'}<Input value={values[k]} maxLength={500} onChange={e=>{setValues({...values,[k]:e.target.value});setDraft(null);}}/></label>)}</div>:<><label className="block space-y-1 text-sm">Subject<Input required maxLength={300} value={plain.subject} onChange={e=>{setPlain({...plain,subject:e.target.value});setDraft(null);}}/></label><label className="block space-y-1 text-sm">Body<textarea required className="w-full rounded-md border border-input bg-background p-3" rows={5} maxLength={30000} value={plain.body} onChange={e=>{setPlain({...plain,body:e.target.value});setDraft(null);}}/></label></>}
        <Button disabled={busy}>Prepare for approval</Button>
      </form>
      {draft&&<div className="mt-4 space-y-3 border-t border-border pt-4"><p className="text-sm">Prepared. No email has been sent.</p><pre className="whitespace-pre-wrap break-words text-sm">{draft.summary}</pre><Link className="inline-flex min-h-11 items-center underline" to="/app/approvals">Review and approve</Link></div>}
    </Card>
  </div>;
}
