// The PWA (L2.1 … L2.8).
//
// The caching rules are the security work here, not the manifest. A service
// worker cache is origin-scoped and outlives sign-out, so a mistake in it is a
// data leak that survives the session that produced it.
//
// So the decision function is not re-implemented for the test. `sw.js` is
// evaluated in a sandbox with a fake `self`, and `decide()` is pulled out of
// `self.__josiSwInternals` — what is tested is the file that ships.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';
import { CONTENT_SECURITY_POLICY } from '../src/http/staticApp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC = join(ROOT, 'apps/web/public');

// ---------------------------------------------------------------- the worker

interface SwInternals {
  decide: (request: { method: string; url: string; mode?: string; headers?: Headers }, origin: string) => string;
  SHELL_FILES: string[];
  SHELL_CACHE: string;
  ASSET_CACHE: string;
  CACHE_VERSION: string;
}

/** Evaluates the real `public/sw.js` with a fake worker global. */
function loadWorker(): SwInternals {
  const source = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
  const listeners: Record<string, unknown> = {};
  const self: Record<string, unknown> = {
    addEventListener: (name: string, fn: unknown) => { listeners[name] = fn; },
    location: { origin: 'https://josi.example' },
    clients: { claim: async () => {} },
    skipWaiting: () => {},
  };
  const sandbox = {
    self,
    caches: { open: async () => ({}), keys: async () => [], match: async () => undefined, delete: async () => true },
    fetch: async () => new Response(''),
    Response,
    URL,
    console,
  };
  runInContext(source, createContext(sandbox));
  return self.__josiSwInternals as SwInternals;
}

const sw = loadWorker();
const ORIGIN = 'https://josi.example';

function req(url: string, over: { method?: string; mode?: string; headers?: Record<string, string> } = {}) {
  return {
    method: over.method ?? 'GET',
    url,
    mode: over.mode,
    headers: new Headers(over.headers ?? {}),
  };
}

describe('the service worker registers a fetch listener at all', () => {
  it('exposes its internals so this suite tests the shipped file', () => {
    expect(typeof sw.decide).toBe('function');
    expect(sw.SHELL_FILES).toContain('/offline.html');
  });
});

describe('the API is NEVER cached, in either direction (L2.4)', () => {
  const API_PATHS = [
    '/api/auth/me',
    '/api/assistant/threads',
    '/api/assistant/threads/abc/talk',
    '/api/admin/telegram/links',
    '/api/storage/search',
    '/api/persona/memories',
    '/api/ops/admin/backups',
    '/api',
  ];

  it('every API path is network-only', () => {
    for (const path of API_PATHS) {
      expect(sw.decide(req(`${ORIGIN}${path}`), ORIGIN), path).toBe('network-only');
    }
  });

  it('a GET that returns 200 is still network-only — the status is irrelevant', () => {
    // The rule is about the PATH, not about what came back. A cache decision
    // taken on a response is a decision taken after the data already exists.
    expect(sw.decide(req(`${ORIGIN}/api/assistant/threads`), ORIGIN)).toBe('network-only');
  });

  it('a navigation request to an API path is still network-only', () => {
    expect(sw.decide(req(`${ORIGIN}/api/auth/me`, { mode: 'navigate' }), ORIGIN))
      .toBe('network-only');
  });

  it('a path that merely starts with the letters "api" is not confused for one', () => {
    // `/apidocs` is not under `/api/`. The check uses a boundary rather than a
    // bare prefix, which is the same class of bug Phase 9 hit with
    // `docs-private` vs `docs`.
    expect(sw.decide(req(`${ORIGIN}/apidocs/x.js`, { mode: 'navigate' }), ORIGIN))
      .toBe('navigation');
  });
});

describe('anything that varies by who is asking is uncacheable (L2.4)', () => {
  it('a non-GET is never cached', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      expect(sw.decide(req(`${ORIGIN}/assets/index-abc.js`, { method }), ORIGIN), method)
        .toBe('network-only');
    }
  });

  it('a request carrying an Authorization header is never cached', () => {
    expect(sw.decide(
      req(`${ORIGIN}/assets/index-abc.js`, { headers: { authorization: 'Bearer x' } }),
      ORIGIN,
    )).toBe('network-only');
  });

  it('a cross-origin request is never cached', () => {
    expect(sw.decide(req('https://evil.example/assets/index-abc.js'), ORIGIN)).toBe('network-only');
    expect(sw.decide(req('https://api.telegram.org/bot123/getMe'), ORIGIN)).toBe('network-only');
  });

  it('a query string makes even a static-looking path uncacheable', () => {
    expect(sw.decide(req(`${ORIGIN}/assets/index-abc.js?token=secret`), ORIGIN))
      .toBe('network-only');
  });

  it('the health probes are never answered from a cache', () => {
    // A cached "ready" is worse than no answer at all.
    expect(sw.decide(req(`${ORIGIN}/health`), ORIGIN)).toBe('network-only');
    expect(sw.decide(req(`${ORIGIN}/ready`), ORIGIN)).toBe('network-only');
  });

  it('the Telegram webhook is never cached', () => {
    expect(sw.decide(req(`${ORIGIN}/telegram/webhook`, { method: 'POST' }), ORIGIN))
      .toBe('network-only');
    expect(sw.decide(req(`${ORIGIN}/telegram/webhook`), ORIGIN)).toBe('network-only');
  });

  it('a malformed URL falls to network-only rather than throwing', () => {
    expect(sw.decide(req('not a url'), ORIGIN)).toBe('network-only');
  });
});

