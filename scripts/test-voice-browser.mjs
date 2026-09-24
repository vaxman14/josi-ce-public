#!/usr/bin/env node
// Real browser/media lifecycle and real authenticated API; deterministic speech
// helper. Actual models and Docker lifecycle are covered by test-voice-box.py.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { chromium } from 'playwright';
import { createApp } from '../apps/api/dist/app.js';
import { pgliteDb, completeSetup, ensureWorkspace, MasterKey, seal } from '@josi-ce/core';
import { createUser } from '@josi-ce/auth';

const pg = new PGlite();
for (const file of readdirSync('packages/db/migrations').filter((f) => f.endsWith('.sql')).sort())
  await pg.exec(readFileSync(join('packages/db/migrations', file), 'utf8'));
const db = pgliteDb(pg);
await ensureWorkspace(db, {});
await completeSetup(db);
await db.query('update admin_checklist_state set seen_at = now() where id = true');
for (const name of ['owner', 'alice']) await createUser(db, { email: name + '@voice.test', username: name,
  role: name === 'owner' ? 'super_admin' : 'member', password: 'voice-browser-password-123' });
const keyRoot = mkdtempSync(join(tmpdir(), 'josi-voice-browser-'));
const keyFile = join(keyRoot, 'master.key');
const key = new MasterKey(Buffer.alloc(32, 19));
writeFileSync(keyFile, Buffer.alloc(32, 19).toString('base64'), { mode: 0o600 });
await db.query(`insert into llm_providers
  (role, provider, model, api_key_enc, external_acknowledged, activated_at, probed_at,
   cap_chat, cap_structured_output, cap_tool_calling, cap_context_tokens)
  values ('primary','openai','gpt-e2e',$1,true,now(),now(),true,false,false,8000)`, [seal(key, { apiKey: 'test-fixture' })]);

function wav() {
  const data = Buffer.alloc(44 + 24000 * 2 * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  return data;
}
let healthy = false, phase = 'absent', frames = 0, speeches = 0, closes = 0;
let settings = { voice: 'af_heart', model: 'base.en', device: 'cpu', threshold: 0.5, silenceMs: 700, speed: 1 };
const voiceBoxHelper = async (path, body) => {
  let value = {};
  if (path === '/status') value = { healthy, phase, verified: healthy, apiReady: phase !== 'absent', modelsReady: healthy,
    helperAvailable: true, releaseAvailable: true, requirements: ['4 GB available RAM', 'HTTPS or localhost'], settings };
  else if (path === '/operation/install') { phase = 'working'; setTimeout(() => { healthy = true; phase = 'ready'; }, 700); }
  else if (path === '/operation/settings') settings = body;
  else if (path === '/session') { frames = 0; value = { session: 'a'.repeat(48) }; }
  else if (path === '/audio') {
    assert.equal(body.seq, frames++);
    value = { events: frames === 1 ? [{ type: 'speech_start' }, { type: 'partial', text: 'Hello from' }]
      : frames === 3 ? [{ type: 'final', text: 'Hello from voice chat' }] : [] };
  } else if (path === '/close') { closes++; }
  else if (path === '/speech') { speeches++; return { status: 200, type: 'audio/wav', data: wav() }; }
  else throw new Error('Unexpected helper request: ' + path);
  return { status: 200, type: 'application/json', data: Buffer.from(JSON.stringify(value)) };
};
const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: { path: keyFile },
  voiceBoxHelper, webDir: join(process.cwd(), 'apps/web/dist'),
  llmResolve: async () => ['203.0.113.9'],
  llmFetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'I heard your voice message.' } }],
    usage: { prompt_tokens: 4, completion_tokens: 6 } }), { headers: { 'Content-Type': 'application/json' } }),
});
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  if (process.argv.includes('--full')) {
    const child = spawn(process.execPath, ['scripts/e2e-web.mjs'], { stdio: 'inherit', env: {
      ...process.env, E2E_BASE: base, E2E_ADMIN: 'owner', E2E_MEMBER: 'alice',
      E2E_ADMIN_PW: 'voice-browser-password-123', E2E_MEMBER_PW: 'voice-browser-password-123',
    } });
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 0, 'Existing browser release suite failed');
  }
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    window.__voiceTracks = [];
    window.__voiceStops = 0;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await original(...args); window.__voiceTracks.push(...stream.getTracks()); return stream;
    };
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function (...args) { window.__voiceStops++; return stop.apply(this, args); };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  async function login(name) {
    await page.goto(base + '/login');
    await page.locator('#identifier').fill(name);
    await page.locator('#password').fill('voice-browser-password-123');
    await page.locator('button[type=submit]').click();
    await page.waitForURL((url) => url.pathname.startsWith('/app') || url.pathname.startsWith('/admin'));
  }
  await login('owner');
  await page.goto(base + '/admin/voice-box');
  await page.getByRole('button', { name: 'Install Voice Box' }).waitFor();
  assert.equal(await page.getByLabel('Voice', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Install Voice Box' }).click();
  await page.getByLabel('Voice', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Voice', { exact: true }).inputValue(), 'af_heart');
  await page.getByLabel('Voice', { exact: true }).selectOption('af_bella');
  await page.getByRole('button', { name: 'Save and verify' }).click();
  await page.getByRole('button', { name: 'Preview voice' }).click();
  await page.getByRole('button', { name: 'Playing preview…' }).waitFor();
  await page.getByRole('button', { name: 'Preview voice' }).waitFor();
  assert.equal(settings.voice, 'af_bella'); assert.ok(speeches > 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Admin page overflows at 390px');
  console.log('PASS admin install gate, voice settings, real WAV preview and mobile layout');
  await context.clearCookies();
  await login('alice');
  await page.goto(base + '/app/talk');
  await page.getByRole('button', { name: 'Start voice chat' }).click();
  await page.getByText('Hello from', { exact: true }).waitFor();
  await page.getByText('Hello from voice chat', { exact: false }).waitFor();
  await page.getByText('I heard your voice message.', { exact: false }).waitFor();
  await page.waitForFunction(() => window.__voiceTracks.some((track) => track.readyState === 'live'));
  // Allow the first reply audio buffer to start, then interrupt the real source.
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Interrupt speech' }).click();
  await page.waitForFunction(() => window.__voiceStops > 0);
  await page.getByRole('button', { name: 'Stop voice chat' }).click();
  await page.waitForFunction(() => window.__voiceTracks.every((track) => track.readyState === 'ended'));
  await page.waitForTimeout(200);
  assert.ok(closes > 0); assert.ok(frames >= 3); assert.ok(speeches >= 2);
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'Talk must scroll its transcript, not the app shell');
  const header = await page.locator('header').boundingBox();
  assert.ok(header && header.y >= 0 && header.y + header.height <= 844, 'Talk header must remain visible after transcript updates');
  assert.deepEqual(errors, []);
  console.log('PASS microphone capture, partial/final transcript, normal assistant reply, speech interruption, track cleanup and fixed app shell');
  await page.screenshot({ path: join(keyRoot, 'talk.png'), fullPage: false });
  console.log('Browser evidence:', keyRoot);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await pg.close();
}
