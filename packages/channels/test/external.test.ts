import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { ensureWorkspace } from '../../core/src/workspace.js';
import { createUser } from '../../auth/src/users.js';
import { MasterKey, looksSealed } from '@josi-ce/core';
import {
  consumeExternalLinkCode, describeExternalConfig, listExternalLinks, loadExternalConfig,
  mintExternalLinkCode, openExternalConfig, resolveExternalLink, revokeExternalLink,
  setExternalEnabled, setExternalProbe, storeExternalConfig,
} from '../src/external.js';

let db: TestDb; let alice: string; const key = new MasterKey(Buffer.alloc(32, 19));

beforeEach(async () => {
  db = await testDb(); await ensureWorkspace(db, {});
  alice = (await createUser(db, { email: 'alice@external.test', username: 'alice', role: 'super_admin' })).id;
});

describe('external channel trust boundary', () => {
  it('seals configuration, exposes metadata only, and requires a good probe before enablement', async () => {
    await storeExternalConfig(db, { provider: 'slack', masterKey: key, actorUserId: alice, credentials: { signingSecret: 'sign', botToken: 'token' } });
    const row = await loadExternalConfig(db, 'slack');
    expect(looksSealed(row.credentials_enc)).toBe(true);
    expect(JSON.stringify(describeExternalConfig(row))).not.toContain('token');
    expect(openExternalConfig(key, row)).toMatchObject({ signingSecret: 'sign', botToken: 'token' });
    await expect(setExternalEnabled(db, 'slack', true)).rejects.toThrow(/test/);
    await setExternalProbe(db, 'slack', true, null); await setExternalEnabled(db, 'slack', true);
    expect((await loadExternalConfig(db, 'slack')).enabled).toBe(true);
  });

  it('links only with a single-use unexpired code and revokes immediately', async () => {
    const minted = await mintExternalLinkCode(db, 'whatsapp', alice);
    const [stored] = await db.query<{ code_hash: string }>('select code_hash from external_channel_link_codes');
    expect(stored.code_hash).not.toContain(minted.code);
    const linked = await consumeExternalLinkCode(db, { provider: 'whatsapp', code: minted.code, externalIdentity: '1555', conversationId: '1555' });
    expect(linked?.user_id).toBe(alice);
    expect(await consumeExternalLinkCode(db, { provider: 'whatsapp', code: minted.code, externalIdentity: '1666', conversationId: '1666' })).toBeNull();
    expect((await resolveExternalLink(db, 'whatsapp', '1555'))?.id).toBe(linked?.id);
    expect(await revokeExternalLink(db, linked!.id, alice)).toBe(true);
    expect(await resolveExternalLink(db, 'whatsapp', '1555')).toBeNull();
    expect(await listExternalLinks(db, alice)).toHaveLength(1);
  });

  it('requires explicit Signal risk acknowledgement', async () => {
    await expect(storeExternalConfig(db, { provider: 'signal', masterKey: key, actorUserId: alice, credentials: { bridgeUrl: 'https://signal.test', account: '+1', bridgeSecret: 's' } })).rejects.toThrow(/risk/);
  });
});
