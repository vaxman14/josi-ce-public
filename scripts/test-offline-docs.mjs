import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

execFileSync(process.execPath, ['scripts/build-offline-docs.mjs'], { stdio: 'inherit' });
const base = path.resolve('docs-site/offline');
for (const page of ['index.html', 'install/index.html', 'legal/index.html']) {
  const html = fs.readFileSync(path.join(base, page), 'utf8');
  const live = fs.readFileSync(path.resolve('docs-site/public', page), 'utf8');
  const article = (text) => text.match(/<article>([\s\S]*?)<\/article>/)?.[1].replace(/href="[^"]*"/g, 'href="LOCAL"');
  assert.equal(article(html), article(live), `${page} must preserve public Help/legal content`);
  assert.doesNotMatch(html, /help-chat|Ask Josi CE|\.netlify\/functions|<link rel="canonical"/i, `${page} cannot include live chat`);
  assert.match(html, /Offline copy/, `${page} must identify itself as offline`);
  for (const [, url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (url.startsWith('#') || /^(?:https?:|mailto:|tel:|data:)/.test(url)) continue;
    const target = url.split('#')[0].split('?')[0];
    if (!target) continue;
    const resolved = path.resolve(base, path.dirname(page), target);
    assert.ok(resolved.startsWith(base + path.sep), `Unsafe local link: ${url}`);
    assert.ok(fs.statSync(resolved).isFile(), `${page}: ${url} is not an offline file`);
  }
}
assert.ok(fs.statSync(path.join(base, 'brand/josi-mark.png')).isFile());
console.log('offline_docs=pass');
