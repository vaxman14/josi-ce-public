# Installing Josi on a phone or desktop

Josi CE is a Progressive Web App. It installs to a home screen or a dock, opens
without browser chrome, and keeps working as an app rather than a bookmark.

There is no App Store build and no Play Store build. Those are still *Coming
soon* and the Apps page says so rather than offering a download that does not
exist.

## What is cached on the device, and what is not

This is the part worth reading, because a service worker cache is a data store
that **outlives signing out**. It is scoped to the origin, survives closing the
tab, survives the session expiring, and is readable by whoever picks the device
up next.

So Josi's rule is absolute, and one function in `apps/web/public/sw.js` decides
it:

| Cached on the device | Never cached |
|---|---|
| The hashed JavaScript and CSS bundle | Every `/api/…` response, without exception |
| The brand images and app icons | Conversations, tasks, contacts, mail, documents |
| The manifest | Your name, your account, your session |
| A static "Josi is offline" page | The signed-in page itself |
| Exact, public Help/installation/legal pages and their brand image | Any other route under `/help/` |

Not a 200. Not a GET. Not "just the harmless ones". Not even while offline.

**Offline, private app routes show a page that says Josi is offline.** It
contains no script, no image request, and no cached account data. The exact
public `/help/index.html`, `/help/install/index.html`, and
`/help/legal/index.html` pages remain readable offline. These standalone,
script-free pages link to live chat on `help.heyjosi.com`, which needs a
connection. No signed-in view, API response, or personal content is cached.

## Installing

### iPhone and iPad (Safari)

1. Open your Josi address in **Safari** — this does not work in Chrome on iOS.
2. Tap the **Share** button.
3. **Add to Home Screen**.
4. Name it and tap **Add**.

iOS ignores the web manifest's icons and uses the `apple-touch-icon`, which
Josi provides at 192px.

> iOS requires **HTTPS with a certificate the device trusts**. A self-signed
> certificate or a plain-HTTP evaluation install will not install as an app.

### Android (Chrome, Edge, Samsung Internet)

Josi shows an **"Add Josi to your home screen?"** prompt when the browser
offers one. If you dismissed it, use the browser menu → **Install app** or **Add
to Home screen**.

The prompt appears only when the browser has actually offered an install. On a
browser that never offers one, Josi shows nothing rather than a button that does
nothing.

### Desktop (Chrome, Edge)

An install icon appears in the address bar, or use the menu → **Install Josi**.
Firefox and Safari on macOS do not support installing web apps this way; Josi
works normally in a tab there.

## Updating

Josi never reloads itself while you are using it.

When a new version has been deployed and downloaded, a bar appears at the
bottom: **"A new version of Josi is ready."** Tap **Reload** and the new version
takes over. Until you do, you keep using the version you have — a service worker
that swaps the bundle on its own does it while somebody is mid-sentence in Talk.

**To force an update:** close every Josi window or tab and reopen it. The worker
checks for a new version on each load, and `sw.js` is served with `no-store` so
a stale copy can never be pinned.

**If an update seems stuck:** the nuclear option is to uninstall the app from the
home screen and install it again. Nothing is lost — Josi keeps everything on
your server, not on the device.

## Verifying an installation

From a browser on the installation's own address:

```bash
# The manifest is served, with the right type, and not cached for long.
curl -si https://your.domain/manifest.webmanifest | head -5
# expect: 200, content-type: application/manifest+json, cache-control: no-cache

# The worker is served, and is NOT cacheable.
curl -si https://your.domain/sw.js | head -6
# expect: 200, cache-control: no-store, service-worker-allowed: /

# The icons exist at the sizes the manifest declares.
for i in icon-192 icon-512 icon-maskable-512; do
  curl -so /dev/null -w "$i %{http_code}\n" https://your.domain/icons/$i.png
done

# The offline shell exists and runs nothing.
curl -s https://your.domain/offline.html | grep -c '<script'
# expect: 0
```

In the browser's developer tools, **Application → Service Workers** should show
one registered worker at scope `/`, and **Application → Cache Storage** should
contain `josi-v2-shell` and `josi-v2-assets` — and **no entry whose URL starts
with `/api`**. That last one is the check worth doing after any upgrade.

## Troubleshooting

**No install prompt on Android.** The browser decides. It needs HTTPS with a
trusted certificate, a reachable manifest, a registered service worker, and
usually a prior visit. Check `chrome://flags` is not blocking, then check the
manifest and worker with the commands above.

**"Add to Home Screen" gives a bookmark, not an app, on iOS.** Almost always the
certificate. iOS silently degrades to a bookmark rather than telling you.

**The app opens with browser chrome.** `display: standalone` in the manifest
does this; if the manifest failed to load at install time, the installed
shortcut keeps the wrong mode. Uninstall and reinstall.

**The app shows an old version and the update bar never appears.** Check that
`sw.js` really is served `no-store` — a reverse proxy in front of Josi adding
its own caching headers is the usual cause. The bundled Caddy config does not do
this; a hand-written nginx config often does.

**Offline shows the browser's own error page, not Josi's.** The worker was not
registered — usually because the page was opened over plain HTTP. Service
workers require HTTPS (or `localhost`).

## Where the code is

| Concern | File |
|---|---|
| Caching rules — the one decision | `apps/web/public/sw.js` (`decide()`) |
| Manifest | `apps/web/public/manifest.webmanifest` |
| Icons, derived from the approved mark | `apps/web/public/icons/` |
| Offline shell | `apps/web/public/offline.html` |
| Public offline Help generation | `scripts/build-offline-docs.mjs`, `scripts/sync-offline-help.mjs` |
| Registration, install and update UX | `apps/web/src/lib/pwa.tsx` |
| Headers, CSP, `no-store` on the worker | `apps/api/src/http/staticApp.ts` |
| Tests, run against the shipped `sw.js` | `apps/api/test/pwa.test.ts` |
| Browser checks | `scripts/e2e-web.mjs` (`testPwaAssets`, `testServiceWorker`) |
