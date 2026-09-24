import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';

type Provider = 'whatsapp' | 'slack';
interface Channel { provider: Provider; enabled: boolean; configured: boolean; riskAcknowledged: boolean; probedAt: string | null; probeOk: boolean | null; probeError: string | null }
const label = (p: Provider) => p === 'whatsapp' ? 'WhatsApp' : 'Slack';

export function AdminChannels() {
  const [channels, setChannels] = useState<Channel[]>([]); const [selected, setSelected] = useState<Provider>('whatsapp');
  const [form, setForm] = useState<Record<string,string>>({}); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setChannels((await api.get<{ channels: Channel[] }>('/admin/channels')).channels), []);
  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : 'Could not load channels')); }, [load]);
  const current = channels.find((c) => c.provider === selected);
  const fields = selected === 'whatsapp' ? [['appSecret','Meta app secret'],['accessToken','Permanent access token'],['phoneNumberId','Phone number ID'],['webhookSecret','Webhook verify token (enter the same value in Meta)']] : [['signingSecret','Signing secret'],['botToken','Bot token']];
  async function run(fn: () => Promise<unknown>, ok: string) { setBusy(true); setError(''); setNotice(''); try { await fn(); setNotice(ok); await load(); } catch(e) { setError(e instanceof Error ? e.message : 'That did not work'); } finally { setBusy(false); } }
  return <div className="mx-auto max-w-3xl space-y-4"><div><h1 className="text-xl font-semibold">Messaging channels</h1><p className="text-sm text-muted-foreground">Credentials are encrypted and never returned after saving.</p></div>{error ? <ErrorNote>{error}</ErrorNote> : null}{notice ? <p className="text-sm text-emerald-300">{notice}</p> : null}
    <div className="flex flex-wrap gap-2">
      <Link className="inline-flex min-h-11 items-center justify-center rounded-md bg-secondary px-4 text-sm font-medium hover:bg-secondary/80" to="/admin/telegram">Telegram</Link>
      {(['whatsapp','slack'] as Provider[]).map((p) => <Button key={p} aria-pressed={selected === p} variant={selected === p ? 'primary' : 'secondary'} onClick={() => { setSelected(p); setForm({}); }}>{label(p)}</Button>)}
    </div>
    <Card><CardTitle>{label(selected)}</CardTitle><div className="mb-3 flex gap-2"><Badge tone={current?.enabled ? 'ok' : 'muted'}>{current?.enabled ? 'On' : 'Off'}</Badge><Badge tone={current?.configured ? 'ok' : 'muted'}>{current?.configured ? 'Configured' : 'Not configured'}</Badge>{current?.probeOk === false ? <Badge tone="danger">Test failed</Badge> : null}</div>
      <div className="space-y-3">{fields.map(([name, title]) => <label key={name} className="block text-sm font-medium">{title}<Input type={name.toLowerCase().includes('url') || name === 'account' || name === 'phoneNumberId' ? 'text' : 'password'} autoComplete="off" value={form[name] ?? ''} onChange={(e) => setForm({...form,[name]:e.target.value})}/></label>)}
      <div className="flex flex-wrap gap-2"><Button disabled={busy || fields.some(([n]) => !form[n]?.trim())} onClick={() => void run(() => api.post(`/admin/channels/${selected}/config`, form), 'Configuration saved. Test it before enabling.')}>Save</Button><Button variant="secondary" disabled={busy || !current?.configured} onClick={() => void run(() => api.post(`/admin/channels/${selected}/probe`), 'Provider connection tested.')}>Test</Button><Button disabled={busy || !current?.probeOk} onClick={() => void run(() => api.post(`/admin/channels/${selected}/enabled`, {enabled:!current?.enabled}), current?.enabled ? 'Channel turned off.' : 'Channel turned on.')}>{current?.enabled ? 'Turn off' : 'Turn on'}</Button></div></div>
    </Card><Card><CardTitle>Webhook URLs</CardTitle><p className="text-sm text-muted-foreground">Configure each provider to deliver to <code>/channels/{selected}/webhook</code> on this installation. WhatsApp uses the same URL for verification.</p></Card></div>;
}
