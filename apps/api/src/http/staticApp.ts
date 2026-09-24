// Serving the built web app.
//
// Same origin as the API, deliberately: the session is a cookie and CSRF is a
// double-submit pair, and both are simplest and safest when there is no
// cross-origin story at all.
//
// THE CONTENT SECURITY POLICY IS A CONTROL, NOT DECORATION.
//
// The commercial engine's page loads Fira Sans from fonts.googleapis.com. For a
// hosted product that is a reasonable trade. For CE it is not:
//
//   * it tells Google the IP address of everyone who opens a self-hosted app
//   * it breaks on an air-gapped or firewalled installation
//   * it makes the Local-only badge a claim the page itself contradicts
//
// So CE fetches nothing from anywhere. `default-src 'self'` is what makes that
// checkable rather than a promise — a future edit that adds a CDN link gets
// blocked by the browser, and the e2e suite fails on the console error.
import express, { type Express, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** `style-src` allows inline attributes because React sets `style={{…}}` for
 * the visual-viewport height on Talk. It still forbids an external stylesheet,
 * which is the property that matters here. `connect-src 'self'` keeps the app
 * talking only to its own API. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  // Phase 13.2. `default-src 'self'` already covers both of these in a
  // compliant browser, but naming them means the policy does not silently
  // depend on a fallback — and `worker-src` is the one directive that decides
  // whether a service worker, which outlives the page and the session, may be
  // registered at all.
  "manifest-src 'self'",
  "worker-src 'self'",
].join('; ');

export interface StaticAppOptions {
  voiceEnabled?: boolean;
  /** Where the built bundle lives. Absent or missing = API-only, which is what
   * the test suite and the migration container run as. */
  dir?: string;
}

export function mountWebApp(app: Express, opts: StaticAppOptions = {}): boolean {
  const dir = opts.dir ?? process.env.WEB_DIR ?? '/app/web';
  if (!existsSync(join(dir, 'index.html'))) return false;

  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    // Belt and braces around the same idea: no referrer to anywhere, no MIME
    // sniffing, and no browser feature this app does not use.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Permissions-Policy',
      `geolocation=(), camera=(), microphone=${opts.voiceEnabled ? '(self)' : '()'}, payment=(), usb=(), interest-cohort=()`,
    );
    next();
  });

  // The service worker, before the general static handler so its headers are
  // not the generic ones.
  //
  // `no-store` is the load-bearing part. `sw.js` is not content-hashed — it is
  // always fetched from the same URL — so a cached copy is a pinned copy, and a
  // pinned service worker keeps ITS caching rules forever. Tightening a rule
  // after a mistake would then reach only people who happened to miss the
  // cache. Browsers cap service-worker caching at 24 hours on their own; that
  // is 24 hours too long for a control.
  //
  // `Service-Worker-Allowed: /` lets a worker served from the root take the
  // root scope explicitly rather than by inference.
  app.get('/sw.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    // The test/runtime temp root may itself live below a dot-directory (for
    // example OpenClaw's `.openclaw/tmp`). This is an exact, operator-supplied
    // file path, not a user-controlled static lookup, so allowing that parent
    // path does not expose dotfiles.
    res.sendFile(join(dir, 'sw.js'), { dotfiles: 'allow' });
  });

  // Hashed assets are immutable; index.html must never be, or an upgrade leaves
  // people running last version's bundle against this version's API.
  app.use('/assets', express.static(join(dir, 'assets'), {
    immutable: true, maxAge: '1y', fallthrough: true,
  }));
  // Before express.static: its implicit directory redirect would otherwise
  // turn /help into /help/ before we can canonicalize to the precached file.
  for (const section of ['', 'install', 'legal']) {
    const alias = section ? `/help/${section}/` : '/help/';
    app.get(alias, (_req, res) => res.redirect(302, `${alias}index.html`));
  }
  app.get('/help', (_req, res) => res.redirect(302, '/help/index.html'));
  app.use(express.static(dir, {
    index: false,
    maxAge: '1h',
    setHeaders(res, path) {
      // The manifest is small, changes with a release, and is read once per
      // install. An hour of staleness here would show the old app name on a
      // freshly installed icon.
      if (path.endsWith('manifest.webmanifest')) {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      }
    },
  }));

  // Public Help is standalone, never a fallback rendering of the private SPA.
  // Unknown Help paths must not inherit the authenticated SPA fallback.
  app.get(/^\/help\/.*$/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).type('text/plain').send('Help page not found');
  });

  // Client-side routing: anything that is not an API call and not a file gets
  // the shell. `/api` is excluded so a mistyped endpoint still returns the
  // API's JSON 404 rather than an HTML page a fetch() cannot read.
  app.get(/^(?!\/api\/).*/, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(join(dir, 'index.html'), { dotfiles: 'allow' });
  });

  return true;
}
