import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { Button, Card, ErrorNote, Input } from '@/components/ui';
import { LegalLinks } from '@/components/LegalLinks';

export function Login() {
  const { signIn, finishMfa } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState('');
  const [mfaCode, setMfaCode] = useState('');

  useEffect(() => {
    const reason = searchParams.get('error');
    if (!reason) return;
    setError(reason === 'google_not_linked'
      ? 'That Google account is not linked to a Josi account. Sign in with your password, then connect Google first.'
      : reason === 'google_unavailable'
        ? 'Google sign-in is not configured on this Josi installation.'
        : 'Google sign-in did not finish. Please try again.');
  }, [searchParams]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const pending = await signIn(identifier, password, rememberMe);
      if (pending) { setChallenge(pending); return; }
      navigate('/app', { replace: true });
    } catch (err) {
      // The server answers identically for an unknown account and a wrong
      // password, so this cannot enumerate accounts either.
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  async function verifyMfa(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await finishMfa(challenge, mfaCode); navigate('/app', { replace: true }); }
    catch (err) { setError(err instanceof Error ? err.message : 'That code did not work'); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full min-w-0 max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <img src="/brand/josi-wordmark.png" alt="Josi" width={200} height={93}
               className="mb-2 h-auto w-40 max-w-full" />
          <p className="text-sm text-muted-foreground">Your assistant, on your own server.</p>
        </div>
        <Card>
          <form onSubmit={challenge ? verifyMfa : submit} className="space-y-3">
            {challenge ? <><p className="text-sm">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
              <Input inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} required autoFocus /></> : <>
            <div>
              <label className="mb-1 block text-sm" htmlFor="identifier">Username or email</label>
              <Input id="identifier" name="identifier" autoComplete="username" autoCapitalize="none"
                     value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
            </div>
            <div>
              <label className="mb-1 block text-sm" htmlFor="password">Password</label>
              <div className="flex gap-2">
                <Input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password"
                       value={password} onChange={(e) => setPassword(e.target.value)} required />
                <Button type="button" variant="secondary" onClick={() => setShowPassword((value) => !value)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? 'Hide' : 'Show'}
                </Button>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} />
              Keep me signed in on this device
            </label>
            </>}
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Signing in…' : challenge ? 'Verify' : 'Sign in'}</Button>
            <a className="block text-center text-sm text-primary underline" href="/forgot-password">Forgot password?</a>
            <a className="block text-center text-sm text-primary underline" href="/api/auth/google/start">Sign in with Google</a>
          </form>
        </Card>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Josi CE 0.1 — Community Preview. Created and published by SOCAL RECEPTIONIST LLC.
        </p>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          By using this installation, you agree to its Terms and acknowledge its Privacy and Cookie Notices.
        </p>
        <LegalLinks className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-2 text-xs text-primary [&_a]:underline" />
      </div>
    </div>
  );
}