describe('what IS cached (L2.4)', () => {
  it('hashed build assets, which cannot go stale', () => {
    expect(sw.decide(req(`${ORIGIN}/assets/index-D4C7xf5U.css`), ORIGIN)).toBe('cache-first');
    expect(sw.decide(req(`${ORIGIN}/assets/react-DDVvIb-R.js`), ORIGIN)).toBe('cache-first');
  });

  it('the brand images, which are static and public', () => {
    expect(sw.decide(req(`${ORIGIN}/brand/josi-mark.png`), ORIGIN)).toBe('cache-first');
    expect(sw.decide(req(`${ORIGIN}/brand/josi-wordmark.png`), ORIGIN)).toBe('cache-first');
    // An icon that is NOT in the precache list still caches on first use;
    // the three that are precached are covered by the shell case below.
    expect(sw.decide(req(`${ORIGIN}/icons/icon-64.png`), ORIGIN)).toBe('cache-first');
  });

  it('the precached shell files', () => {
    for (const path of sw.SHELL_FILES) {
      expect(sw.decide(req(`${ORIGIN}${path}`), ORIGIN), path).toBe('shell');
    }
  });

  it('a page load is network-first with the offline shell behind it', () => {
    // NEVER a cached copy of the real page. index.html is the container for a
    // signed-in session, and serving yesterday's shell against today's API is
    // exactly what the `no-store` on index.html exists to prevent.
    expect(sw.decide(req(`${ORIGIN}/app`, { mode: 'navigate' }), ORIGIN)).toBe('navigation');
    expect(sw.decide(req(`${ORIGIN}/app/talk`, { mode: 'navigate' }), ORIGIN)).toBe('navigation');
    expect(sw.decide(req(`${ORIGIN}/`, { mode: 'navigate' }), ORIGIN)).toBe('navigation');
  });

  it('index.html itself is not in the precache list', () => {
    expect(sw.SHELL_FILES).not.toContain('/');
    expect(sw.SHELL_FILES).not.toContain('/index.html');
  });
});

