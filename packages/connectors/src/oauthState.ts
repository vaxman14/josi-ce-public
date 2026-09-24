// The OAuth handshake, server-side.
//
// Ported from the engine, whose reasoning is kept because it was learned the
// hard way: a state that is merely SIGNED is unguessable but replayable —
// anyone who captures a callback URL can replay it until the TTL runs out. So
// the handshake is STORED and CONSUMED, and a second use is a rejection rather
// than a second connection.
//
// What the callback is allowed to believe comes from this row, never from the
// query string. Including which user is connecting.
//
// CE difference: the engine's callback landed on a different hostname from the
// session cookie, so the session binding was best-effort. CE is one origin, so
// the cookie IS present and the binding is enforced — a callback for someone
// else's handshake is refused even if the state leaked.
import { createHash, randomBytes } from 'node:crypto';
import { openSealed, seal, type Db, type MasterKey } from '@josi-ce/core';
import type { Provider } from './capabilities.js';

export interface StartedHandshake {
  state: string;
  verifier: string;
  challenge: string;
}

export interface ResolvedHandshake {
  userId: string;
  sessionId: string | null;
  provider: Provider;
  capabilities: string[];
  scopes: string;
  verifier: string | null;
  returnPath: string;
  targetConnectionId: string | null;
}

export type HandshakeFailure =
  | 'unknown'          // no such state: forged, or already purged
  | 'consumed'         // replay
  | 'expired'
  | 'wrong_provider'   // a google state redeemed at the microsoft callback
  | 'session_mismatch';

const DEFAULT_TTL_SECONDS = 600;

/** RFC 7636 S256. Both providers accept it for confidential clients and it
 * costs nothing to send. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url'); // 64 chars, within 43..128
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Only relative, single-slash paths inside the app.
 *
 * A return path is attacker-influenced input in the general case, and a
 * callback that will redirect anywhere is an open redirect with extra steps. */
export function safeReturnPath(raw: unknown, fallback = '/app/connections'): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return fallback;
  if (raw.includes('\\') || raw.includes('\n') || raw.includes('\r')) return fallback;
  return raw.length > 512 ? fallback : raw;
}

interface StateRow {
  id: string;
  user_id: string;
  session_id: string | null;
  provider: Provider;
  capabilities: string[];
  scopes: string;
  verifier_enc: string | null;
  return_path: string;
  target_connection_id: string | null;
  expires_at: string;
  consumed_at: string | null;
}

export interface StateStore {
  start(args: {
    userId: string;
    sessionId?: string | null;
    provider: Provider;
    capabilities: string[];
    scopes: string;
    returnPath?: string;
    targetConnectionId?: string | null;
    ttlSeconds?: number;
  }): Promise<StartedHandshake>;

  consume(args: {
    state: string;
    provider: Provider;
    sessionId?: string | null;
  }): Promise<{ ok: true; handshake: ResolvedHandshake } | { ok: false; reason: HandshakeFailure }>;

  purge(olderThanSeconds?: number): Promise<number>;
}

export function createStateStore(db: Db, key: MasterKey | null): StateStore {
  return {
    async start(args) {
      const { verifier, challenge } = createPkcePair();
      // 32 random bytes. The state is the primary key, so being unguessable is
      // the whole defence against someone minting one.
      const state = randomBytes(32).toString('base64url');
      await db.query(
        `insert into oauth_states
           (id, user_id, session_id, provider, capabilities, scopes, verifier_enc, return_path,
            target_connection_id, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10))`,
        [
          state,
          args.userId,
          args.sessionId ?? null,
          args.provider,
          args.capabilities,
          args.scopes,
          // Sealed at rest like every other secret. Without a key we simply do
          // not use PKCE rather than storing the verifier in the clear.
          key ? seal(key, { verifier }) : null,
          safeReturnPath(args.returnPath),
          args.targetConnectionId ?? null,
          args.ttlSeconds ?? DEFAULT_TTL_SECONDS,
        ],
      );
      return { state, verifier, challenge };
    },

    async consume(args) {
      if (!args.state || args.state.length > 512) return { ok: false, reason: 'unknown' };
      const rows = await db.query<StateRow>(`select * from oauth_states where id = $1`, [args.state]);
      const row = rows[0];
      if (!row) return { ok: false, reason: 'unknown' };
      if (row.consumed_at) return { ok: false, reason: 'consumed' };
      if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
      // A state minted for Google must not be redeemable at the Microsoft
      // callback, whatever an attacker persuades the browser to fetch.
      if (row.provider !== args.provider) return { ok: false, reason: 'wrong_provider' };
      // Enforced in CE: one origin means the cookie is here. A leaked state
      // cannot be redeemed from somebody else's browser.
      if (row.session_id && args.sessionId !== row.session_id) {
        return { ok: false, reason: 'session_mismatch' };
      }

      // Claim it. `consumed_at is null` in the WHERE is what makes two
      // simultaneous callbacks resolve to exactly one winner.
      const claimed = await db.query<{ id: string }>(
        `update oauth_states set consumed_at = now() where id = $1 and consumed_at is null returning id`,
        [args.state],
      );
      if (!claimed.length) return { ok: false, reason: 'consumed' };

      let verifier: string | null = null;
      if (row.verifier_enc && key) {
        try {
          verifier = openSealed<{ verifier: string }>(key, row.verifier_enc).verifier;
        } catch {
          // A verifier we cannot open means the exchange fails with a clear
          // PKCE error from the provider, which is the honest outcome.
          verifier = null;
        }
      }

      return {
        ok: true,
        handshake: {
          userId: row.user_id,
          sessionId: row.session_id,
          provider: row.provider,
          capabilities: row.capabilities ?? [],
          scopes: row.scopes,
          verifier,
          returnPath: safeReturnPath(row.return_path),
          targetConnectionId: row.target_connection_id,
        },
      };
    },

    async purge(olderThanSeconds = 3600) {
      const rows = await db.query<{ id: string }>(
        `delete from oauth_states
         where (consumed_at is not null and consumed_at < now() - make_interval(secs => $1))
            or expires_at < now() - make_interval(secs => $1)
         returning id`,
        [olderThanSeconds],
      );
      return rows.length;
    },
  };
}
