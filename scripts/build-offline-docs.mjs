import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

execFileSync(process.execPath, ['scripts/build-docs-site.mjs'], { stdio: 'inherit' });
const publicDir = path.resolve('docs-site/public');
const offlineDir = path.resolve('docs-site/offline');
const pages = ['index.html', 'install/index.html', 'legal/index.html'];

for (const page of pages) {
  let html = fs.readFileSync(path.join(publicDir, page), 'utf8');
  html = html.replace(/\s*<link rel="canonical"[^>]*>/, '');
  html = html.replace(/\n    \.help-chat\{[\s\S]*?(?=\n  <\/style>)/, '');
  html = html.replace(/\s*<aside class="help-chat"[\s\S]*?<\/aside>/, '');
  html = html.replace(/\s*<script>[\s\S]*?<\/script>/g, '');
  html = html.replace(/\b(href|src)="([^"]*)"/g, (original, attribute, url) => {
    if (url.startsWith('#') || /^(?:https?:|mailto:|tel:|data:)/.test(url)) return original;
    const match = url.match(/^([^#?]*)([?#].*)?$/);
    if (!match) return original;
    const [, pathname, suffix = ''] = match;
    const file = !pathname || pathname.endsWith('/') ? pathname + 'index.html' : pathname;
    return `${attribute}="${file}${suffix}"`;
  });
  html = html.replace('<div class="layout" id="top">', '<p role="note" class="offline-notice" style="max-width:1180px;margin:16px auto 0;padding:0 24px;color:var(--muted)">Offline copy — Help, installation, and legal notices are available without a connection. <a href="https://help.heyjosi.com/">Live online chat</a> requires a connection.</p>\n  <div class="layout" id="top">');
  if (/help-chat|Ask Josi CE|\.netlify\/functions/i.test(html)) throw new Error(`Online chat leaked into ${page}`);
  const target = path.join(offlineDir, page);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html);
}
fs.mkdirSync(path.join(offlineDir, 'brand'), { recursive: true });
fs.copyFileSync(path.join(publicDir, 'brand/josi-mark.png'), path.join(offlineDir, 'brand/josi-mark.png'));
