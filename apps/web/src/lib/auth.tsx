// Who is signed in.
//
// The server decides; this only remembers what it said. Nothing here is a
// permission check — hiding a link is not access control, and every route the
// nav hides is refused server-side too.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, primeCsrf, type User } from './api';

interface AuthValue {
  user: User | null;
  loading: boolean;
  signIn: (identifier: string, password: string, rememberMe?: boolean) => Promise<string | null>;
  finishMfa: (challenge: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await api.get<{ user: User }>('/auth/me');
      setUser(result.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void primeCsrf().then(refresh); }, [refresh]);

  const signIn = useCallback(async (identifier: string, password: string, rememberMe = false) => {
    await primeCsrf();
    const result = await api.post<{ user?: User; mfaRequired?: boolean; challenge?: string }>('/auth/login', { identifier, password, rememberMe });
    if (result.mfaRequired && result.challenge) return result.challenge;
    setUser(result.user ?? null); return null;
  }, []);

  const finishMfa = useCallback(async (challenge: string, code: string) => {
    const result = await api.post<{ user: User }>('/auth/mfa/verify-login', { challenge, code }); setUser(result.user);
  }, []);

  const signOut = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, signIn, finishMfa, signOut, refresh }),
    [user, loading, signIn, finishMfa, signOut, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
