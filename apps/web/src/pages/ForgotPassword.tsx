import { useState } from 'react';
import { api } from '@/lib/api';
import { Button, Card, ErrorNote, Input } from '@/components/ui';

export function ForgotPassword() {
  const [identifier, setIdentifier] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api.post<{ message: string }>('/auth/forgot-password', { identifier });
      setMessage(result.message);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not request a reset'); }
    finally { setBusy(false); }
  }
  return <div className="flex min-h-full items-center justify-center p-4"><Card className="w-full max-w-sm">
    <h1 className="mb-1 text-lg font-semibold">Reset password</h1>
    <p className="mb-4 text-sm text-muted-foreground">Enter your username or email.</p>
    <form onSubmit={submit} className="space-y-3">
      <Input autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
      {message ? <p className="text-sm">{message}</p> : null}{error ? <ErrorNote>{error}</ErrorNote> : null}
      <Button className="w-full" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</Button>
      <a className="block text-center text-sm text-primary underline" href="/login">Back to sign in</a>
    </form>
  </Card></div>;
}
