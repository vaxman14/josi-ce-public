// The connected-data tools, end to end against the real schema.
//
// No provider is contacted: fetch is a stub returning canned Gmail/Calendar
// payloads. What IS real: the migrations, the connection and capability spine,
// the sealed tokens, the master key, and every gating decision. The cases here
// are the ones item 17 (round 2) exists for — the switch honoured at offering
// time AND execution time, cross-user isolation, and empty reported as empty.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { addMessage, markActionsPresented, MasterKey } from '@josi-ce/core';
import {
  createInternalEvent, ensureInternalCalendar, saveClient, setCapability, upsertConnection, type ConnectionRow,
} from '@josi-ce/connectors';
import { executeAssistantTool } from '../src/execute.js';
import { dataToolAvailability } from '../src/dataTools.js';
import { buildCore } from '../src/mcp/server.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db: TestDb;
let alice: string;
let bob: string;
const key = new MasterKey(Buffer.alloc(32, 7));

const GOOGLE_READ_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/contacts.readonly',
].join(' ');

beforeEach(async () => {
  db = await testDb();
  alice = (await createUser(db, { email: 'a@ce.test', username: 'alice', role: 'super_admin' })).id;
  bob = (await createUser(db, { email: 'b@ce.test', username: 'bob', role: 'member' })).id;
  await saveClient(db, key, {
    provider: 'google',
    clientId: 'google-client-id',
    clientSecret: 'google-CLIENT-SECRET',
    redirectUri: 'https://josi.example.test/api/connections/google/callback',
    actorUserId: alice,
  });
});

