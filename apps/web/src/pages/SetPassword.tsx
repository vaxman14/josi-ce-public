import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { Button, Card, ErrorNote, Input } from '@/components/ui';

export function SetPassword() {
  const [params] = useSearchParams(); const navigate = useNavigate(); const token = params.get('token') ?? '';
  const [password, setPassword] = useState(''); const [show, setShow] = useState(false);
  const [label, setLabel] = useState('Checking link…'); const [error, setError] = useState('');
  useEffect(() => { if (!token) return setError('That reset link is missing its token.');
    void api.get<{ username: string; email: string }>(`/auth/token/${encodeURIComponent(token)}`)
      .then((r) => setLabel(`Set a password for ${r.username} (${r.email})`)).catch((e) => setError(e instanceof Error ? e.message : 'That link is not valid'));
  }, [token]);
  async function submit(event: React.FormEvent) { event.preventDefault(); setError('');
    try { await api.post('/auth/set-password', { token, password }); navigate('/app', { replace: true }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not set password'); }
  }
  return <div className="flex min-h-full items-center justify-center p-4"><Card className="w-full max-w-sm">
    <h1 className="mb-1 text-lg font-semibold">Choose a new password</h1><p className="mb-4 text-sm text-muted-foreground">{label}</p>
    <form onSubmit={submit} className="space-y-3"><div className="flex gap-2">
      <Input type={show ? 'text' : 'password'} minLength={12} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <Button type="button" variant="secondary" onClick={() => setShow((v) => !v)}>{show ? 'Hide' : 'Show'}</Button>
    </div><p className="text-xs text-muted-foreground">At least 12 characters.</p>{error ? <ErrorNote>{error}</ErrorNote> : null}
    <Button className="w-full">Set password</Button></form>
  </Card></div>;
}
