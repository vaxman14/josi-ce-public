#!/usr/bin/env node
// Runs the browser suite against an in-process API and the built web bundle.
//
// No Docker, no PostgreSQL: pglite in memory, the real router, the real
// bundle. This exists so the harness itself is proven on a laptop — a browser
// failure on the Docker host is otherwise ambiguous between "the UI is wrong"
// and "the test rig is wrong".
//
//   npm run build --workspace @josi-ce/web && node scripts/e2e-local.mjs
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const webDist = join(root, 'apps/web/dist');
if (!existsSync(join(webDist, 'index.html'))) {
  console.error('build the web bundle first: npm run build --workspace @josi-ce/web');
  process.exit(2);
}

// The API and its helpers are TypeScript. vitest already has the alias map, but
// this is a plain node script, so use the compiled output.
const appModule = join(root, 'apps/api/dist/app.js');
if (!existsSync(appModule)) {
  console.error('build the workspace first: npm run build');
  process.exit(2);
}

const { createApp } = await import(pathToFileURL(appModule).href);
const { testDb } = await import(pathToFileURL(join(root, 'packages/core/test/helpers.ts')).href)
  .catch(async () => {
    // helpers.ts is TypeScript; fall back to building the same thing here.
    const { PGlite } = await import('@electric-sql/pglite');
    const { readdirSync, readFileSync } = await import('node:fs');
    return {
      testDb: async () => {
        const pg = new PGlite();
        const dir = join(root, 'packages/db/migrations');
        for (const file of readdirSync(dir).sort()) {
          await pg.exec(readFileSync(join(dir, file), 'utf8'));
        }
        return {
          query: async (text, params) => (await pg.query(text, params)).rows,
        };
      },
    };
  });

const db = await testDb();

// A configured installation with a model that always answers.
const { completeSetup, ensureWorkspace, seal, MasterKey } = await import(
  pathToFileURL(join(root, 'packages/core/dist/index.js')).href
);
const { createUser } = await import(pathToFileURL(join(root, 'packages/auth/dist/index.js')).href);

await ensureWorkspace(db, {});
await completeSetup(db);

const ADMIN_PW = 'owner-password-12345';
const MEMBER_PW = 'alice-password-12345';
await createUser(db, { email: 'owner@e2e.test', username: 'owner', role: 'super_admin', password: ADMIN_PW });
await createUser(db, { email: 'alice@e2e.test', username: 'alice', role: 'member', password: MEMBER_PW });

const key = new MasterKey(Buffer.alloc(32, 6));
await db.query(
  `insert into llm_providers
     (role, provider, model, api_key_enc, external_acknowledged, activated_at, probed_at,
      cap_chat, cap_structured_output, cap_tool_calling, cap_context_tokens)
   values ('primary','openai','gpt-e2e',$1,true,now(),now(),true,true,true,8000)`,
  [seal(key, { apiKey: 'not-a-real-key' })],
);

const llmFetch = async () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: 'Noted.' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const app = createApp(db, {
  cookieSecure: false,
  appUrl: 'http://127.0.0.1:8199',
  masterKeyCheck: false,
  llmFetch,
  llmResolve: async () => ['203.0.113.9'],
  webDir: webDist,
});

const server = app.listen(8199, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
console.log('e2e: API + bundle on http://127.0.0.1:8199');

const result = spawnSync(process.execPath, [join(root, 'scripts/e2e-web.mjs')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    E2E_BASE: 'http://127.0.0.1:8199',
    E2E_ADMIN: 'owner', E2E_ADMIN_PW: ADMIN_PW,
    E2E_MEMBER: 'alice', E2E_MEMBER_PW: MEMBER_PW,
    // Passed through so a caller can run one browser group. See E2E_ONLY in
    // scripts/e2e-web.mjs.
    ...(process.env.E2E_ONLY ? { E2E_ONLY: process.env.E2E_ONLY } : {}),
  },
});

server.close();
process.exit(result.status ?? 1);
