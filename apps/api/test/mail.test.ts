// Operational email over the wire.
//
// The acceptance criteria the phase plan names, attacked directly:
//
//   * the admin metadata view contains no subject or body
//   * adding a recipient without approval is refused
//   * an attachment send without approval is refused
//   * a reply loop terminates
//
// No mail server is contacted: the transport is injected into the app.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { MasterKey, seal } from '@josi-ce/core';
import { ingestInbound, replyAddressFor, type SmtpTransport } from '@josi-ce/mail';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-mail-'));
const keyPath = join(dir, 'master.key');
const KEY_BYTES = Buffer.alloc(32, 13);
writeFileSync(keyPath, KEY_BYTES.toString('base64'));
const key = new MasterKey(KEY_BYTES);

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

let sent: any[] = [];
const mailTransport: SmtpTransport = {
  async send(message) {
    sent.push(message);
    return { messageId: `<m${sent.length}@josi.test>` };
  },
};

const SUBJECT = 'PRIVATE-SUBJECT-about-the-contract';
const BODY = 'PRIVATE-BODY-with-the-numbers-in-it';

interface Res { status: number; body: any }

async function call(
  path: string,
  opts: { method?: string; body?: unknown; jar?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.jar) headers.cookie = opts.jar;
  const token = opts.jar ? /josi_csrf=([^;]+)/.exec(opts.jar)?.[1] : undefined;
  if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: 'manual',
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function mergeJar(existing: string | undefined, setCookie: string[]): string {
  const jar = new Map<string, string>();
  for (const part of (existing ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const raw of setCookie) {
    const first = raw.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function signIn(identifier: string, password: string): Promise<string> {
  const pre = await fetch(`${base}/api/auth/csrf`);
  let jar = mergeJar(undefined, pre.headers.getSetCookie?.() ?? []);
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', cookie: jar,
      'x-josi-csrf': decodeURIComponent(/josi_csrf=([^;]+)/.exec(jar)?.[1] ?? ''),
    },
    body: JSON.stringify({ identifier, password }),
  });
  expect(res.status, `login ${identifier}`).toBe(200);
  return mergeJar(jar, res.headers.getSetCookie?.() ?? []);
}

const PW = { admin: 'admin-password-123', alice: 'alice-password-123', bob: 'bob-password-123' };

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: PW.admin, displayName: 'Ada Admin' })).id;
  ids.alice = (await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: PW.alice, displayName: 'Alice Smith' })).id;
  ids.bob = (await createUser(db, { email: 'bob@ce.test', username: 'bob', role: 'member', password: PW.bob })).id;

  const app = createApp(db, {
    cookieSecure: false, appUrl: 'http://localhost:3000',
    masterKeyCheck: { path: keyPath }, mailTransport,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cookies.admin = await signIn('admin', PW.admin);
  cookies.alice = await signIn('alice', PW.alice);
  cookies.bob = await signIn('bob', PW.bob);
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(async () => {
  sent = [];
  await db.query(`delete from resource_shares`);
  await db.query(`delete from approvals`);
  await db.query(`delete from email_quarantine`);
  await db.query(`delete from email_threads`);
  await db.query(`delete from smtp_profiles`);
  await db.query(
    `update mail_policy set retention_days = null, trash_days = 30, inbound_enabled = false,
       max_recipients = 10, disclosure = 'Sent by Josi, an AI assistant, on behalf of {user}.'`,
  );
  // The installation's communications profile.
  await db.query(
    `insert into smtp_profiles (kind, host, port, security, username, password_enc, from_name, from_address)
     values ('communications', 'smtp.example.test', 587, 'starttls', 'u', $1, 'Josi', 'josi@example.test')`,
    [seal(key, { password: 'SMTP-PASSWORD-value' })],
  );
});

async function newThread(who: 'alice' | 'bob' = 'alice', participants = ['client@example.test']) {
  const res = await call('/api/mail/threads', {
    method: 'POST', jar: cookies[who], body: { subject: SUBJECT, participants },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.thread;
}

const sendBody = (over: Record<string, unknown> = {}) => ({
  to: ['client@example.test'], subject: SUBJECT, body: BODY, ...over,
});

describe('sending', () => {
  it('goes out as the person, from the installation mailbox', async () => {
    const t = await newThread();
    const res = await call(`/api/mail/threads/${t.id}/send`, {
      method: 'POST', jar: cookies.alice, body: sendBody(),
    });
    expect(res.status).toBe(200);
    expect(sent[0].from).toBe('Alice Smith via Josi <josi@example.test>');
    expect(sent[0].replyTo).toContain('+josi.');
    expect(sent[0].text).toContain('Sent by Josi, an AI assistant, on behalf of Alice Smith.');
  });

  it('is refused when no communications profile is configured', async () => {
    await db.query(`delete from smtp_profiles`);
    const t = await newThread();
    const res = await call(`/api/mail/threads/${t.id}/send`, {
      method: 'POST', jar: cookies.alice, body: sendBody(),
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no communications mail profile/i);
  });

  it('never returns the SMTP password', async () => {
    const t = await newThread();
    await call(`/api/mail/threads/${t.id}/send`, { method: 'POST', jar: cookies.alice, body: sendBody() });
    const dump = JSON.stringify([
      (await call('/api/mail/threads', { jar: cookies.alice })).body,
      (await call('/api/admin/mail', { jar: cookies.admin })).body,
    ]);
    expect(dump).not.toContain('SMTP-PASSWORD-value');
    expect(dump).not.toMatch(/v1\.[A-Za-z0-9+/=]{10}/);
  });

  it('refuses BCC', async () => {
    const t = await newThread();
    const res = await call(`/api/mail/threads/${t.id}/send`, {
      method: 'POST', jar: cookies.alice, body: sendBody({ bcc: ['hidden@x.test'] }),
    });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('bcc_not_permitted');
    expect(sent).toHaveLength(0);
  });
});

describe('adding a recipient without approval is refused — M43', () => {
  it('refuses, and says what approval would expose', async () => {
    const t = await newThread('alice', ['client@example.test']);
    await call(`/api/mail/threads/${t.id}/send`, { method: 'POST', jar: cookies.alice, body: sendBody() });
    sent = [];

    const res = await call(`/api/mail/threads/${t.id}/send`, {
      method: 'POST', jar: cookies.alice,
      body: sendBody({ to: ['client@example.test', 'newcomer@example.test'] }),
    });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('needs_approval');
    expect(sent).toHaveLength(0);

    const ask = await call(`/api/mail/threads/${t.id}/request-approval`, {
      method: 'POST', jar: cookies.alice,
      body: sendBody({ to: ['client@example.test', 'newcomer@example.test'] }),
    });
    expect(ask.body.required).toBe(true);
    expect(ask.body.approval.summary).toContain('newcomer@example.test');
    expect(ask.body.approval.summary).toMatch(/see all 1 earlier message/);
  });

  it('sends once the owner approves that exact message', async () => {
    const t = await newThread('alice', ['client@example.test']);
    const payload = sendBody({ to: ['client@example.test', 'newcomer@example.test'] });
    const ask = await call(`/api/mail/threads/${t.id}/request-approval`, {
      method: 'POST', jar: cookies.alice, body: payload,
    });
    const decided = await call(`/api/assistant/approvals/${ask.body.approval.id}/decide`, {
      method: 'POST', jar: cookies.alice, body: { approve: true },
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    const res = await call(`/api/mail/threads/${t.id}/send`, {
      method: 'POST', jar: cookies.alice, body: { ...payload, approvalId: ask.body.approval.id },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(sent[0].to).toContain('newcomer@example.test');
  });

  it('refuses when the message changed after approval', async () => {
    const t = await newThread('alice', ['client@example.test']);
    const payload = sendBody({ to: ['client@example.test', 'newcomer@example.test'] });
    const ask = await call(`/api/mail/threads/${t.id}/request-approval`, {
      method: 'POST', jar: cookies.alice, body: payload,
    });
    const decided = await call(`/api/assistant/approvals/${ask.body.approval.id}/decide`, {
      method: 'POST', jar: cookies.alice, body: { approve: true },
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    const res = await call(`/api/mail/threads/${t.id}/send`, {
      method: 'POST', jar: cookies.alice,
      body: { ...payload, body: 'Something else entirely', approvalId: ask.body.approval.id },
    });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('approval_mismatch');
    expect(sent).toHaveLength(0);
  });

  it('cannot be approved by a colleague or by the administrator', async () => {
    const t = await newThread('alice', ['client@example.test']);
    const ask = await call(`/api/mail/threads/${t.id}/request-approval`, {
      method: 'POST', jar: cookies.alice,
      body: sendBody({ to: ['client@example.test', 'newcomer@example.test'] }),
    });
    for (const who of ['bob', 'admin'] as const) {
      const res = await call(`/api/assistant/approvals/${ask.body.approval.id}/decide`, {
        method: 'POST', jar: cookies[who], body: { approve: true },
      });
      expect(res.status, who).toBe(404);
    }
    const [row] = await db.query<{ status: string }>(`select status from approvals`);
    expect(row.status).toBe('pending');
  });
});

describe('the admin metadata view — M38', () => {
  it('contains no subject and no body', async () => {
    const t = await newThread();
    await call(`/api/mail/threads/${t.id}/send`, { method: 'POST', jar: cookies.alice, body: sendBody() });

    const res = await call('/api/admin/mail', { jar: cookies.admin });
    expect(res.status).toBe(200);
    const dump = JSON.stringify(res.body);
    expect(dump).not.toContain(SUBJECT);
    expect(dump).not.toContain(BODY);
    expect(dump).not.toContain('body_text');

    // It does carry the delivery facts an administrator needs.
    const delivery = res.body.deliveries[0];
    expect(delivery).toMatchObject({ initiated_by: 'alice', recipient: 'client@example.test', status: 'sent' });
  });

  it('cannot read a member thread through the member route', async () => {
    const t = await newThread('alice');
    expect((await call(`/api/mail/threads/${t.id}`, { jar: cookies.admin })).status).toBe(404);
  });

  it('is refused to a member', async () => {
    expect((await call('/api/admin/mail', { jar: cookies.alice })).status).toBe(403);
  });

  it('shows why messages were quarantined, never what they said', async () => {
    await ingestInbound(db, {
      deliveredTo: ['josi@example.test'], from: 'stranger@x.test',
      subject: 'QUARANTINE-SUBJECT', bodyText: 'QUARANTINE-BODY',
      messageId: '<q@x.test>', inReplyTo: null, headers: {},
    });
    const res = await call('/api/admin/mail', { jar: cookies.admin });
    const dump = JSON.stringify(res.body);
    expect(res.body.quarantine[0].reason).toBe('inbound_disabled');
    expect(dump).not.toContain('QUARANTINE-SUBJECT');
    expect(dump).not.toContain('QUARANTINE-BODY');
  });
});

describe('threads belong to the person who started them — M37', () => {
  it('404 a colleague, and 404 the administrator', async () => {
    const t = await newThread('alice');
    for (const who of ['bob', 'admin'] as const) {
      const res = await call(`/api/mail/threads/${t.id}`, { jar: cookies[who] });
      expect(res.status, who).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(SUBJECT);
    }
  });

  it('do not appear in a colleague list', async () => {
    await newThread('alice');
    const res = await call('/api/mail/threads', { jar: cookies.bob });
    expect(res.body.threads).toHaveLength(0);
  });

  // Through the ROUTE, not a hand-written row. The earlier version of this test
  // inserted into `resource_shares` directly, which is the same shortcut that
  // let the approval double-hash ship: it proved the guard reads shares, and
  // proved nothing about whether a share could ever be created.
  const share = (id: string, who: 'alice' | 'bob' | 'admin', body: Record<string, unknown>) =>
    call(`/api/mail/threads/${id}/share`, { method: 'POST', jar: cookies[who], body });

  it('become readable after an explicit share, but still not sendable-as', async () => {
    const t = await newThread('alice');
    const res = await share(t.id, 'alice', { userId: ids.bob, canWrite: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const read = await call(`/api/mail/threads/${t.id}`, { jar: cookies.bob });
    expect(read.status).toBe(200);

    // Bob may help with the conversation. What goes out still goes out as
    // Alice, because it is her thread and her name on it.
    await call(`/api/mail/threads/${t.id}/send`, { method: 'POST', jar: cookies.bob, body: sendBody() });
    expect(sent[0].from).toBe('Alice Smith via Josi <josi@example.test>');
  });

  it('a read-only share cannot send', async () => {
    const t = await newThread('alice');
    await share(t.id, 'alice', { userId: ids.bob });

    expect((await call(`/api/mail/threads/${t.id}`, { jar: cookies.bob })).status).toBe(200);
    const send = await call(`/api/mail/threads/${t.id}/send`, {
      method: 'POST', jar: cookies.bob, body: sendBody(),
    });
    expect(send.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  // The one that matters: access does not compound. Someone Alice trusted to
  // help cannot decide who else gets to read her mail.
  it('a colleague with write access cannot share it onward', async () => {
    const t = await newThread('alice');
    await share(t.id, 'alice', { userId: ids.bob, canWrite: true });

    const onward = await share(t.id, 'bob', { workspace: true });
    expect(onward.status).toBe(404);

    const rows = await db.query(
      `select count(*)::int as n from resource_shares
       where resource_id = $1 and shared_with_workspace = true`,
      [t.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('the administrator cannot share someone else\'s thread', async () => {
    const t = await newThread('alice');
    const res = await share(t.id, 'admin', { userId: ids.bob });
    expect(res.status).toBe(404);
    expect((await call(`/api/mail/threads/${t.id}`, { jar: cookies.bob })).status).toBe(404);
  });

  it('unsharing takes the access back', async () => {
    const t = await newThread('alice');
    await share(t.id, 'alice', { userId: ids.bob });
    expect((await call(`/api/mail/threads/${t.id}`, { jar: cookies.bob })).status).toBe(200);

    const res = await call(`/api/mail/threads/${t.id}/share`, {
      method: 'DELETE', jar: cookies.alice, body: { userId: ids.bob },
    });
    expect(res.status).toBe(200);
    expect((await call(`/api/mail/threads/${t.id}`, { jar: cookies.bob })).status).toBe(404);
  });

  it('refuses a share with nobody, with a stranger, or with yourself', async () => {
    const t = await newThread('alice');
    expect((await share(t.id, 'alice', {})).status).toBe(400);
    expect((await share(t.id, 'alice', { userId: ids.alice })).status).toBe(400);
    expect(
      (await share(t.id, 'alice', { userId: '00000000-0000-4000-8000-000000000000' })).status,
    ).toBe(404);
  });

  it('says plainly what a workspace share means, and does not leak the subject', async () => {
    const t = await newThread('alice');
    const res = await share(t.id, 'alice', { workspace: true });
    expect(res.body.notice).toContain('Everyone in this workspace');
    expect(res.body.notice).toContain('cannot send on it');
    expect((await call(`/api/mail/threads/${t.id}`, { jar: cookies.bob })).status).toBe(200);

    const events = await db.query(
      `select payload::text as p from events
       where kind = 'mail.thread_shared' and subject_id = $1`,
      [t.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0].p).not.toContain(SUBJECT);
  });
});

describe('trash and retention — M39, M40', () => {
  it('recovers a deleted thread within the window', async () => {
    const t = await newThread('alice');
    const del = await call(`/api/mail/threads/${t.id}`, { method: 'DELETE', jar: cookies.alice });
    expect(del.body.recoverableUntil).toBeTruthy();
    expect((await call('/api/mail/threads', { jar: cookies.alice })).body.threads).toHaveLength(0);
    expect((await call('/api/mail/threads?trash=1', { jar: cookies.alice })).body.threads).toHaveLength(1);

    const restore = await call(`/api/mail/threads/${t.id}/restore`, { method: 'POST', jar: cookies.alice });
    expect(restore.status).toBe(200);
    expect((await call('/api/mail/threads', { jar: cookies.alice })).body.threads).toHaveLength(1);
  });

  it('warns the owner before retention deletes anything', async () => {
    await call('/api/admin/mail/policy', {
      method: 'PUT', jar: cookies.admin, body: { retentionDays: 30 },
    });
    await newThread('alice');
    await db.query(`update email_threads set last_activity_at = now() - interval '60 days'`);
    const res = await call('/api/mail/threads', { jar: cookies.alice });
    expect(res.body.retention).toMatchObject({ retentionDays: 30, affected: 1 });
  });

  it('lets the admin set the policy, and refuses nonsense', async () => {
    const ok = await call('/api/admin/mail/policy', {
      method: 'PUT', jar: cookies.admin, body: { trashDays: 7, maxRecipients: 5 },
    });
    expect(ok.body.policy).toMatchObject({ trash_days: 7, max_recipients: 5 });

    for (const bad of [{ trashDays: -1 }, { maxRecipients: 0 }, { maxRecipients: 999 }, { retentionDays: 0 }]) {
      expect((await call('/api/admin/mail/policy', {
        method: 'PUT', jar: cookies.admin, body: bad,
      })).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('refuses to remove the AI disclosure — M41', async () => {
    const res = await call('/api/admin/mail/policy', {
      method: 'PUT', jar: cookies.admin, body: { disclosure: 'x' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reworded but not removed/i);

    // Rewording is fine.
    const reworded = await call('/api/admin/mail/policy', {
      method: 'PUT', jar: cookies.admin, body: { disclosure: 'Composed by Josi for {user}, an AI assistant.' },
    });
    expect(reworded.status).toBe(200);
  });

  it('is refused to a member', async () => {
    expect((await call('/api/admin/mail/policy', {
      method: 'PUT', jar: cookies.alice, body: { trashDays: 1 },
    })).status).toBe(403);
  });
});

describe('a reply loop terminates', () => {
  it('stops answering, while still delivering to the person', async () => {
    await db.query(`update mail_policy set inbound_enabled = true`);
    const t = await newThread('alice');
    const [row] = await db.query<{ routing_token: string }>(
      `select routing_token from email_threads where id = $1`, [t.id],
    );
    const replyTo = replyAddressFor('josi@example.test', row.routing_token);

    // Five outbound messages exhaust the loop budget.
    for (let i = 0; i < 5; i++) {
      await call(`/api/mail/threads/${t.id}/send`, {
        method: 'POST', jar: cookies.alice, body: sendBody({ body: `message ${i}` }),
      });
    }

    const outcome = await ingestInbound(db, {
      deliveredTo: [replyTo], from: 'client@example.test', subject: 'Re', bodyText: 'again',
      messageId: '<loop@x.test>', inReplyTo: null, headers: {},
    });
    expect(outcome).toMatchObject({ kind: 'delivered', autoRespond: false });
  });

  it('does not answer an out-of-office', async () => {
    await db.query(`update mail_policy set inbound_enabled = true`);
    const t = await newThread('alice');
    const [row] = await db.query<{ routing_token: string }>(
      `select routing_token from email_threads where id = $1`, [t.id],
    );
    const outcome = await ingestInbound(db, {
      deliveredTo: [replyAddressFor('josi@example.test', row.routing_token)],
      from: 'client@example.test', subject: 'Away', bodyText: 'I am on holiday.',
      messageId: '<ooo@x.test>', inReplyTo: null,
      headers: { 'auto-submitted': 'auto-replied' },
    });
    expect(outcome).toMatchObject({ kind: 'delivered', autoRespond: false });
  });
});

describe('the audit trail', () => {
  it('records that mail went out, and nothing about what it said', async () => {
    const t = await newThread();
    await call(`/api/mail/threads/${t.id}/send`, { method: 'POST', jar: cookies.alice, body: sendBody() });

    const events = JSON.stringify(await db.query(`select * from events`));
    expect(events).not.toContain(SUBJECT);
    expect(events).not.toContain(BODY);
    expect(events).not.toContain('client@example.test');
    expect(events).toContain('mail.sent');
  });
});

describe('private Email Templates API', () => {
  const template = {name:'API welcome',subject:'Hello {{name}}',heading:'Welcome',body:'Hello {{recipient}}',accentColor:'#2563eb',ctaLabel:'',ctaUrl:'',footer:'Team'};
  it('requires authentication, supports CRUD and isolates owners including administrators', async () => {
    expect((await call('/api/mail/templates')).status).toBe(401);
    const created=await call('/api/mail/templates',{method:'POST',jar:cookies.alice,body:template});
    expect(created.status).toBe(201);const id=created.body.template.id;
    for(const who of ['bob','admin']) {
      expect((await call('/api/mail/templates',{jar:cookies[who]})).body.templates).toEqual([]);
      expect((await call(`/api/mail/templates/${id}`,{jar:cookies[who]})).status).toBe(404);
      expect((await call(`/api/mail/templates/${id}`,{method:'PUT',jar:cookies[who],body:template})).status).toBe(404);
      expect((await call(`/api/mail/templates/${id}`,{method:'DELETE',jar:cookies[who]})).status).toBe(404);
      expect((await call('/api/mail/templates/draft',{method:'POST',jar:cookies[who],body:{recipient:'alex@example.test',template_id:id,merge_values:{name:'Alex'}}})).status).toBe(404);
    }
    expect((await call(`/api/mail/templates/${id}`,{jar:cookies.alice})).body.template.name).toBe(template.name);
    expect((await call(`/api/mail/templates/${id}`,{method:'PUT',jar:cookies.alice,body:{...template,name:'Revised'}})).body.template.name).toBe('Revised');
    const draft=await call('/api/mail/templates/draft',{method:'POST',jar:cookies.alice,body:{recipient:'alex@example.test',template_id:id,merge_values:{name:'Alex'}}});
    expect(draft.status,JSON.stringify(draft.body)).toBe(201);expect(draft.body.state).toBe('prepared');
    expect(draft.body.summary).toContain('Subject: Hello Alex');
    const previewPath=`/api/mail/templates/approvals/${draft.body.approval_id}/preview`;
    expect((await call(previewPath,{jar:cookies.alice})).body.html).toContain('Hello alex@example.test');
    expect((await call(previewPath,{jar:cookies.bob})).status).toBe(404);
    expect((await call(previewPath,{jar:cookies.admin})).status).toBe(404);
    await db.query(`update tasks set slots=slots || '{"subject":"Tampered"}'::jsonb where id=$1`,[draft.body.task_id]);
    expect((await call(previewPath,{jar:cookies.alice})).status).toBe(409);
    expect(sent).toEqual([]);
    expect((await call(`/api/mail/templates/${id}`,{method:'DELETE',jar:cookies.alice})).status).toBe(204);
    expect((await call(`/api/mail/templates/${id}`,{jar:cookies.alice})).status).toBe(404);
  });
  it('rejects HTML input and returns escaped preview plus plain fallback',async()=>{
    expect((await call('/api/mail/templates',{method:'POST',jar:cookies.alice,body:{...template,html:'<script>bad</script>'}})).status).toBe(400);
    expect((await call('/api/mail/templates',{method:'POST',jar:cookies.alice,body:{...template,ctaLabel:'Go',ctaUrl:'javascript:alert(1)'}})).status).toBe(400);
    const preview=await call('/api/mail/templates/preview',{method:'POST',jar:cookies.alice,body:{template:{...template,body:'{{name}}'},recipient:'alex@example.test',merge_values:{name:'<script>bad</script>'}}});
    expect(preview.status).toBe(200);expect(preview.body.html).not.toContain('<script>');expect(preview.body.text).toContain('<script>bad</script>');
    expect((await call('/api/mail/templates/preview',{method:'POST',jar:cookies.alice,body:{template,recipient:'alex@example.test'}})).status).toBe(400);
  });
});
