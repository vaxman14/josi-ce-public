import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useResource } from '@/lib/useResource';
import { ResourceFallback } from '@/components/ResourceFallback';
import { Badge, Button, Card, CardTitle, ErrorNote } from '@/components/ui';

interface AdminAssistant { counts: { threads: number; messages: number; tasks: number; openTasks: number; contacts: number }; perUser: Array<{ user_id: string; username: string; tasks: number; threads: number }>; metrics: { tasks: number; interrupt_rate: number; correction_rate: number; reviewed: number } }
interface Checklist { complete: boolean; progress: { done: number; total: number }; reminders: unknown[] }
interface Model { primary: { active: boolean; probedAt: string | null } | null }
interface Backups { backups: Array<{ state: string }> }
interface Channels { channels: Array<{ configured: boolean; enabled: boolean; probeOk: boolean | null }> }
interface Voice { helperAvailable: boolean; healthy: boolean; verified: boolean; phase: string }
interface VaultHealth { status:{initialized:boolean;locked:boolean;recentFailures:number} }
type HealthState = 'working' | 'attention' | 'unavailable' | 'unconfigured';
interface Check { label: string; state: HealthState; detail: string; href: string }
const LABEL: Record<HealthState, string> = { working: 'Working', attention: 'Needs attention', unavailable: 'Unavailable', unconfigured: 'Not configured' };
const TONE: Record<HealthState, 'ok' | 'danger' | 'muted'> = { working: 'ok', attention: 'danger', unavailable: 'danger', unconfigured: 'muted' };

