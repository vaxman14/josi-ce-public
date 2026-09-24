import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../docs-site/public/', import.meta.url);
const home = fs.readFileSync(new URL('index.html', root), 'utf8');
const install = fs.readFileSync(new URL('install/index.html', root), 'utf8');
const legal = fs.readFileSync(new URL('legal/index.html', root), 'utf8');
const topNav = home.match(/<nav class="top-links">([\s\S]*?)<\/nav>/)?.[1] ?? '';
const homeSidebar = home.match(/<aside class="side">([\s\S]*?)<\/aside>/)?.[1] ?? '';
const installSidebar = install.match(/<aside class="side">([\s\S]*?)<\/aside>/)?.[1] ?? '';
const legalSidebar = legal.match(/<aside class="side">([\s\S]*?)<\/aside>/)?.[1] ?? '';

assert.match(topNav, /href="install\/#installation"[^>]*>Installation guide<\/a>/);
assert.match(topNav, /href="install\/#configuration"[^>]*>Configuration options<\/a>/);
assert.match(topNav, /href="install\/#installation"[^>]*>Start installing<\/a>/);
assert.match(topNav, /href="legal\/#terms-of-use"[^>]*>Terms<\/a>/);
assert.match(homeSidebar, /href="#family-parental-controls-beta"/, 'Help features should have a usable index');
assert.match(installSidebar, /href="#installation"/);
assert.match(installSidebar, /href="#configuration"/);
assert.match(installSidebar, /href="#troubleshooting"/);
assert.doesNotMatch(installSidebar, /href="#terms-of-use"/);
assert.match(legalSidebar, /href="#terms-of-use"/);
assert.match(legalSidebar, /href="#privacy-notice"/);
assert.doesNotMatch(legalSidebar, /href="#installation"/);
console.log('docs_install_navigation=pass');
