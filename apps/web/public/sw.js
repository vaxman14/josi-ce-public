// Josi CE service worker.
//
// A SERVICE WORKER CACHE IS A DATA STORE THAT OUTLIVES SIGN-OUT.
//
// That is the whole reason this file is written the way it is. The cache is
// origin-scoped, survives closing the tab, survives the session expiring, and
// survives the person signing out. Anything put in it is readable by whoever
// picks up the device next, and by any later script running on this origin.
//
// So the rule is absolute and there is exactly one function that decides it:
//
//     BUILD ASSETS, THE OFFLINE SHELL, AND EXACT PUBLIC HELP FILES ARE CACHED. NOTHING ELSE IS.
//
// No `/api` response is cached, read from cache, or served from cache — not a
// 200, not a GET, not while offline. Not the user list, not a conversation, not
// even `/api/auth/me`. Offline shows a page that says it is offline and can
// display nothing, because for an assistant holding somebody's private mail
// that is the honest offline experience.
//
// Written as plain JavaScript rather than compiled from the bundle, because a
// service worker is fetched by URL from the scope root and it is worth being
// able to read the shipped file. `self.__josiSwInternals` at the bottom lets
// the test suite evaluate THIS FILE and call the decision function directly,
// so what is tested is what ships.

// Bumped whenever the caching rules change. An old worker's caches are deleted
// on activate, so a rule that gets tightened takes effect for everybody rather
// than only for new installs.
const CACHE_VERSION = 'josi-v2';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;

/** Everything precached at install. Static, public, and containing nothing
 * about anybody. The app shell itself is deliberately NOT here — see
 * `decide()`. */
const SHELL_FILES = [
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  // Explicit public, script-free files. Never cache a /help/ prefix or SPA page.
  '/help/index.html',
  '/help/install/index.html',
  '/help/legal/index.html',
  '/help/brand/josi-mark.png',
];

/**
 * The one decision. Returns a strategy name, never a response.
 *
 *   'network-only'   — go to the network, never touch the cache in either
 *                      direction. The default, and what everything private gets.
 *   'cache-first'    — hashed build assets. Their filename contains a content
 *                      hash, so a cached copy can never be stale.
 *   'navigation'     — network first, and the OFFLINE SHELL on failure. Never
 *                      a cached copy of the real page.
 *   'shell'          — the precached static files above, including public Help.
 *
 * Exported through `self.__josiSwInternals` and tested directly, because this
 * function is the entire security boundary of the file.
 */
function decide(request, scopeOrigin) {
  // A cache can only be keyed on a URL, so anything that varies by who is
  // asking is uncacheable by construction. Every one of these checks is a way
  // that could go wrong.

  // 1. Only GET. A cache has no concept of a request body, and a POST that
  //    got cached would replay somebody's message.
  if (request.method !== 'GET') return 'network-only';

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return 'network-only';
  }

  // 2. Same origin only. CE fetches nothing from anywhere (see the CSP), so a
  //    cross-origin request here is already anomalous.
  if (url.origin !== scopeOrigin) return 'network-only';

  // 3. The API, always and only from the network. Checked before anything
  //    else that could match, and checked on the PATH rather than on a
  //    guessed content type.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return 'network-only';

  // 4. The Telegram webhook is a POST and would already have been refused, but
  //    naming it costs nothing and makes the intent explicit.
  if (url.pathname.startsWith('/telegram/')) return 'network-only';

  // 5. Anything carrying credentials explicitly. A request with an
  //    Authorization header is by definition per-person.
  if (request.headers && request.headers.get && request.headers.get('authorization')) {
    return 'network-only';
  }

  // 6. A query string means the answer depends on parameters somebody chose,
  //    which for a static asset it never does.
  if (url.search) return 'network-only';

  // 7. Health and readiness are cheap and must never be answered from a cache
  //    — a cached "ready" is worse than no answer at all.
  if (url.pathname === '/health' || url.pathname === '/ready') return 'network-only';

  if (SHELL_FILES.includes(url.pathname)) return 'shell';

  // Unknown Help paths and directory aliases must not silently inherit the
  // generic SPA offline fallback. Only the exact files above are offline Help.
  if (url.pathname === '/help' || url.pathname.startsWith('/help/')) return 'network-only';

  // Hashed build output. Vite writes `/assets/index-<hash>.js`, so the name
  // changes whenever the content does and a cached copy cannot go stale.
  if (url.pathname.startsWith('/assets/')) return 'cache-first';

  // The brand images, which are static and public.
  if (url.pathname.startsWith('/brand/') || url.pathname.startsWith('/icons/')) {
    return 'cache-first';
  }

  // A page load. Network first; the offline shell if that fails. NEVER a
  // cached copy of the real page: index.html is the container for a signed-in
  // session, and serving yesterday's shell against today's API is exactly the
  // upgrade failure the API's `no-store` on index.html exists to prevent.
  if (request.mode === 'navigate') return 'navigation';

  return 'network-only';
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      // NO skipWaiting here. A worker that activates itself swaps the rules
      // under a page that is mid-session; the update is offered to the person
      // instead, and only their click sends SKIP_WAITING below.
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name !== SHELL_CACHE && name !== ASSET_CACHE)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  // The only message this worker accepts, and it comes from the update prompt
  // after the person chose to reload.
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const strategy = decide(event.request, self.location.origin);

  // The important branch. `network-only` returns WITHOUT calling
  // `respondWith`, so the request goes to the network exactly as it would with
  // no service worker installed at all — this worker is not in the path.
  if (strategy === 'network-only') return;

  if (strategy === 'cache-first' || strategy === 'shell') {
    event.respondWith((async () => {
      const cacheName = strategy === 'shell' ? SHELL_CACHE : ASSET_CACHE;
      const cached = await caches.match(event.request, { cacheName });
      if (cached) return cached;
      const response = await fetch(event.request);
      // Only a clean, complete, same-origin 200 is worth keeping. An opaque
      // response has an unreadable status, and caching one caches a failure.
      if (response && response.status === 200 && response.type === 'basic') {
        const cache = await caches.open(cacheName);
        await cache.put(event.request, response.clone());
      }
      return response;
    })());
    return;
  }

  if (strategy === 'navigation') {
    event.respondWith((async () => {
      try {
        return await fetch(event.request);
      } catch {
        const offline = await caches.match('/offline.html', { cacheName: SHELL_CACHE });
        return offline ?? new Response('Josi is offline.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
        });
      }
    })());
  }
});

// The seam the test suite uses. Assigning to `self` is harmless in a worker and
// means the tests exercise the shipped file rather than a copy of its logic.
self.__josiSwInternals = { decide, SHELL_FILES, SHELL_CACHE, ASSET_CACHE, CACHE_VERSION };
