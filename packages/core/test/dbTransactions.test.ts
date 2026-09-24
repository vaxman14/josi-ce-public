import { describe, expect, it } from 'vitest';
import { json, postgresDb } from '../src/db.js';

describe('PostgreSQL transaction adapter', () => {
  it('pins every query and JSON parameter to the driver transaction connection', async () => {
    const calls: unknown[] = [];
    const tx = { unsafe: async (sql: string, params: unknown[]) => { calls.push([sql, params]); return []; } };
    const db = postgresDb({ unsafe: async () => { throw new Error('pool query is forbidden inside this transaction'); }, begin: async (work: (connection: unknown) => Promise<unknown>) => work(tx) });
    await db.transaction!(async connection => { await connection.query('synthetic insert', [json({ count: 1 })]); await connection.query('synthetic read', []); });
    expect(calls).toEqual([['synthetic insert', [{ count: 1 }]], ['synthetic read', []]]);
  });
  it('propagates rejection into the driver rollback boundary without a pool-level BEGIN', async () => {
    let rolledBack = false;
    const db = postgresDb({ unsafe: async () => { throw new Error('pool must not be used'); }, begin: async (work: (tx: unknown) => Promise<unknown>) => {
      try { return await work({ unsafe: async () => [] }); } catch (error) { rolledBack = true; throw error; }
    } });
    await expect(db.transaction!(async () => { throw new Error('synthetic failure'); })).rejects.toThrow('synthetic failure');
    expect(rolledBack).toBe(true);
  });
});
