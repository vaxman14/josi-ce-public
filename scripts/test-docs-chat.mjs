import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../docs-site/', import.meta.url);
const home = fs.readFileSync(new URL('public/index.html', root), 'utf8');
const index = JSON.parse(fs.readFileSync(new URL('netlify/functions/help-index.json', root), 'utf8'));
const { handler } = await import('../docs-site/netlify/functions/help-chat.mjs');

assert.match(home, /Ask Josi CE/);
assert.match(home, /Groq/);
assert.doesNotMatch(home, /socalreceptionist\.com\/widget/);
assert.ok(index.some(x => x.url.endsWith('/install/#troubleshooting')));
assert.ok(index.some(x => x.url.endsWith('/legal/#privacy-notice')));
assert.ok(index.some(x => x.text.includes('Compose')));

const oldFetch = global.fetch;
const oldKey = process.env.GROQ_API_KEY;
process.env.GROQ_API_KEY = 'test-only';
let request;
global.fetch = async (_url, options) => {
  request = JSON.parse(options.body);
  return { ok: true, json: async () => ({ choices: [{ message: { content: 'Check the installation guide and database health.' } }] }) };
};
try {
  const bad = await handler({ httpMethod: 'POST', body: '{', headers: {} });
  assert.equal(bad.statusCode, 400);
  const tooLong = await handler({ httpMethod: 'POST', body: JSON.stringify({ message: 'x'.repeat(3000) }), headers: {} });
  assert.equal(tooLong.statusCode, 400);
  const result = await handler({ httpMethod: 'POST', body: JSON.stringify({ message: 'Why is my Josi CE database unhealthy?' }), headers: { 'x-forwarded-for': 'test-client', host: 'josi-ce-docs.netlify.app' } });
  assert.equal(result.statusCode, 200);
  const answer = JSON.parse(result.body);
  assert.match(answer.reply, /database health/);
  assert.ok(answer.sources.some(s => s.url.includes('install/')));
  assert.ok(answer.sources.every(s => s.url.startsWith('https://josi-ce-docs.netlify.app/')), 'Old domain must retain working citation links until DNS is live');
  const system = request.messages[0].content;
  assert.match(system, /Josi CE/);
  assert.match(system, /install\/#database-is-unhealthy/);
  assert.doesNotMatch(system, /CTF Designs|Landing Page \$299|roman@ctfdesigns/);
  const marketing = await handler({ httpMethod: 'POST', body: JSON.stringify({ message: 'How should a small business market itself online?' }), headers: { 'x-forwarded-for': 'different-client' } });
  assert.equal(marketing.statusCode, 200);
  assert.match(request.messages[0].content, /general marketing/);
} finally {
  global.fetch = oldFetch;
  if (oldKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = oldKey;
}
console.log('docs_chat=pass');
