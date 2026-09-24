// /health and /ready.
//
// Two properties matter and both are easy to get wrong:
//   1. health must not depend on the database, or a blip becomes a restart loop
//   2. ready must not describe the inside of the installation to the internet
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb } from '../../../packages/core/test/helpers.js';
import { checkReadiness, type Db } from '@josi-ce/core';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-ready-'));
const keyPath = join(dir, 'master.key');
writeFileSync(keyPath, Buffer.alloc(32, 3).toString('base64'));

let server: Server;
let base: string;
let db: Db;

/** A database that is reachable for `select 1` but has no schema — exactly what
 * an installation looks like between `docker compose up` and the migrator
 * finishing. */
const unmigrated: Db = {
  async query(sql: string) {
    if (/^\s*select 1\s*$/i.test(sql)) return [] as never[];
    if (/information_schema\.tables/i.test(sql)) return [{ present: '0' }] as never[];
    throw new Error('relation does not exist');
  },
};

/** A database that is simply down. */
const down: Db = {
  async query() {
    throw new Error('ECONNREFUSED 10.1.2.3:5432 — connect to host db port 5432 failed');
  },
};

beforeAll(async () => {
  db = await testDb();
  const app = createApp(db, {
    cookieSecure: false,
    appUrl: 'http://localhost:8080',
    masterKeyCheck: { path: keyPath },
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('/health', () => {
  it('is 200 and consults nothing', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'josi-ce' });
  });

  it('stays 200 when the database is unreachable', async () => {
    // The process is alive; that is all liveness claims. An orchestrator that
    // restarts on database trouble turns a brief outage into a longer one.
    const brokenApp = createApp(down, {
      cookieSecure: false, appUrl: 'http://x', masterKeyCheck: { path: keyPath },
    });
    const s = brokenApp.listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    const port = (s.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    await new Promise<void>((r) => s.close(() => r()));
  });

  it('is not cached', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('/ready', () => {
  it('is 200 with no blockers on a migrated database with a key', async () => {
    const res = await fetch(`${base}/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true, blockers: [] });
  });

  it('reports the database as a blocker without describing it', async () => {
    const result = await checkReadiness(down, { masterKey: { path: keyPath } });
    expect(result).toEqual({ ready: false, blockers: ['database'] });

    // The driver's error named a host, a port and a failure mode. None of that
    // may reach an unauthenticated caller.
    const serialised = JSON.stringify(result);
    for (const leak of ['ECONNREFUSED', '10.1.2.3', '5432', 'host db', 'postgres']) {
      expect(serialised, leak).not.toContain(leak);
    }
  });

  it('distinguishes an unmigrated database from an unreachable one', async () => {
    const result = await checkReadiness(unmigrated, { masterKey: { path: keyPath } });
    expect(result.blockers).toEqual(['migrations']);
  });

  it('reports a missing master key', async () => {
    const result = await checkReadiness(db, { masterKey: { path: join(dir, 'absent.key') } });
    expect(result.blockers).toEqual(['master_key']);
    // The loader's message names a filesystem path; readiness must not repeat it.
    expect(JSON.stringify(result)).not.toContain('/run/secrets');
    expect(JSON.stringify(result)).not.toContain(dir);
  });

  it('reports several blockers at once', async () => {
    const result = await checkReadiness(down, { masterKey: { path: join(dir, 'absent.key') } });
    expect(result.blockers.sort()).toEqual(['database', 'master_key']);
  });

  it('answers 503 while not ready, so a proxy withholds traffic', async () => {
    const notReady = createApp(down, {
      cookieSecure: false, appUrl: 'http://x', masterKeyCheck: { path: keyPath },
    });
    const s = notReady.listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    const port = (s.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(res.status).toBe(503);
    await new Promise<void>((r) => s.close(() => r()));
  });

  it('never returns key material, versions or connection details', async () => {
    const res = await fetch(`${base}/ready`);
    const text = await res.text();
    for (const leak of ['postgres', 'PostgreSQL', 'node', 'v22', 'password', 'secret', 'key=']) {
      expect(text.toLowerCase(), leak).not.toContain(leak.toLowerCase());
    }
  });

  it('uses a closed vocabulary of blockers', async () => {
    // Anything more specific belongs in the server's own logs, which are not
    // public. This asserts the contract rather than the current implementation.
    const allowed = new Set(['database', 'migrations', 'master_key']);
    for (const database of [down, unmigrated, db]) {
      for (const key of [{ path: keyPath }, { path: join(dir, 'absent.key') }]) {
        const result = await checkReadiness(database, { masterKey: key });
        for (const blocker of result.blockers) expect(allowed.has(blocker), blocker).toBe(true);
      }
    }
  });
});
