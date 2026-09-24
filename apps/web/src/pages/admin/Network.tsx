import { useId, useState } from 'react';
import { api } from '@/lib/api';
import { Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';

export function AdminNetwork() {
  const passwordId = useId();
  const helpId = useId();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [launch, setLaunch] = useState<{ url: string; code: string } | null>(null);

  async function open() {
    if (!password) { setError('Enter your current Josi administrator password.'); return; }
    setBusy(true); setError(''); setLaunch(null);
    try {
      const value = await api.post<{ url: string; code: string }>('/admin/maintenance/network/launch', { password, host: window.location.hostname });
      setPassword(''); setLaunch(value);
      window.open(value.url, 'josi-maintenance', 'noopener,noreferrer');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start protected maintenance. Try again.');
    } finally { setBusy(false); }
  }

  return <div className="mx-auto max-w-3xl space-y-4">
    <div><h1 className="text-2xl font-semibold">Network &amp; address</h1><p className="text-sm text-muted-foreground">Change LAN, public-domain, reverse-proxy, and port settings without reinstalling Josi.</p></div>
    {error ? <ErrorNote>{error}</ErrorNote> : null}
    <Card>
      <CardTitle>Open protected maintenance</CardTitle>
      <p className="mb-3 text-sm text-muted-foreground">Josi briefly opens a separate local controller because this page becomes unavailable while its address changes. The controller previews the change, verifies health at the new address, and restores the previous configuration if it fails.</p>
      <label className="mb-1 block text-sm font-medium" htmlFor={passwordId}>Admin password</label>
      <Input id={passwordId} type="password" autoComplete="current-password" placeholder="Enter your current admin password" aria-describedby={helpId} value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !busy) void open(); }} />
      <p id={helpId} className="mt-1 text-xs text-muted-foreground">Enter your current Josi administrator password to open the temporary protected network-change controller. It is submitted only for this reauthentication and is never saved.</p>
      <Button className="mt-3" disabled={busy || !password} onClick={() => void open()}>{busy ? 'Starting protected controller…' : 'Continue'}</Button>
      {launch ? <div className="mt-4 rounded-md border border-border p-3" aria-live="polite"><p className="text-sm">Protected maintenance is ready. If the new tab was blocked, open <a className="underline" href={launch.url} target="_blank" rel="noreferrer">{launch.url}</a>.</p><p className="mt-1 font-mono text-lg">Setup code: {launch.code}</p><p className="text-xs text-muted-foreground">The code works once and expires with the maintenance session.</p></div> : null}
    </Card>
  </div>;
}
