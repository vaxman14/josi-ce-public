// Server-side authorization. Hidden navigation is not access control, so
// nothing here trusts the client for anything except the session cookie.
import type { NextFunction, Request, Response } from 'express';
import {
  canRead, canShare, canWrite, hasCapability, resolveAccess,
  type Accessor, type Capability, type Db, type EditionProfile, type ResourceType,
} from '@josi-ce/core';
import { resolveSession, type SessionUser } from '@josi-ce/auth';
import { readSessionToken } from './cookies.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export interface HttpCtx {
  db: Db;
}

export function accessorOf(user: SessionUser): Accessor {
  return { userId: user.id, role: user.role };
}

/** Attaches req.user when a valid session is present. Never rejects — the
 * route guards decide what an anonymous request may do. */
export function attachUser(ctx: HttpCtx) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = await resolveSession(ctx.db, readSessionToken(req));
      if (user) req.user = user;
    } catch (err) {
      console.error('session resolve failed', err);
    }
    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }
  next();
}

/** Policy, not content.
 *
 * Everything behind this guard configures the installation: capabilities,
 * quotas, SMTP, LLM, user administration. Nothing behind it returns a private
 * resource's contents, and `requireOwnership` below does not consult role at
 * all — so passing this check never widens what a person can read. */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }
  if (req.user.role !== 'super_admin') {
    res.status(403).json({ error: 'super admin only' });
    return;
  }
  next();
}

/** CE has exactly one workspace, so "which workspace?" is never a question a
 * request gets to answer. This exists to make that explicit at the routing
 * layer and to give the isolation tests something to point at. */
export function scopeWorkspace(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }
  next();
}

/** Refuses a route that this build's edition does not have.
 *
 * **404, not 403**, and for the same reason `requireOwnership` gives one: 403
 * would confirm the endpoint exists. On a hosted build the subscription
 * endpoints should be indistinguishable from endpoints that were never written,
 * because "this feature exists but you may not have it" is an invitation to go
 * looking for the bypass.
 *
 * This is the outermost of four layers. It is the cheapest and the least
 * trustworthy — a route added later that forgets it gets no protection here at
 * all, which is exactly why the factory and the call path check again. */
export function requireCapability(capability: Capability, profile?: EditionProfile) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (!hasCapability(capability, profile)) {
      res.status(404).json({ error: 'no such endpoint' });
      return;
    }
    next();
  };
}

export interface OwnershipOptions {
  type: ResourceType;
  /** Route param holding the resource id. */
  param?: string;
  /** Minimum access required. Reads accept a share; writes need write or owner;
   * `owner` accepts nothing less, and is for decisions only the owner may make
   * — chiefly handing access to somebody else. A colleague with write access
   * must not be able to widen that access further. */
  need?: 'read' | 'write' | 'owner';
}

/** Guards a private resource.
 *
 * A person who may not see the row gets **404, not 403**. 403 would confirm
 * that a colleague has a resource with that id, which is exactly the fact the
 * resource is private to protect. */
export function requireOwnership(ctx: HttpCtx, opts: OwnershipOptions) {
  const param = opts.param ?? 'id';
  const need = opts.need ?? 'read';
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    const raw = req.params[param];
    const resourceId = typeof raw === 'string' ? raw : '';
    const decision = await resolveAccess(ctx.db, {
      type: opts.type,
      resourceId,
      accessor: accessorOf(req.user),
    });

    const permitted = need === 'owner' ? canShare(decision.level)
      : need === 'write' ? canWrite(decision.level)
      : canRead(decision.level);
    if (!permitted) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    next();
  };
}

/** Strips a row down to what a super admin may see about someone else's
 * resource: whose it is, whether it works, when it was checked. Never the
 * account's contents, never a credential, never a secret. */
export interface AdminResourceMetadata {
  id: string;
  owner_user_id: string;
  provider?: string;
  status?: string;
  last_check_at?: string | null;
  last_check_ok?: boolean | null;
  created_at?: string;
}

const CONTENT_KEYS = new Set([
  'secrets_enc', 'secrets', 'granted_scopes', 'meta', 'account_email',
  'body', 'subject', 'content', 'text', 'snippet', 'filename', 'path',
  'access_token', 'refresh_token', 'password_hash',
  // Ciphertext is still a credential. Serving it hands an attacker something to
  // work on offline, and there is no reason any surface needs it — a boolean
  // "a key is set" answers every legitimate question.
  'api_key_enc', 'apiKeyEnc', 'apiKeyCiphertext', 'apiKey', 'api_key', 'password_enc',
]);

/** Belt and braces for admin DTOs. A field that looks like content or a
 * credential throws rather than serialising, so a careless `...row` spread
 * fails a test instead of leaking in production. */
export class AdminContentLeakError extends Error {}

export function assertMetadataOnly(dto: Record<string, unknown>): void {
  for (const key of Object.keys(dto)) {
    if (CONTENT_KEYS.has(key)) {
      throw new AdminContentLeakError(
        `admin DTO field "${key}" is content or a credential; admin surfaces expose metadata only`,
      );
    }
  }
}
