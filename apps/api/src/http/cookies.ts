// Cookies and CSRF.
//
// The session cookie is httpOnly so injected JavaScript cannot read it. That
// protection is exactly what makes CSRF possible — the browser attaches the
// cookie to a cross-site form post whether the user meant it or not — so a
// second, deliberately readable token is required on every state-changing
// request. Double-submit: the value must appear in both the cookie and a
// header, and an attacker on another origin can set neither.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { SESSION_COOKIE } from '@josi-ce/auth';

export const CSRF_COOKIE = 'josi_csrf';
export const CSRF_HEADER = 'x-josi-csrf';

/** Minimal cookie parse. Two cookies, no signing (the session token is already
 * unguessable and only its hash is stored), no extra dependency. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function readSessionToken(req: Request): string | undefined {
  if (isNativeClient(req)) {
    const authorization = req.header('authorization');
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    return match?.[1];
  }
  return readCookie(req, SESSION_COOKIE);
}

/** Native apps use an explicit bearer session, so no browser can attach the
 * credential ambiently and CSRF does not apply. Requiring both the client
 * marker and the absence of Origin keeps this seam unavailable to browser
 * JavaScript, including same-device WebViews. */
export function isNativeClient(req: Request): boolean {
  return req.header('x-josi-client') === 'native' && !req.header('origin');
}

export function clientIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? null;
}

export interface CookieOptions {
  secure: boolean;
}

export function setSessionCookie(res: Response, token: string, ttlSeconds: number, opts: CookieOptions): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: ttlSeconds * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Readable by design: the SPA has to echo it back in a header. Secrecy from
 * the page is not what protects it — same-origin policy is, because a hostile
 * origin can read neither the cookie nor set the header. */
export function issueCsrfToken(res: Response, opts: CookieOptions): string {
  const token = randomBytes(32).toString('base64url');
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: opts.secure,
    sameSite: 'lax',
    path: '/',
  });
  return token;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Refuses any state-changing request whose header token does not match its
 * cookie.
 *
 * Login is NOT exempt. A forged cross-site login would let an attacker sign a
 * victim's browser into an account the attacker controls, and everything the
 * victim then did would land in it. The client fetches a token from
 * `/api/auth/csrf` before posting credentials. */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const nativeLogin = req.path === '/auth/login'
    || req.path === '/auth/google/native/exchange'
    || req.path === '/auth/apple/native/exchange'
    || req.path === '/auth/apple/native/complete';
  const nativeBearer = /^Bearer\s+[^\s]+$/i.test(req.header('authorization') ?? '');
  if (isNativeClient(req) && (nativeLogin || nativeBearer)) {
    next();
    return;
  }
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const cookie = readCookie(req, CSRF_COOKIE);
  const header = req.header(CSRF_HEADER);
  if (!cookie || !header || !safeEqual(cookie, header)) {
    res.status(403).json({ error: 'missing or invalid CSRF token' });
    return;
  }
  next();
}
