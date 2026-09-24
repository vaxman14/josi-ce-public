import { expect, it } from 'vitest';
import { testDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { providerStatus } from '../src/providerStatus.js';

it('reports real empty state with an auditable receipt, without borrowing another owner connection', async () => {
  const db = await testDb();
  const alice = await createUser(db, { email: 'status-a@example.test', username: 'statusalice', role: 'member' });
  const bob = await createUser(db, { email: 'status-b@example.test', username: 'statusbob', role: 'member' });
  await db.query(`insert into connections(owner_user_id,provider,account_email,status,secrets_enc) values ($1,'google','private@example.test','active','SECRET_NOT_RETURNED')`, [bob.id]);
  const empty = await providerStatus(db, alice.id);
  expect(empty.connections).toEqual([]);
  expect(empty.folders).toEqual([]);
  expect(empty.contacts).toEqual([]);
  const own = await providerStatus(db, bob.id);
  expect(own.connections).toHaveLength(1);
  expect(JSON.stringify(own)).not.toContain('SECRET_NOT_RETURNED');
  expect(JSON.stringify(empty)).not.toContain('private@example.test');
  const events = await db.query(`select id from events where actor_user_id=$1 and kind='providers.status_read'`, [alice.id]);
  expect(events).toHaveLength(1);
  expect(empty.receipt).toMatch(/^[a-f0-9-]{36}$/);
});

import { checkNarratedSearchWithoutTool } from '../src/dataClaimGuard.js';
it('requires current internal status evidence without requiring it in visible prose', () => {
  expect(checkNarratedSearchWithoutTool('Your Google Drive is connected.', []).fabricated).toBe(true);
  expect(checkNarratedSearchWithoutTool('Your storage is indexed.', [{ tool:'list_documents', result:{ok:true,documents:[]} }]).fabricated).toBe(true);
  expect(checkNarratedSearchWithoutTool('Your Google Drive is connected.', [{ tool:'get_provider_status', result:{ok:true,receipt:'proof-123'} }]).fabricated).toBe(false);
});