describe('the worker does not update itself behind the user (L2.6)', () => {
  const source = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');

  it('never calls skipWaiting on install', () => {
    // A worker that activates itself swaps the bundle under somebody
    // mid-sentence in Talk. Matching on the CALL rather than the word, so the
    // comment explaining why it is absent does not fail its own assertion.
    const install = /addEventListener\('install'[\s\S]*?addEventListener\('activate'/.exec(source)?.[0] ?? '';
    expect(install.length).toBeGreaterThan(50);
    expect(install).not.toMatch(/self\.skipWaiting\s*\(/);
    expect(install).not.toMatch(/[^.]\bskipWaiting\s*\(/);
  });

  it('only calls skipWaiting on an explicit message from the page', () => {
    expect(source).toContain("if (event.data === 'SKIP_WAITING') self.skipWaiting();");
  });

  it('deletes caches from a previous version on activate', () => {
    // Otherwise a rule that gets tightened after a mistake only reaches people
    // who happen to miss the old cache.
    expect(source).toContain('caches.delete(name)');
  });
});

describe('the manifest (L2.1, L2.2)', () => {
  const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8'));

  it('has the fields a browser needs to offer an install', () => {
    expect(manifest.name).toBe('Josi');
    expect(manifest.short_name).toBe('Josi');
    expect(manifest.start_url).toBe('/app');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.background_color).toBe('#0b111e');
    expect(manifest.theme_color).toBe('#0b111e');
  });

  it('declares the icon sizes an install actually uses', () => {
    const bySize = Object.fromEntries(
      manifest.icons.map((i: { sizes: string; purpose: string }) => [`${i.sizes}:${i.purpose}`, i]),
    );
    expect(bySize['192x192:any']).toBeTruthy();
    expect(bySize['512x512:any']).toBeTruthy();
    // Android crops to a circle. Without a maskable icon the mark gets its
    // corners cut off.
    expect(bySize['512x512:maskable']).toBeTruthy();
  });

  it('every declared icon file exists and is a PNG of the declared size', () => {
    for (const icon of manifest.icons as Array<{ src: string; sizes: string }>) {
      const path = join(PUBLIC, icon.src);
      expect(existsSync(path), icon.src).toBe(true);
      const bytes = readFileSync(path);
      // PNG magic. A JPEG renamed to .png installs as a broken icon.
      expect(bytes.subarray(0, 8).toString('hex'), icon.src).toBe('89504e470d0a1a0a');
      // IHDR width and height, big-endian, at a fixed offset in every PNG.
      const [w, h] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
      expect(`${w}x${h}`, icon.src).toBe(icon.sizes);
    }
  });

  it('is referenced from the shell, with a theme colour that matches', () => {
    const html = readFileSync(join(ROOT, 'apps/web/index.html'), 'utf8');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('name="theme-color" content="#0b111e"');
    // iOS ignores the manifest's icons entirely.
    expect(html).toContain('rel="apple-touch-icon" href="/icons/icon-192.png"');
  });
});

describe('the offline shell shows nothing private (L2.7)', () => {
  const html = readFileSync(join(PUBLIC, 'offline.html'), 'utf8');

  it('runs no script and fetches nothing', () => {
    // A page that could run script could read a cache. This one cannot do
    // either, which is what makes "shows nothing private" checkable rather
    // than a promise.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\bfetch\s*\(/);
  });

  it('says it is offline and says nothing else', () => {
    expect(html).toContain('Josi is offline');
    expect(html).toContain('nothing to show');
  });

  it('has a target big enough to tap', () => {
    expect(html).toContain('min-height:44px');
  });
});

// -------------------------------------------------------------- over the wire

let server: Server;
let base: string;
let db: TestDb;

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);

  // A minimal built bundle, so `mountWebApp` behaves as it does in production
  // without needing a vite build in the unit suite.
  const webDir = mkdtempSync(join(tmpdir(), 'josi-ce-web-'));
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Josi</title>');
  writeFileSync(join(webDir, 'assets/index-abc123.js'), 'console.log(1)');
  cpSync(join(PUBLIC, 'sw.js'), join(webDir, 'sw.js'));
  cpSync(join(PUBLIC, 'manifest.webmanifest'), join(webDir, 'manifest.webmanifest'));
  cpSync(join(PUBLIC, 'offline.html'), join(webDir, 'offline.html'));
  cpSync(join(PUBLIC, 'icons'), join(webDir, 'icons'), { recursive: true });
  cpSync(join(PUBLIC, 'help'), join(webDir, 'help'), { recursive: true });

  const app = createApp(db, {
    cookieSecure: false, appUrl: 'https://josi.example', masterKeyCheck: false, webDir,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('how the server hands the PWA out (L2.3, L2.8)', () => {
  it('serves the worker with no-store, so its rules can never be pinned', async () => {
    const res = await fetch(`${base}/sw.js`);
    expect(res.status).toBe(200);
    // sw.js is not content-hashed, so a cached copy is a PINNED copy — and a
    // pinned worker keeps its caching rules forever. Tightening a rule after a
    // mistake would reach only people who happened to miss the cache.
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('service-worker-allowed')).toBe('/');
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  it('serves the manifest with the right type and no long cache', async () => {
    const res = await fetch(`${base}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/manifest+json');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves the icons', async () => {
    for (const icon of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
      const res = await fetch(`${base}/icons/${icon}`);
      expect(res.status, icon).toBe(200);
    }
  });

  it('serves the offline shell', async () => {
    const res = await fetch(`${base}/offline.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Josi is offline');
  });

  it('serves standalone public Help, installation, legal, and brand files from this origin', async () => {
    for (const file of ['/help/index.html', '/help/install/index.html', '/help/legal/index.html', '/help/brand/josi-mark.png']) {
      const res = await fetch(`${base}${file}`);
      expect(res.status, file).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()), file).toEqual(readFileSync(join(PUBLIC, file)));
      expect(res.headers.get('content-security-policy'), file).toBe(CONTENT_SECURITY_POLICY);
    }
  });

  it('redirects Help directory aliases to exact offline-cache file URLs', async () => {
    for (const [alias, target] of [['/help', '/help/index.html'], ['/help/', '/help/index.html'], ['/help/install/', '/help/install/index.html'], ['/help/legal/', '/help/legal/index.html']]) {
      const res = await fetch(`${base}${alias}`, { redirect: 'manual' });
      expect(res.status, alias).toBe(302);
      expect(res.headers.get('location'), alias).toBe(target);
    }
  });

  it('does not turn unknown Help files into the signed-in SPA', async () => {
    const res = await fetch(`${base}/help/unknown.html`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('permits a worker and a manifest in the CSP, and still nothing external', async () => {
    const res = await fetch(`${base}/sw.js`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
    // The Phase 6 property, unchanged: CE fetches nothing from anywhere.
    expect(CONTENT_SECURITY_POLICY).not.toContain('http');
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
  });

  it('still refuses to cache index.html', async () => {
    const res = await fetch(`${base}/app`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('the API still answers its own JSON 404 rather than the shell', async () => {
    // The worker adds a navigation handler; the SERVER must still not hand an
    // HTML page to a fetch() that mistyped an endpoint.
    const res = await fetch(`${base}/api/nope`);
    expect(res.headers.get('content-type')).toContain('json');
  });
});