export function AdminOverview() {
  const navigate = useNavigate();
  const assistantResource = useResource<AdminAssistant>('/admin/assistant');
  const [data, setData] = useState<AdminAssistant | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    if (assistantResource.state === 'ready' && assistantResource.data) setData(assistantResource.data);
  }, [assistantResource.state, assistantResource.data]);
  const runChecks = useCallback(async () => {
    setLoading(true); setError('');
    const [assistant, launch, model, storage, backups, channels, voice, vault] = await Promise.allSettled([
      api.get<AdminAssistant>('/admin/assistant'), api.get<Checklist>('/admin/launch-checklist'), api.get<Model>('/admin/llm'),
      api.get<{ policy: unknown }>('/storage/admin/policy'), api.get<Backups>('/ops/admin/backups'),
      api.get<Channels>('/admin/channels'), api.get<Voice>('/admin/voice-box'),api.get<VaultHealth>('/admin/vault'),
    ]);
    if (assistant.status === 'fulfilled') setData(assistant.value);
    else setError('The API or database did not answer. Other checks may also be incomplete.');
    const channelList = channels.status === 'fulfilled' ? channels.value.channels : [];
    const backupList = backups.status === 'fulfilled' ? backups.value.backups : [];
    setChecks([
      { label: 'API and database', state: assistant.status === 'fulfilled' ? 'working' : 'unavailable', detail: assistant.status === 'fulfilled' ? 'The application can read installation data.' : 'The core installation check failed.', href: '/admin/diagnostics' },
      { label: 'AI model', state: model.status !== 'fulfilled' ? 'unavailable' : !model.value.primary ? 'unconfigured' : model.value.primary.active && model.value.primary.probedAt ? 'working' : 'attention', detail: model.status !== 'fulfilled' ? 'Model status could not be read.' : !model.value.primary ? 'Choose and test a model before using Josi.' : model.value.primary.active && model.value.primary.probedAt ? 'The active model passed its readiness test.' : 'The selected model still needs a successful test.', href: '/admin/model' },
      { label: 'Storage', state: storage.status === 'fulfilled' ? 'working' : 'unavailable', detail: storage.status === 'fulfilled' ? 'Storage policy is available.' : 'Storage settings could not be read.', href: '/admin/storage' },
      { label: 'Backups', state: backups.status !== 'fulfilled' ? 'unavailable' : backupList.some((item) => item.state === 'complete') ? 'working' : 'unconfigured', detail: backups.status !== 'fulfilled' ? 'Backup history could not be read.' : backupList.some((item) => item.state === 'complete') ? 'At least one backup completed.' : 'Backups are optional and none have been created.', href: '/admin/backups' },
      {label:'Master Vault',state:vault.status!=='fulfilled'?'unavailable':!vault.value.status.initialized?'unconfigured':vault.value.status.locked||vault.value.status.recentFailures>0?'attention':'working',detail:vault.status!=='fulfilled'?'Vault health could not be read.':!vault.value.status.initialized?'Initialize the Master Vault and save its recovery key offline.':vault.value.status.locked?'The Master Vault is locked; credential jobs are stopped.':vault.value.status.recentFailures?`${vault.value.status.recentFailures} credential jobs were blocked in the last 24 hours.`:'The Master Vault is available.',href:'/admin/vault'},
      { label: 'Channels and connections', state: channels.status !== 'fulfilled' ? 'unavailable' : channelList.some((item) => item.enabled && item.probeOk) ? 'working' : channelList.some((item) => item.configured) ? 'attention' : 'unconfigured', detail: channels.status !== 'fulfilled' ? 'Channel status could not be read.' : channelList.some((item) => item.enabled && item.probeOk) ? 'At least one channel is enabled and tested.' : channelList.some((item) => item.configured) ? 'A configured channel still needs a successful test or enabling.' : 'No optional external messaging channel is configured.', href: '/admin/channels' },
      { label: 'Voice Box', state: voice.status !== 'fulfilled' ? 'unavailable' : !voice.value.helperAvailable || voice.value.phase === 'absent' ? 'unconfigured' : voice.value.healthy && voice.value.verified ? 'working' : 'attention', detail: voice.status !== 'fulfilled' ? 'Voice Box status could not be read.' : voice.value.healthy && voice.value.verified ? 'Voice Box is installed, verified, and healthy.' : !voice.value.helperAvailable || voice.value.phase === 'absent' ? 'Voice Box is optional and is not installed.' : 'Voice Box is installed but not ready.', href: '/admin/voice-box' },
      { label: 'Security and setup', state: launch.status !== 'fulfilled' ? 'unavailable' : launch.value.complete ? 'working' : launch.value.reminders.length ? 'attention' : 'unconfigured', detail: launch.status !== 'fulfilled' ? 'Setup requirements could not be read.' : launch.value.complete ? 'The launch checklist is complete.' : `${launch.value.progress.done} of ${launch.value.progress.total} launch items are settled.`, href: '/admin/launch' },
    ]);
    setCheckedAt(new Date()); setLoading(false);
  }, []);
  useEffect(() => { void runChecks(); }, [runChecks]);
  const priority: Record<HealthState, number> = { attention: 0, unavailable: 1, unconfigured: 2, working: 3 };
  const recommendations = checks.filter((item) => item.state !== 'working')
    .filter((item) => item.state !== 'unconfigured' || ['AI model', 'Security and setup'].includes(item.label))
    .sort((a, b) => priority[a.state] - priority[b.state]);
  return <div className="mx-auto w-full min-w-0 max-w-4xl space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold tracking-tight">Overview</h1><p className="mt-1 text-sm text-muted-foreground">Installation readiness, activity, and problems that need action.</p></div><Button variant="secondary" disabled={loading} onClick={() => void runChecks()}>{loading ? 'Checking…' : 'Check again'}</Button></div>
    {checkedAt ? <p className="text-xs text-muted-foreground">Last checked {checkedAt.toLocaleString()}</p> : null}{error ? <ErrorNote>{error}</ErrorNote> : null}
    {assistantResource.state !== 'ready' ? <ResourceFallback resource={assistantResource} /> : null}
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[['Conversations', data?.counts.threads], ['Messages', data?.counts.messages], ['Tasks', data?.counts.tasks], ['Open', data?.counts.openTasks]].map(([label, value]) => <Card key={String(label)}><p className="text-xs text-muted-foreground">{label}</p><p className="text-2xl font-semibold tabular-nums">{value ?? '—'}</p></Card>)}</div>
    <Card><CardTitle>System checkup</CardTitle><div className="mt-3 grid gap-3 sm:grid-cols-2">{checks.map((item) => <button type="button" key={item.label} onClick={() => navigate(item.href)} className="min-h-11 rounded-md border border-border p-3 text-left hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{item.label}</span><Badge tone={TONE[item.state]}>{LABEL[item.state]}</Badge></span><span className="mt-1 block text-xs text-muted-foreground">{item.detail}</span></button>)}</div></Card>
    <Card><CardTitle>Recommendations</CardTitle>{loading && !checks.length ? <p className="text-sm text-muted-foreground">Running system checks…</p> : recommendations.length ? <ol className="mt-2 space-y-3">{recommendations.map((item, index) => <li key={item.label} className="flex flex-wrap items-start gap-3"><span className="mt-0.5 text-sm font-semibold text-muted-foreground">{index + 1}</span><div className="min-w-48 flex-1"><p className="text-sm font-medium">Fix {item.label.toLowerCase()}</p><p className="text-xs text-muted-foreground">{item.detail}</p></div><Button variant="secondary" onClick={() => navigate(item.href)}>Review</Button></li>)}</ol> : <p className="text-sm text-emerald-400">No essential problems found.</p>}</Card>
    {data ? <><Card><CardTitle>How reliably work completes</CardTitle><p className="text-sm text-muted-foreground">Interrupt rate {(data.metrics.interrupt_rate * 100).toFixed(0)}%. Correction rate {(data.metrics.correction_rate * 100).toFixed(0)}% across {data.metrics.reviewed} reviewed task{data.metrics.reviewed === 1 ? '' : 's'}.</p></Card><Card><CardTitle>Activity per person</CardTitle><div className="-mx-4 overflow-x-auto px-4"><table className="w-full min-w-[20rem] text-sm"><thead><tr className="text-left text-muted-foreground"><th className="py-1 font-medium">Person</th><th className="py-1 text-right font-medium">Conversations</th><th className="py-1 text-right font-medium">Tasks</th></tr></thead><tbody>{data.perUser.map((user) => <tr key={user.user_id} className="border-t border-border"><td className="py-2">{user.username}</td><td className="py-2 text-right tabular-nums">{user.threads}</td><td className="py-2 text-right tabular-nums">{user.tasks}</td></tr>)}</tbody></table></div></Card></> : null}
  </div>;
}
