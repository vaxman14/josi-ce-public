import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@josi-ce/core';
import { publicAddressFromEnvironment, reconcilePublicAddress } from '../src/setup/publicAddress.js';

describe('canonical public-address reconciliation', () => {
  it('preserves the browser-facing port and maps proxy mode', () => {
    expect(publicAddressFromEnvironment('https://Josi.Example.test:8443/', 'proxy')).toEqual({
      origin: 'https://josi.example.test:8443',
      hostname: 'josi.example.test',
      tlsMode: 'external_proxy',
    });
  });

  it('accepts a LAN HTTP origin but rejects unsafe and contradictory origins', () => {
    expect(publicAddressFromEnvironment('http://192.168.1.20:8081', 'lan').origin)
      .toBe('http://192.168.1.20:8081');
    expect(() => publicAddressFromEnvironment('http://josi.example.test', 'domain')).toThrow(/HTTPS/);
    expect(() => publicAddressFromEnvironment('https://user:pass@josi.example.test', 'proxy')).toThrow(/valid/);
    expect(() => publicAddressFromEnvironment('https://josi.example.test/path', 'proxy')).toThrow(/valid/);
  });

  it.each([
    ['LAN to bundled-Caddy domain', 'https://one.example.test', 'domain', 'one.example.test', 'bundled_caddy'],
    ['domain to another domain', 'https://two.example.test:8443', 'domain', 'two.example.test', 'bundled_caddy'],
    ['domain to LAN recovery', 'http://192.168.1.30:8080', 'lan', '192.168.1.30', 'bundled_caddy'],
    ['domain to external proxy or Tunnel', 'https://tunnel.example.test', 'proxy', 'tunnel.example.test', 'external_proxy'],
  ] as const)('normalizes %s transitions from the runtime environment', (_label, origin, mode, hostname, tlsMode) => {
    expect(publicAddressFromEnvironment(origin, mode)).toEqual({ origin, hostname, tlsMode });
  });

  it('updates deployment, workspace, OAuth, and webhook metadata in one statement', async () => {
    const query = vi.fn(async () => []);
    await reconcilePublicAddress({ query } as unknown as Db, {
      origin: 'https://new.example.test:8443',
      hostname: 'new.example.test',
      tlsMode: 'external_proxy',
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('update deployment_config');
    expect(sql).toContain('update workspace');
    expect(sql).toContain('update oauth_clients');
    expect(sql).toContain('update telegram_config');
    expect(sql).toContain("'{publicAddress}', to_jsonb($3::text)");
    expect(sql).toContain("(select settings->>'publicAddress' from workspace where id=true) is distinct from $3 then null");
    expect(values).toEqual(['new.example.test', 'external_proxy', 'https://new.example.test:8443']);
  });

  it('propagates a database failure so the new runtime never becomes ready', async () => {
    const failure = new Error('transaction failed');
    const db = { query: vi.fn(async () => { throw failure; }) } as unknown as Db;
    await expect(reconcilePublicAddress(db, {
      origin: 'https://new.example.test', hostname: 'new.example.test', tlsMode: 'bundled_caddy',
    })).rejects.toBe(failure);
  });
});

import {testDb} from '../../../packages/core/test/helpers.js';
import {snapshotPublicAddress,restorePublicAddress} from '../src/setup/publicAddress.js';
it.each(['deployment_config','workspace','oauth_clients','telegram_config'])('database failure in %s changes no address metadata',async table=>{
 const db=await testDb();
 await db.query(`insert into workspace(id,name,settings) values(true,'Test','{"publicAddress":"https://old.example.test"}')`);
 await db.query(`update deployment_config set domain='old.example.test',certificate_verified_at='2026-01-01'`);
 await db.query(`insert into oauth_clients(provider,client_id,client_secret_enc,redirect_uri) values('google','fixture','not-a-secret','https://old.example.test/api/connections/google/callback')`);
 await db.query(`update telegram_config set webhook_url='https://old.example.test/telegram/webhook',webhook_set_at='2026-01-01'`);
 const before=await snapshotPublicAddress(db);
 await db.exec(`create function reject_address() returns trigger as $$ begin raise exception 'injected address failure'; end; $$ language plpgsql; create trigger reject_address before update on ${table} for each row execute function reject_address();`);
 await expect(reconcilePublicAddress(db,publicAddressFromEnvironment('https://new.example.test','proxy'))).rejects.toThrow();
 expect(await snapshotPublicAddress(db)).toEqual(before);
 await db.exec(`drop trigger reject_address on ${table}`);
 await reconcilePublicAddress(db,publicAddressFromEnvironment('https://new.example.test','proxy'));
 await restorePublicAddress(db,before);expect(await snapshotPublicAddress(db)).toEqual(before);
});


import {MasterKey,seal} from '@josi-ce/core';
import {verifyPublicAddress,restoreRemotePublicAddress} from '../src/setup/publicAddress.js';
it('finalizes remote Telegram registration only after health and can restore its prior URL', async()=>{
 const db=await testDb(),key=new MasterKey(Buffer.alloc(32,23));
 await db.query(`insert into users(email,username,role,status) values('address@example.test','address-admin','super_admin','active')`);
 await db.query(`update telegram_config set bot_token_enc=$1,webhook_secret_enc=$2,webhook_url='https://old.example.test/telegram/webhook',webhook_set_at='2026-01-01'`,[seal(key,{token:'synthetic-bot-token'}),seal(key,{secret:'synthetic-webhook-secret'})]);
 const before=await snapshotPublicAddress(db),bodies:any[]=[];
 const fetchImpl=(async(_url:any,init:any)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:true,result:true}),{status:200});}) as typeof fetch;
 await reconcilePublicAddress(db,publicAddressFromEnvironment('https://new.example.test','domain'));
 await verifyPublicAddress(db,key,'https://new.example.test',before,fetchImpl);
 expect(bodies[0].url).toBe('https://new.example.test/telegram/webhook');
 expect((await snapshotPublicAddress(db)).telegram?.webhook_set_at).toBeTruthy();
 await restoreRemotePublicAddress(db,key,before,fetchImpl);
 await restorePublicAddress(db,before);
 expect(bodies[1].url).toBe('https://old.example.test/telegram/webhook');
 expect(await snapshotPublicAddress(db)).toEqual(before);
 await expect(verifyPublicAddress(db,key,'http://192.168.1.20',before,fetchImpl)).rejects.toThrow(/Disconnect/);
 expect(bodies).toHaveLength(2);
 const failedFetch=(async()=>new Response(JSON.stringify({ok:false,description:'synthetic provider failure'}),{status:503})) as typeof fetch;
 await expect(verifyPublicAddress(db,key,'https://new.example.test',before,failedFetch)).rejects.toThrow();
 expect((await snapshotPublicAddress(db)).deployment?.certificate_verified_at).toEqual(before.deployment?.certificate_verified_at);
 expect(JSON.stringify(await db.query('select * from events'))).not.toContain('synthetic-bot-token');
});