async function connectGoogle(user: string): Promise<ConnectionRow> {
  const connection = await upsertConnection(db, key, {
    ownerUserId: user,
    provider: 'google',
    tokens: {
      accessToken: 'live-access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      grantedScopes: GOOGLE_READ_SCOPES,
    },
    accountEmail: 'a@gmail.test',
    providerAccountId: 'acct-1',
    requestedCapabilities: ['google.mail.read', 'google.calendar.read', 'google.calendar.write', 'google.contacts.read'],
  });
  await db.query(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name) values($1,$2,'selected@example.test','Selected calendar')`,[user,connection.id]);
  return connection;
}

async function enable(connection: ConnectionRow, capability: string, user = alice): Promise<void> {
  await setCapability(db, { connection, capability, enabled: true, actorUserId: user });
}

/** A Gmail-and-Calendar shaped fetch stub. */
function providerFetch(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const u = String(url);
    urls.push(u);
    let body: unknown = {};
    if (u.includes('gmail') && u.includes('/messages?')) {
      body = { messages: [{ id: 'm1' }] };
    } else if (u.includes('gmail') && u.includes('/messages/m1')) {
      body = {
        id: 'm1',
        snippet: 'lunch thursday?',
        internalDate: '1700000000000',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'ann@example.test' },
            { name: 'To', value: 'roman@example.test' },
            { name: 'Subject', value: 'lunch' },
          ],
          body: { data: Buffer.from('are you free thursday?', 'utf8').toString('base64url') },
        },
      };
    } else if (u.includes('calendar/v3')) {
      body = {
        items: [{
          id: 'ev1',
          summary: 'standup',
          start: { dateTime: '2026-09-04T09:00:00Z' },
          end: { dateTime: '2026-09-04T09:15:00Z' },
        }],
      };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const access = (fetchImpl: typeof fetch) => ({ masterKey: () => key, fetchImpl });

describe('offering follows the switches', () => {
  it('offers nothing when nothing is connected, and names every fix', async () => {
    const out = await dataToolAvailability(db, alice);
    expect(out.specs).toHaveLength(0);
    expect(out.granted).toEqual([]);
    expect(out.denied.map((d) => d.what).sort()).toEqual(['calendar', 'contacts', 'email']);
    expect(out.denied[0].hint).toContain('Connections page');
  });

  it('offers nothing while the switches are off, even with scopes granted', async () => {
    await connectGoogle(alice);
    const out = await dataToolAvailability(db, alice);
    expect(out.specs).toHaveLength(0);
    // The hint now names the SWITCH, not the connection — the person already
    // connected; the smallest fix is enabling.
    const mail = out.denied.find((d) => d.what === 'email');
    expect(mail?.hint).toContain('not turned on');
    expect(mail?.hint).toContain('Connections page');
  });

  it('offers exactly the enabled family', async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.mail.read');
    const out = await dataToolAvailability(db, alice);
    expect(out.specs.map((s) => s.def.name).sort()).toEqual(['check_email_availability', 'read_email', 'search_email']);
    expect(out.granted).toEqual(['mail']);
    expect(out.denied.map((d) => d.what).sort()).toEqual(['calendar', 'contacts']);
  });

  it('offers contact search on local rows alone, with every provider switch off', async () => {
    await db.query(
      `insert into contacts (owner_user_id, name, email) values ($1, 'Ann Local', 'ann@example.test')`,
      [alice],
    );
    const out = await dataToolAvailability(db, alice);
    expect(out.specs.map((s) => s.def.name)).toEqual(['search_contacts']);
  });
});

describe('execution re-checks the switch', () => {
  it('reads real mail when the switch is on', async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.mail.read');
    const { fetchImpl, urls } = providerFetch();
    const ctx = { userId: alice, threadId: null, connectors: access(fetchImpl) };

    const search = await executeAssistantTool(db, ctx, 'search_email', { query: 'lunch' }) as {
      ok: boolean; emails: Array<{ email_id: string; subject: string | null }>;
    };
    expect(search.ok).toBe(true);
    expect(search.emails).toHaveLength(1);
    expect(search.emails[0].email_id).toBe('google:m1');
    expect(search.emails[0].subject).toBe('lunch');
    // The live token actually travelled to the provider.
    expect(urls.some((u) => u.includes('gmail'))).toBe(true);

    const read = await executeAssistantTool(db, ctx, 'read_email', { email_id: 'google:m1' }) as {
      ok: boolean; email: { body: string; truncated: boolean };
    };
    expect(read.ok).toBe(true);
    expect(read.email.body).toBe('are you free thursday?');
    expect(read.email.truncated).toBe(false);
  });

  it('refuses at EXECUTION time when the switch went off after offering', async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.mail.read');
    // Offered…
    expect((await dataToolAvailability(db, alice)).granted).toEqual(['mail']);
    // …then the person flips it off mid-conversation.
    await setCapability(db, { connection, capability: 'google.mail.read', enabled: false, actorUserId: alice });

    const { fetchImpl, urls } = providerFetch();
    const result = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: access(fetchImpl) },
      'search_email', { query: 'lunch' },
    ) as { ok: boolean; error: string; message: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('not_enabled');
    expect(result.message).toContain('Connections page');
    // And nothing reached the provider.
    expect(urls).toHaveLength(0);
  });

  it("one person's switch grants nothing to another person", async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.mail.read');
    const { fetchImpl, urls } = providerFetch();
    const result = await executeAssistantTool(
      db, { userId: bob, threadId: null, connectors: access(fetchImpl) },
      'search_email', { query: 'lunch' },
    ) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(urls).toHaveLength(0);
  });

  it('refuses honestly when the executor has no way to open tokens', async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.mail.read');
    const result = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: null },
      'search_email', { query: 'lunch' },
    ) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unavailable');
  });

  it('lists calendar events for the default week window', async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.calendar.read');
    const origin = await ensureInternalCalendar(db, { ownerUserId: alice, connectionId: connection.id, provider: 'google' });
    const start = new Date(Date.now() + 3_600_000); const end = new Date(start.getTime() + 900_000);
    const saved = await createInternalEvent(db, { ownerUserId: alice, originId: origin.id,
      event: { title: 'standup', start: start.toISOString(), end: end.toISOString() } });
    const result = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: null },
      'query_calendar', {},
    ) as { ok: boolean; events: Array<{ event_id: string; title: string | null }>; range: { start: string; end: string } };
    expect(result.ok).toBe(true);
    expect(result.events[0]).toMatchObject({ event_id: saved.id, title: 'standup' });
    const days = (new Date(result.range.end).getTime() - new Date(result.range.start).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
  });

  it('refuses a false-empty claim until every selected calendar has fresh successful coverage', async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.calendar.read');
    const missing = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: null }, 'query_calendar', {},
    ) as {ok:boolean;error:string;message:string};
    expect(missing).toMatchObject({ok:false,error:'calendar_coverage_unavailable'});
    expect(missing.message).toMatch(/cannot honestly say.*empty/i);

    const origin=await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:connection.id,provider:'google',providerCalendarId:'selected@example.test'});
    await db.query(`update calendar_sync_origins set status='idle',last_sync_at=now() where id=$1`,[origin.id]);
    const fresh = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: null }, 'query_calendar', {},
    ) as { ok: boolean; events: unknown[]; message?: string };
    expect(fresh.ok).toBe(true);
    expect(fresh.events).toEqual([]);
    expect(fresh.message).toContain('no events');

    await db.query(`update calendar_sync_origins set last_sync_at=now()-interval '1 day' where id=$1`,[origin.id]);
    expect(await executeAssistantTool(db,{userId:alice,threadId:null,connectors:null},'query_calendar',{})).toMatchObject({ok:false,error:'calendar_coverage_unavailable'});
    await db.query(`update calendar_sync_origins set last_sync_at=now(),status='error' where id=$1`,[origin.id]);
    expect(await executeAssistantTool(db,{userId:alice,threadId:null,connectors:null},'query_calendar',{})).toMatchObject({ok:false,error:'calendar_coverage_unavailable'});
  });

  it('refuses an unreasonable calendar range rather than guessing one', async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.calendar.read');
    const result = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: access(providerFetch().fetchImpl) },
      'query_calendar', { start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' },
    ) as { ok: boolean; error: string };
    expect(result).toMatchObject({ ok: false, error: 'bad_time' });
    expect(await executeAssistantTool(db,{userId:alice,threadId:null,connectors:access(providerFetch().fetchImpl)},'query_calendar',{start:'not-a-date'})).toMatchObject({ok:false,error:'bad_time'});
  });
});

describe('contacts prefer the local store', () => {
  it('finds a locally synced contact without touching any provider', async () => {
    await db.query(
      `insert into contacts (owner_user_id, name, email, phone) values ($1, 'Ann Chen', 'ann@example.test', '+1 555 0100')`,
      [alice],
    );
    const { fetchImpl, urls } = providerFetch();
    const result = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: access(fetchImpl) },
      'search_contacts', { query: 'ann' },
    ) as { ok: boolean; source: string; contacts: Array<{ name: string | null }> };
    expect(result).toMatchObject({ ok: true, source: 'local' });
    expect(result.contacts[0].name).toBe('Ann Chen');
    expect(urls).toHaveLength(0);
  });

  it("never returns another person's local contacts", async () => {
    await db.query(
      `insert into contacts (owner_user_id, name, email) values ($1, 'Ann Chen', 'ann@example.test')`,
      [alice],
    );
    const result = await executeAssistantTool(
      db, { userId: bob, threadId: null, connectors: null },
      'search_contacts', { query: 'ann' },
    ) as { ok: boolean; contacts: unknown[] };
    expect(result.ok).toBe(true);
    expect(result.contacts).toEqual([]);
  });

  it('reports no match against a populated store without a provider trip', async () => {
    await db.query(
      `insert into contacts (owner_user_id, name) values ($1, 'Somebody Else')`,
      [alice],
    );
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.contacts.read');
    const { fetchImpl, urls } = providerFetch();
    const result = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: access(fetchImpl) },
      'search_contacts', { query: 'ann' },
    ) as { ok: boolean; contacts: unknown[]; message?: string };
    expect(result.contacts).toEqual([]);
    expect(result.message).toContain('No contact matched');
    expect(urls).toHaveLength(0);
  });

  it('falls back to the provider only when the local store is empty and the switch is on', async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.contacts.read');
    const people = (async (url: RequestInfo | URL) => {
      expect(String(url)).toContain('people.googleapis.com');
      return new Response(JSON.stringify({
        connections: [{
          resourceName: 'people/p1',
          names: [{ displayName: 'Ann Remote' }],
          emailAddresses: [{ value: 'ann@example.test' }],
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const result = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: access(people) },
      'search_contacts', { query: 'ann' },
    ) as { ok: boolean; source: string; contacts: Array<{ contact_id: string; name: string | null }> };
    expect(result).toMatchObject({ ok: true, source: 'provider' });
    expect(result.contacts[0]).toMatchObject({ contact_id: 'google:people/p1', name: 'Ann Remote' });
  });
});

describe('the MCP server offers the same catalogue', () => {
  it('lists a data tool the turn offered, and refuses one it did not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'josi-datatools-mcp-'));
    const core = buildCore({
      databaseUrl: null, passwordFile: null, masterKeyPath: null,
      userId: alice, sessionKey: 's1', threadId: null,
      tools: ['search_email', 'read_email'],
      callsPath: join(dir, 'calls.jsonl'),
    }, async () => db);
    const names = core.tools.map((t) => t.name);
    expect(names).toContain('search_email');
    expect(names).toContain('read_email');
    expect(names).not.toContain('query_calendar');
    // Executing an offered tool still re-checks the switch in the database —
    // nothing is enabled for alice here, so the answer is the honest refusal.
    const outcome = await core.execute('search_email', { query: 'x' }, 'c1');
    const parsed = JSON.parse(outcome.text) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(['not_enabled', 'unavailable']).toContain(parsed.error);
    const recorded=JSON.parse(readFileSync(join(dir,'calls.jsonl'),'utf8').trim());
    expect(recorded).toMatchObject({id:'c1',name:'search_email',input:{query:'x'},result:parsed});
  });
});

describe('live mailbox availability',()=>{
  it('claims availability only after a successful provider request',async()=>{
    const c=await connectGoogle(alice);await enable(c,'google.mail.read');
    const good=providerFetch();
    expect(await executeAssistantTool(db,{userId:alice,threadId:null,connectors:access(good.fetchImpl)},'check_email_availability',{})).toMatchObject({ok:true,available:true,providers:['Gmail']});
    expect(good.urls.some(url=>url.includes('/gmail/v1/users/me/profile'))).toBe(true);
    const failed=(async()=>new Response('',{status:503})) as unknown as typeof fetch;
    expect(await executeAssistantTool(db,{userId:alice,threadId:null,connectors:access(failed)},'check_email_availability',{})).toMatchObject({ok:false,error:'provider_unavailable'});
  });
});

describe('multi-turn consequential action drafts',()=>{
  async function present(threadId:string,result:{task_id?:unknown},body:string){
    const message=await addMessage(db,{threadId,direction:'out',body});
    if(typeof result.task_id==='string')await markActionsPresented(db,{ownerUserId:alice,threadId,taskIds:[result.task_id],messageId:message.id});
  }
  it('retains the exact email fields across follow-up completion and retries idempotently',async()=>{
    const thread=(await db.query<{id:string}>(`insert into threads(owner_user_id,title) values($1,'Email exact repro') returning id`,[alice]))[0].id;
    const ctx={userId:alice,threadId:thread,turnId:null,connectors:null};
    const first=await executeAssistantTool(db,ctx,'draft_email',{recipient:'romanvaxman14@gmail.com',body:'testing the connection'}) as any;
    expect(first).toMatchObject({ok:true,state:'collecting',missing_slots:['subject']});
    await present(thread,first,'What subject should I use?');
    const second=await executeAssistantTool(db,ctx,'draft_email',{subject:'testing the coonection'}) as any;
    expect(second).toMatchObject({ok:true,state:'prepared'});
    expect(second.summary).toContain('To: romanvaxman14@gmail.com');
    expect(second.summary).toContain('Subject: testing the coonection');
    expect(second.summary).toContain('Body: testing the connection');
    const retry=await executeAssistantTool(db,ctx,'draft_email',{subject:'testing the coonection'}) as any;
    expect(retry).toMatchObject({task_id:second.task_id,approval_id:second.approval_id,state:'prepared'});
    expect(await db.query(`select id from assistant_action_states where thread_id=$1 and domain='email'`,[thread])).toHaveLength(1);
  });

  it('uses the one write default without asking among read calendars, preserves a separate EDD event, and records conflicts',async()=>{
    let c=await connectGoogle(alice);await enable(c,'google.calendar.read');
    c=await upsertConnection(db,key,{ownerUserId:alice,provider:'google',providerAccountId:'acct-1',accountEmail:'a@gmail.test',tokens:{accessToken:'live-access-token',refreshToken:'refresh-token',expiresIn:3600,grantedScopes:`${GOOGLE_READ_SCOPES} https://www.googleapis.com/auth/calendar`},requestedCapabilities:['google.calendar.write']});
    await enable(c,'google.calendar.write');
    await db.query(`update calendar_sources set is_primary=true,is_write_default=true,name='Main',writable=true where connection_id=$1 and provider_calendar_id='selected@example.test'`,[c.id]);
    await db.query(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name,is_primary) values($1,$2,'secondary','LexisNexis',false)`,[alice,c.id]);
    const origin=await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:c.id,provider:'google',providerCalendarId:'selected@example.test',name:'Main'});
    await createInternalEvent(db,{ownerUserId:alice,originId:origin.id,event:{title:'Existing conflict',start:'2026-09-18T15:00:00-07:00',end:'2026-09-18T15:30:00-07:00'}});
    const thread=(await db.query<{id:string}>(`insert into threads(owner_user_id,title) values($1,'Calendar exact repro') returning id`,[alice]))[0].id;
    const ctx={userId:alice,threadId:thread,turnId:null,connectors:null};
    expect(await db.query(`select c.id from connections c join connection_capabilities cc on cc.connection_id=c.id where c.id=$1 and cc.capability='google.calendar.read' and cc.enabled and cc.scopes_granted_at is not null`,[c.id])).toHaveLength(1);
    const prepared=await executeAssistantTool(db,ctx,'draft_calendar_event',{title:'Phone call with EDD',start:'2026-09-18T15:00:00-07:00',end:'2026-09-18T15:30:00-07:00'}) as any;
    expect(prepared,JSON.stringify(prepared)).toMatchObject({ok:true,state:'prepared'});
    const [task]=await db.query<{slots:any}>(`select slots from tasks where id=$1`,[prepared.task_id]);
    expect(task.slots).toMatchObject({title:'Phone call with EDD',start:'2026-09-18T15:00:00-07:00',end:'2026-09-18T15:30:00-07:00',calendar_intent:'create_separate_event',calendar_source:{calendar_name:'Main'},calendar_availability:{verified:true,conflicts:[{title:'Existing conflict'}]}});
    expect(JSON.stringify(task.slots)).not.toContain('LexisNexis');
    expect(task.slots).not.toHaveProperty('event_id');
  });
});

describe('exact calendar source receipts',()=>{
  it('queries only the selected secondary calendar, reuses its source for details and durable reminders',async()=>{
    const c=await connectGoogle(alice);await enable(c,'google.calendar.read');
    await db.query(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name,selected) values($1,$2,'primary','Not selected',false)`,[alice,c.id]);
    const origin=await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:c.id,provider:'google',providerCalendarId:'selected@example.test',name:'Selected calendar'});
    const starts=new Date(Date.now()+3_600_000),ends=new Date(Date.now()+7_200_000);
    const local=await createInternalEvent(db,{ownerUserId:alice,originId:origin.id,event:{title:'Shared meeting',start:starts.toISOString(),end:ends.toISOString()}});
    await db.query(`insert into calendar_event_links(origin_id,event_id,provider_event_id) values($1,$2,'same-event')`,[origin.id,local.id]);
    const ctx={userId:alice,threadId:null,connectors:null};
    const receipt=await executeAssistantTool(db,ctx,'query_calendar',{}) as any;
    expect(receipt.events[0]).toMatchObject({provider:'google',account_id:c.id,account:'a@gmail.test',calendar_id:'selected@example.test',calendar_name:'Selected calendar',provider_event_id:'same-event'});
    const detail=await executeAssistantTool(db,ctx,'get_event',{event_id:receipt.events[0].event_id}) as any;
    expect(detail.event).toMatchObject(receipt.events[0]);
    const reminder=await executeAssistantTool(db,ctx,'schedule_reminder',{message:'Meeting',in_minutes:60,calendar_event_id:receipt.events[0].event_id}) as any;
    expect(reminder.calendar_source.calendar_id).toBe('selected@example.test');
    const [saved]=await db.query<{body:string}>(`select body from reminders where id=$1`,[reminder.reminder_id]);
    expect(saved.body).toContain(receipt.events[0].event_id);
  });
  it('does not fall back after deselection, revocation, a forged source or cross-user request',async()=>{
    const c=await connectGoogle(alice);await enable(c,'google.calendar.read');const origin=await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:c.id,provider:'google',providerCalendarId:'selected@example.test'});const start=new Date(Date.now()+3_600_000),end=new Date(Date.now()+7_200_000);await createInternalEvent(db,{ownerUserId:alice,originId:origin.id,event:{title:'Meeting',start:start.toISOString(),end:end.toISOString()}});const ctx={userId:alice,threadId:null,connectors:null};
    const receipt=await executeAssistantTool(db,ctx,'query_calendar',{}) as any;
    expect(await executeAssistantTool(db,{...ctx,userId:bob},'get_event',{event_id:receipt.events[0].event_id})).toMatchObject({ok:false});
    expect(await executeAssistantTool(db,ctx,'query_calendar',{source_id:'00000000-0000-0000-0000-000000000000'})).toMatchObject({ok:false});
    await db.query(`update calendar_sources set selected=false where owner_user_id=$1`,[alice]);
    expect(await executeAssistantTool(db,ctx,'query_calendar',{})).toMatchObject({ok:false});
    await setCapability(db,{connection:c,capability:'google.calendar.read',enabled:false,actorUserId:alice});
    expect(await executeAssistantTool(db,ctx,'get_event',{event_id:receipt.events[0].event_id})).toMatchObject({ok:false});
  });
  it('keeps identical event IDs in two accounts distinct and never fetches the other account on follow-up',async()=>{
    const first=await connectGoogle(alice);await enable(first,'google.calendar.read');
    const second=await upsertConnection(db,key,{ownerUserId:alice,provider:'google',providerAccountId:'acct-2',accountEmail:'second@example.test',tokens:{accessToken:'second-access',refreshToken:'second-refresh',expiresIn:3600,grantedScopes:GOOGLE_READ_SCOPES},requestedCapabilities:['google.calendar.read']});await enable(second,'google.calendar.read');
    await db.query(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name) values($1,$2,'second-calendar','Second calendar')`,[alice,second.id]);
    const firstOrigin=await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:first.id,provider:'google',providerCalendarId:'selected@example.test'});
    const secondOrigin=await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:second.id,provider:'google',providerCalendarId:'second-calendar'});
    const start=new Date(Date.now()+3_600_000),end=new Date(Date.now()+7_200_000);
    const one=await createInternalEvent(db,{ownerUserId:alice,originId:firstOrigin.id,event:{title:'Meeting',start:start.toISOString(),end:end.toISOString()}});const two=await createInternalEvent(db,{ownerUserId:alice,originId:secondOrigin.id,event:{title:'Meeting',start:start.toISOString(),end:end.toISOString()}});
    await db.query(`insert into calendar_event_links(origin_id,event_id,provider_event_id) values($1,$2,'same-event'),($3,$4,'same-event')`,[firstOrigin.id,one.id,secondOrigin.id,two.id]);
    const ctx={userId:alice,threadId:null,connectors:null};const receipt=await executeAssistantTool(db,ctx,'query_calendar',{}) as any;
    expect(receipt.events).toHaveLength(2);expect(new Set(receipt.events.map((e:any)=>e.event_id)).size).toBe(2);
    const secondEvent=receipt.events.find((e:any)=>e.account_id===second.id);
    const detail=await executeAssistantTool(db,ctx,'get_event',{event_id:secondEvent.event_id}) as any;
    expect(detail.event.account).toBe('second@example.test');
    expect((await executeAssistantTool(db,ctx,'query_calendar',{source_id:secondEvent.source_id}) as any).events).toHaveLength(1);
  });
});
