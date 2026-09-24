import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const publicDir = path.join(root, 'apps/web/public');
const source = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
const listeners = new Map();
const self = {
  location: { origin: 'https://josi.example' },
  addEventListener: (name, listener) => listeners.set(name, listener),
  clients: { claim: async () => {} },
};
vm.runInNewContext(source, { self, URL, Response, fetch, caches: {}, console });
const { decide, SHELL_FILES, CACHE_VERSION } = self.__josiSwInternals;
const expected = [
  '/help/index.html', '/help/install/index.html',
  '/help/legal/index.html', '/help/brand/josi-mark.png',
];
assert.notEqual(CACHE_VERSION, 'josi-v1', 'a changed precache needs a version bump');
assert.deepEqual([...SHELL_FILES].filter((file) => file.startsWith('/help/')), expected);
for (const file of expected) {
  const shipped = fs.readFileSync(path.join(publicDir, file));
  const generated = fs.readFileSync(path.join(root, 'docs-site/offline', file.slice('/help/'.length)));
  assert.deepEqual(shipped, generated, `${file} must ship the generated offline copy`);
  assert.equal(decide({ method: 'GET', url: `https://josi.example${file}`, mode: 'navigate', headers: new Headers() }, self.location.origin), 'shell');
}
for (const file of ['/help/', '/help/install/', '/help/legal/']) {
  assert.equal(decide({ method: 'GET', url: `https://josi.example${file}`, mode: 'navigate', headers: new Headers() }, self.location.origin), 'network-only', 'aliases must not fall through to the SPA or be cached');
}
for (const file of ['/help/other.html', '/help/install/private', '/api/help/index.html', '/api', '/api/']) {
  assert.equal(decide({ method: 'GET', url: `https://josi.example${file}`, mode: 'navigate', headers: new Headers() }, self.location.origin), 'network-only', `${file} must never serve a cached Help document`);
}
for (const override of [
  { method: 'POST' }, { headers: new Headers({ authorization: 'Bearer private' }) },
  { url: 'https://josi.example/help/index.html?user=secret' },
  { url: 'https://elsewhere.example/help/index.html' },
]) {
  assert.equal(decide({ method: 'GET', url: 'https://josi.example/help/index.html', headers: new Headers(), mode: 'navigate', ...override }, self.location.origin), 'network-only');
}
for (const file of expected.filter((name) => name.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
  assert.doesNotMatch(html, /<script\b|help-chat|\.netlify\/functions/i);
  assert.match(html, /https:\/\/help\.heyjosi\.com\//, 'offline Help should offer live online chat');
}
const links = fs.readFileSync(path.join(root, 'apps/web/src/components/LegalLinks.tsx'), 'utf8');
assert.match(links, /HELP_URL\s*=\s*['"]\/help\/index\.html['"]/);
assert.match(links, /https:\/\/help\.heyjosi\.com\//);
assert.doesNotMatch(links, /josi-ce-docs\.netlify\.app/);
assert.match(fs.readFileSync(path.join(publicDir, 'offline.html'), 'utf8'), /href="\/help\/index\.html"/, 'offline app shell needs an entry to public Help');

// Exercise the shipped fetch handler, not just its route decision. A precached
// public document is available without a network; private/API traffic cannot
// get a synthetic offline response or touch CacheStorage at all.
let cacheReads = 0;
const offlineListeners = new Map();
const cachedHtml = new Response(fs.readFileSync(path.join(publicDir, 'help/index.html'), 'utf8'));
const offlineSelf = {
  location: { origin: 'https://josi.example' },
  addEventListener: (name, listener) => offlineListeners.set(name, listener),
};
vm.runInNewContext(source, {
  self: offlineSelf, URL, Response, console,
  fetch: async () => { throw new Error('offline'); },
  caches: {
    match: async (request) => {
      cacheReads++;
      return new URL(typeof request === 'string' ? request : request.url, offlineSelf.location.origin).pathname === '/help/index.html' ? cachedHtml.clone() : undefined;
    },
    open: async () => { throw new Error('unexpected cache write'); },
  },
});
const onFetch = offlineListeners.get('fetch');
let handled;
onFetch({ request: { method: 'GET', url: 'https://josi.example/help/index.html', headers: new Headers(), mode: 'navigate' }, respondWith: (response) => { handled = response; } });
assert.match(await (await handled).text(), /Offline copy/);
for (const pathname of ['/api/auth/me', '/api/help/index.html']) {
  handled = undefined;
  onFetch({ request: { method: 'GET', url: `https://josi.example${pathname}`, headers: new Headers(), mode: 'navigate' }, respondWith: (response) => { handled = response; } });
  assert.equal(handled, undefined, `${pathname} must pass through to the network`);
}
assert.equal(cacheReads, 1, 'private requests did not even read from CacheStorage');
console.log('web_offline_help=pass');
