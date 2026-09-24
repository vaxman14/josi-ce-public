#!/usr/bin/env node
// Browser regression for the signed-in ChatGPT picker. Run from the repo root:
// node scripts/test-provider-form-auto.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const portServer = createServer();
await new Promise((done) => portServer.listen(0, '127.0.0.1', done));
const port = portServer.address().port;
await new Promise((done) => portServer.close(done));
const url = `http://127.0.0.1:${port}/test/providerForm-auto-fixture.html`;
const server = spawn('npm', [
  'run', 'dev', '--workspace', '@josi-ce/web', '--', '--host', '127.0.0.1',
  '--port', String(port), '--strictPort',
], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    ...(process.platform === 'darwin' ? { TMPDIR: '/Volumes/JosiOS/JosiDrive/Projects/.tmp' } : {}),
  },
});
let serverOutput = '';
for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (data) => { serverOutput = (serverOutput + data.toString()).slice(-4000); });
}
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { ready = (await fetch(url)).ok; } catch { /* still starting */ }
    if (ready) break;
    await pause(200);
  }
  if (!ready) throw new Error(`Vite did not serve the fixture: ${serverOutput}`);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.modelListRequests === 1
    && document.querySelectorAll('input[name="chatgptChoice"]').length === 3);
  const choices = await page.locator('input[name="chatgptChoice"] + span').allTextContents();
  if (choices.join('|') !== 'Automatic (Codex chooses)|CLI One|CLI Two') {
    throw new Error(`Unexpected model choices: ${choices.join('|')}`);
  }
  if (!await page.locator('input[name="chatgptChoice"][value=""]').isChecked()) {
    throw new Error('Auto-discovery changed the selected model');
  }
  await page.locator('input[name="chatgptChoice"][value="test-cli-two"]').check();
  if (!await page.locator('input[name="chatgptChoice"][value="test-cli-two"]').isChecked()) {
    throw new Error('The user cannot choose an explicit model');
  }
  console.log('picker_auto_discovers=true automatic_default=true explicit_selection=true');
} finally {
  if (browser) await browser.close();
  if (server.pid) {
    try {
      if (process.platform === 'win32') server.kill('SIGTERM');
      else process.kill(-server.pid, 'SIGTERM');
    } catch { /* already exited */ }
  }
}
