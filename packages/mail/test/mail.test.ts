// Operational email.
//
// No mail server is contacted: the transport is a function that records what it
// was asked to send. That is the only way to assert what goes into a header,
// and it is a standing constraint for this project.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { decideApproval, requestApproval } from '@josi-ce/core';
import {
  LOOP_MAX_AUTO_REPLIES, MailIdentityError, SendRefused,
  applyDisclosure, approvalRequiredFor, assertSafeAddress, checkRecipientPolicy, classifySmtpError,
  createThread, encodeDisplayName, ingestInbound, listThreadsFor, looksAutomated, mailPolicy,
  messageFingerprint, messagePayload, operationalSender, quarantineSummary, replyAddressFor, restoreThread,
  retentionNotice, routingTokenFrom, runRetention, sendOperationalEmail, trashThread,
  type SmtpTransport,
} from '../src/index.js';

let db: TestDb;
let alice: string;
let bob: string;

/** Records what it was handed. Nothing leaves the process. */
let sent: any[] = [];
let failNext: Error | null = null;
const transport: SmtpTransport = {
  async send(message) {
    if (failNext) { const err = failNext; failNext = null; throw err; }
    sent.push(message);
    return { messageId: `<generated-${sent.length}@josi.test>` };
  },
};

const PROFILE = { fromAddress: 'josi@example.test', fromName: 'Josi' };

beforeEach(async () => {
  db = await testDb();
  sent = [];
  failNext = null;
  alice = (await createUser(db, { email: 'a@ce.test', username: 'alice', role: 'super_admin' })).id;
  bob = (await createUser(db, { email: 'b@ce.test', username: 'bob', role: 'member' })).id;
});

const send = (over: Record<string, unknown> = {}) =>
  sendOperationalEmail({
    db, transport,
    threadId: (over.threadId as string) ?? '',
    initiator: { id: alice, name: 'Alice Smith' },
    to: ['client@example.test'],
    subject: 'Thursday',
    body: 'Are you free Thursday?',
    profile: PROFILE,
    capabilityAllowed: true,
    ...over,
  } as any);

async function thread(owner = alice, participants: string[] = ['client@example.test']) {
  return createThread(db, { ownerUserId: owner, subject: 'Thursday', participants });
}

// ------------------------------------------------------------- M35 identity

describe('who the message says it is from', () => {
  it('sends as "<person> via Josi" from the installation mailbox', async () => {
    const t = await thread();
    await send({ threadId: t.id });
    // The person's NAME with the installation's ADDRESS. Putting her own
    // address in From would be a forgery that SPF and DMARC reject.
    //
    // Unquoted, correctly: RFC 5322 only requires quoting when the display name
    // contains something outside the atom set, and `encodeDisplayName` is
    // tested separately for the cases that do.
    expect(sent[0].from).toBe('Alice Smith via Josi <josi@example.test>');
    expect(sent[0].from).not.toContain('a@ce.test');
  });

  it('quotes a display name that needs it, and escapes what would break the header', () => {
    expect(encodeDisplayName('Alice Smith')).toBe('Alice Smith');
    expect(encodeDisplayName('Smith, Alice')).toBe('"Smith, Alice"');
    expect(encodeDisplayName('A "Big" Name')).toBe('"A \\"Big\\" Name"');
  });

  it('refuses an address that could carry a second header', () => {
    for (const bad of [
      'a@b.test\r\nBcc: victim@x.test',
      'a@b.test\nSubject: injected',
      'a<b>@c.test',
      'a,b@c.test',
    ]) {
      expect(() => assertSafeAddress(bad), bad).toThrow(MailIdentityError);
    }
    expect(assertSafeAddress(' ok@example.test ')).toBe('ok@example.test');
  });

  it('routes replies to a per-thread address, not to a shared inbox', async () => {
    const t = await thread();
    await send({ threadId: t.id });
    expect(sent[0].replyTo).toBe(`josi+josi.${t.routing_token}@example.test`);
    // The token is random, so one address reveals nothing about another.
    expect(t.routing_token).not.toContain(alice);
    expect(t.routing_token).not.toContain(t.id);
  });

  it('reads its own routing token back, and refuses to guess', () => {
    const address = replyAddressFor('josi@example.test', 'a'.repeat(32));
    expect(routingTokenFrom(address)).toBe('a'.repeat(32));
    expect(routingTokenFrom('josi@example.test')).toBeNull();
    expect(routingTokenFrom('someone+else@example.test')).toBeNull();
  });
});

// ----------------------------------------------------------- M41 disclosure

describe('the AI disclosure', () => {
  it('is appended to every message', async () => {
    const t = await thread();
    await send({ threadId: t.id });
    expect(sent[0].text).toMatch(/Sent by Josi, an AI assistant, on behalf of Alice Smith\./);
  });

  it('can be reworded', async () => {
    await db.query(`update mail_policy set disclosure = 'Written by Josi for {user}, not by a person.'`);
    const t = await thread();
    await send({ threadId: t.id });
    expect(sent[0].text).toContain('Written by Josi for Alice Smith, not by a person.');
  });

  it('cannot be removed', () => {
    // The refusal is the point: an operator who blanks the setting, or a bug
    // that passes an empty string, must not produce mail that reads as though a
    // human wrote it.
    for (const empty of ['', '   ', 'short']) {
      expect(() => applyDisclosure({ body: 'hello', disclosure: empty, personName: 'A' }), empty)
        .toThrow(/cannot be removed|too short/i);
    }
  });

  it('is refused at the database level too', async () => {
    await expect(db.query(`update mail_policy set disclosure = ''`)).rejects.toThrow();
    await expect(db.query(`update mail_policy set disclosure = '   '`)).rejects.toThrow();
  });

  it('is not stacked up on a redraft', () => {
    const once = applyDisclosure({ body: 'hi', disclosure: 'Sent by Josi for {user}.', personName: 'A' });
    const twice = applyDisclosure({ body: once, disclosure: 'Sent by Josi for {user}.', personName: 'A' });
    expect(twice).toBe(once);
  });
});

// ------------------------------------------------------ M42 operational only

describe('operational, not marketing', () => {
  it('allows a genuine multi-person thread', () => {
    expect(() => checkRecipientPolicy({
      to: ['a@x.test', 'b@x.test'], cc: ['c@x.test'], maxRecipients: 10,
    })).not.toThrow();
  });

  it('refuses BCC outright', () => {
    // BCC to many people is the shape of a mailing list, and there is no
    // legitimate operational reason to hide participants from each other.
    expect(() => checkRecipientPolicy({
      to: ['a@x.test'], cc: [], bcc: ['hidden@x.test'], maxRecipients: 10,
    })).toThrow(SendRefused);
  });

  it('refuses a recipient list past the installation ceiling', () => {
    const many = Array.from({ length: 11 }, (_, i) => `p${i}@x.test`);
    expect(() => checkRecipientPolicy({ to: many, cc: [], maxRecipients: 10 }))
      .toThrow(/not for announcements or outreach/i);
  });

  it('refuses a send with nobody on it', () => {
    expect(() => checkRecipientPolicy({ to: [], cc: [], maxRecipients: 10 })).toThrow();
  });

  it('enforces the ceiling on the real send path', async () => {
    await db.query(`update mail_policy set max_recipients = 2`);
    const t = await thread();
    await expect(send({ threadId: t.id, to: ['a@x.test', 'b@x.test', 'c@x.test'] }))
      .rejects.toThrow(SendRefused);
    expect(sent).toHaveLength(0);
  });
});

// ------------------------------------------------------------ M43 and M44

describe('approval for a new recipient — M43', () => {
  it('is required, and says exactly how much history is exposed', async () => {
    const t = await thread(alice, ['client@example.test']);
    await send({ threadId: t.id }); // one message of history

    await expect(send({ threadId: t.id, to: ['client@example.test', 'newcomer@example.test'] }))
      .rejects.toMatchObject({ reason: 'needs_approval' });

    const needed = approvalRequiredFor({
      attachments: [], newRecipients: ['newcomer@example.test'], historyMessageCount: 3,
    })!;
    expect(needed.action).toBe('add_recipient');
    expect(needed.summary).toContain('newcomer@example.test');
    expect(needed.summary).toMatch(/see all 3 earlier messages/);
  });

  it('says so plainly when there is no history to expose', () => {
    const needed = approvalRequiredFor({
      attachments: [], newRecipients: ['n@x.test'], historyMessageCount: 0,
    })!;
    expect(needed.summary).toMatch(/will not see any earlier messages/i);
  });

  it('goes through once approved for exactly that message', async () => {
    const t = await thread(alice, ['client@example.test']);
    const identity = {
      threadId: t.id, to: ['client@example.test', 'newcomer@example.test'], cc: [],
      subject: 'Thursday', body: 'Are you free Thursday?', attachments: [],
    };
    const approval = await requestApprovalForThread(t.id, 'add_recipient', identity);
    await decideApproval(db, { approvalId: approval, decidedBy: alice, approve: true });

    const result = await send({
      threadId: t.id, to: ['client@example.test', 'newcomer@example.test'], approvalId: approval,
    });
    expect(result.deduplicated).toBe(false);
    expect(sent[0].to).toContain('newcomer@example.test');
  });

  it('is refused when the approval covers a different message', async () => {
    // Approve "add newcomer", then change the body. The hash no longer matches.
    const t = await thread(alice, ['client@example.test']);
    const identity = {
      threadId: t.id, to: ['client@example.test', 'newcomer@example.test'], cc: [],
      subject: 'Thursday', body: 'Are you free Thursday?', attachments: [],
    };
    const approval = await requestApprovalForThread(t.id, 'add_recipient', identity);
    await decideApproval(db, { approvalId: approval, decidedBy: alice, approve: true });

    await expect(send({
      threadId: t.id, to: ['client@example.test', 'newcomer@example.test'],
      body: 'Actually, can you send me the contract?', approvalId: approval,
    })).rejects.toMatchObject({ reason: 'approval_mismatch' });
    expect(sent).toHaveLength(0);
  });

  it('is refused when the approval was never decided', async () => {
    const t = await thread(alice, ['client@example.test']);
    const identity = {
      threadId: t.id, to: ['client@example.test', 'newcomer@example.test'], cc: [],
      subject: 'Thursday', body: 'Are you free Thursday?', attachments: [],
    };
    const approval = await requestApprovalForThread(t.id, 'add_recipient', identity);
    await expect(send({
      threadId: t.id, to: ['client@example.test', 'newcomer@example.test'], approvalId: approval,
    })).rejects.toMatchObject({ reason: 'approval_mismatch' });
  });
});

describe('approval for an attachment — M44', () => {
  const file = {
    filename: 'contract.pdf', contentType: 'application/pdf',
    content: Buffer.from('pretend pdf'), sha256: 'abc123',
  };

  it('is required even when nothing else about the send would need one', async () => {
    const t = await thread(alice, ['client@example.test']);
    await expect(send({ threadId: t.id, attachments: [file] }))
      .rejects.toMatchObject({ reason: 'needs_approval' });
    expect(sent).toHaveLength(0);
  });

  it('takes precedence over a new recipient, and previews the exact file', () => {
    const needed = approvalRequiredFor({
      attachments: [file], newRecipients: ['n@x.test'], historyMessageCount: 2,
    })!;
    expect(needed.action).toBe('send_attachment');
    expect(needed.summary).toContain('contract.pdf');
    expect(needed.summary).toContain('11 bytes');
  });

  it('is still required when routine sending is automatic', async () => {
    // M44 in as many words: "even if routine email sending is otherwise allowed
    // automatically". The preference is never consulted for attachments.
    await db.query(
      `insert into user_approval_prefs (user_id, action_class, level) values ($1, 'email_send', 'automatic')`,
      [alice],
    );
    const t = await thread(alice, ['client@example.test']);
    await expect(send({ threadId: t.id, attachments: [file] }))
      .rejects.toMatchObject({ reason: 'needs_approval' });
  });

  it('goes through once approved, and records the file', async () => {
    const t = await thread(alice, ['client@example.test']);
    const identity = {
      threadId: t.id, to: ['client@example.test'], cc: [], subject: 'Thursday',
      body: 'Are you free Thursday?',
      attachments: [{ filename: file.filename, sha256: file.sha256 }],
    };
    const approval = await requestApprovalForThread(t.id, 'send_attachment', identity);
    await decideApproval(db, { approvalId: approval, decidedBy: alice, approve: true });

    await send({ threadId: t.id, attachments: [file], approvalId: approval });
    expect(sent[0].attachments[0].filename).toBe('contract.pdf');
    const [row] = await db.query<{ filename: string; byte_size: number }>(
      `select filename, byte_size from email_attachments`,
    );
    expect(row).toMatchObject({ filename: 'contract.pdf', byte_size: 11 });
  });

  it('is refused when a different file is swapped in after approval', async () => {
    const t = await thread(alice, ['client@example.test']);
    const identity = {
      threadId: t.id, to: ['client@example.test'], cc: [], subject: 'Thursday',
      body: 'Are you free Thursday?',
      attachments: [{ filename: file.filename, sha256: file.sha256 }],
    };
    const approval = await requestApprovalForThread(t.id, 'send_attachment', identity);
    await decideApproval(db, { approvalId: approval, decidedBy: alice, approve: true });

    await expect(send({
      threadId: t.id, approvalId: approval,
      attachments: [{ ...file, sha256: 'a-completely-different-file' }],
    })).rejects.toMatchObject({ reason: 'approval_mismatch' });
  });
});

/** Goes through `requestApproval`, deliberately.
 *
 * An earlier version inserted the row by hand with a pre-computed hash. That
 * bypassed the real request path and hid a bug where the payload was hashed
 * twice — the approval could never match, and only the wire test noticed. A
 * helper that builds its fixture differently from production is a helper that
 * tests something production does not do. */
async function requestApprovalForThread(
  threadId: string, action: string, identity: Parameters<typeof messagePayload>[0],
): Promise<string> {
  const approval = await requestApproval(db, {
    threadId, ownerUserId: alice, actionClass: 'email_send',
    action, summary: 'summary', payload: messagePayload(identity),
  });
  return approval.id;
}

// ------------------------------------------------------------- exactly once

describe('exactly once', () => {
  it('does not send the same message twice', async () => {
    const t = await thread();
    const first = await send({ threadId: t.id });
    const second = await send({ threadId: t.id });
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('treats a changed body as a different message', async () => {
    const t = await thread();
    await send({ threadId: t.id });
    await send({ threadId: t.id, body: 'Different question entirely.' });
    expect(sent).toHaveLength(2);
  });

  it('is not fooled by recipient ordering or case', () => {
    const base = {
      threadId: 't', cc: [], subject: 's', body: 'b', attachments: [],
    };
    expect(messageFingerprint({ ...base, to: ['a@x.test', 'b@x.test'] }))
      .toBe(messageFingerprint({ ...base, to: ['B@X.test', 'A@x.test'] }));
  });

  it('is enforced by the database, not only by the check', async () => {
    const t = await thread();
    await send({ threadId: t.id });
    await expect(db.query(
      `insert into email_messages (thread_id, direction, from_address, subject, body_text, content_hash)
       select thread_id, 'out', from_address, subject, body_text, content_hash from email_messages limit 1`,
    )).rejects.toThrow();
  });
});

describe('a failed send', () => {
  it('records a category, never the server text', async () => {
    const t = await thread();
    const err = new Error('550 5.1.1 <client@example.test>: Recipient address rejected: SECRET-QUOTED-BODY');
    (err as any).responseCode = 550;
    failNext = err;

    await expect(send({ threadId: t.id })).rejects.toThrow();

    const [row] = await db.query<{ status: string; error_category: string }>(
      `select status, error_category from email_sends limit 1`,
    );
    expect(row.status).toBe('failed');
    const events = JSON.stringify(await db.query(`select * from events`));
    expect(events).not.toContain('SECRET-QUOTED-BODY');
    expect(events).toContain('mail.send_failed');
  });

  it('classifies what an operator should do about it', () => {
    const with_ = (props: Record<string, unknown>) => classifySmtpError(Object.assign(new Error('x'), props));
    expect(with_({ code: 'EAUTH' })).toBe('auth');
    expect(with_({ code: 'ECONNREFUSED' })).toBe('connection');
    expect(with_({ responseCode: 550 })).toBe('rejected_recipient');
    expect(with_({ responseCode: 552 })).toBe('rejected_content');
    expect(with_({ responseCode: 421 })).toBe('rate_limited');
    expect(with_({})).toBe('unknown');
  });
});

describe('the capability gate', () => {
  it('refuses before anything else happens', async () => {
    const t = await thread();
    await expect(send({ threadId: t.id, capabilityAllowed: false }))
      .rejects.toMatchObject({ reason: 'capability_off' });
    expect(sent).toHaveLength(0);
    expect(await db.query(`select 1 from email_messages`)).toHaveLength(0);
  });
});

// --------------------------------------------------------------- inbound

describe('every inbound message resolves to a person or is quarantined', () => {
  const inbound = (over: Record<string, unknown> = {}) => ({
    deliveredTo: ['josi@example.test'],
    from: 'client@example.test',
    subject: 'Re: Thursday',
    bodyText: 'Thursday works.',
    messageId: '<reply-1@example.test>',
    inReplyTo: null,
    headers: {},
    ...over,
  });

  beforeEach(async () => {
    await db.query(`update mail_policy set inbound_enabled = true`);
  });

  it('delivers a reply to the thread that started it', async () => {
    const t = await thread();
    const result = await ingestInbound(db, inbound({
      deliveredTo: [replyAddressFor('josi@example.test', t.routing_token)],
    }));
    expect(result).toMatchObject({ kind: 'delivered', threadId: t.id, ownerUserId: alice });
  });

  it('finds the token even when it is not the first recipient', async () => {
    const t = await thread();
    const result = await ingestInbound(db, inbound({
      deliveredTo: ['someone@else.test', replyAddressFor('josi@example.test', t.routing_token)],
    }));
    expect(result.kind).toBe('delivered');
  });

  it('quarantines a message with no token rather than guessing an owner', async () => {
    await thread();
    // The From address matches a participant, which is exactly the "nearest
    // plausible thread" temptation. Anyone can put anything in From.
    const result = await ingestInbound(db, inbound({ from: 'client@example.test' }));
    expect(result).toEqual({ kind: 'quarantined', reason: 'no_routing_token' });
    expect(await db.query(`select 1 from email_messages`)).toHaveLength(0);
  });

  it('quarantines an unknown token', async () => {
    const result = await ingestInbound(db, inbound({
      deliveredTo: [replyAddressFor('josi@example.test', 'z'.repeat(32))],
    }));
    expect(result).toEqual({ kind: 'quarantined', reason: 'unknown_token' });
  });

  it('quarantines a reply to a thread in the trash', async () => {
    const t = await thread();
    await trashThread(db, { threadId: t.id, actorUserId: alice });
    const result = await ingestInbound(db, inbound({
      deliveredTo: [replyAddressFor('josi@example.test', t.routing_token)],
    }));
    expect(result).toEqual({ kind: 'quarantined', reason: 'thread_deleted' });
  });

  it('refuses everything when inbound is switched off', async () => {
    await db.query(`update mail_policy set inbound_enabled = false`);
    const t = await thread();
    const result = await ingestInbound(db, inbound({
      deliveredTo: [replyAddressFor('josi@example.test', t.routing_token)],
    }));
    expect(result).toEqual({ kind: 'quarantined', reason: 'inbound_disabled' });
  });

  it('keeps only headers in quarantine, never the body', async () => {
    await ingestInbound(db, inbound({
      subject: 'SECRET-SUBJECT-LINE', bodyText: 'SECRET-BODY-CONTENT',
    }));
    const dump = JSON.stringify(await db.query(`select * from email_quarantine`));
    expect(dump).not.toContain('SECRET-SUBJECT-LINE');
    expect(dump).not.toContain('SECRET-BODY-CONTENT');
    // Lengths, so an operator can see something arrived.
    expect(dump).toContain('"subject_length"');

    const summary = JSON.stringify(await quarantineSummary(db));
    expect(summary).not.toContain('SECRET-SUBJECT-LINE');
  });
});

describe('a reply loop terminates', () => {
  beforeEach(async () => { await db.query(`update mail_policy set inbound_enabled = true`); });

  it('recognises the headers automata already agree on', () => {
    expect(looksAutomated({ 'auto-submitted': 'auto-replied' })).toBe(true);
    expect(looksAutomated({ precedence: 'bulk' })).toBe(true);
    expect(looksAutomated({ 'list-unsubscribe': '<mailto:x@y.test>' })).toBe(true);
    expect(looksAutomated({ 'content-type': 'multipart/report; report-type=delivery-status' })).toBe(true);
    expect(looksAutomated({ from: 'MAILER-DAEMON@example.test' })).toBe(true);
    expect(looksAutomated({ 'auto-submitted': 'no' })).toBe(false);
    expect(looksAutomated({})).toBe(false);
  });

  it('does not auto-answer an automated reply', async () => {
    const t = await thread();
    const result = await ingestInbound(db, {
      deliveredTo: [replyAddressFor('josi@example.test', t.routing_token)],
      from: 'client@example.test', subject: 'Out of office', bodyText: 'I am away.',
      messageId: '<ooo@x.test>', inReplyTo: null,
      headers: { 'auto-submitted': 'auto-replied' },
    });
    expect(result).toMatchObject({ kind: 'delivered', autoRespond: false });
  });

  it('stops answering after the loop budget, even with no headers at all', async () => {
    // The backstop for a badly behaved automaton that sets nothing.
    const t = await thread();
    for (let i = 0; i < LOOP_MAX_AUTO_REPLIES; i++) {
      await send({ threadId: t.id, body: `message ${i}` });
    }
    const result = await ingestInbound(db, {
      deliveredTo: [replyAddressFor('josi@example.test', t.routing_token)],
      from: 'client@example.test', subject: 'Re', bodyText: 'and again',
      messageId: '<n@x.test>', inReplyTo: null, headers: {},
    });
    // Still delivered — a person can read it — but Josi stops adding fuel.
    expect(result).toMatchObject({ kind: 'delivered', autoRespond: false });
  });

  it('answers a normal reply', async () => {
    const t = await thread();
    await send({ threadId: t.id });
    const result = await ingestInbound(db, {
      deliveredTo: [replyAddressFor('josi@example.test', t.routing_token)],
      from: 'client@example.test', subject: 'Re: Thursday', bodyText: 'Yes.',
      messageId: '<r@x.test>', inReplyTo: null, headers: {},
    });
    expect(result).toMatchObject({ kind: 'delivered', autoRespond: true });
  });

  it('marks its own outbound so another Josi would not answer it', async () => {
    const t = await thread();
    await send({ threadId: t.id });
    expect(sent[0].headers['Auto-Submitted']).toBe('auto-generated');
    expect(sent[0].headers['X-Josi-Thread']).toBe(t.routing_token);
  });

  it('quarantines its own message coming back to it', async () => {
    const t = await thread();
    const result = await ingestInbound(db, {
      deliveredTo: [replyAddressFor('josi@example.test', t.routing_token)],
      from: 'josi@example.test', subject: 'Thursday', bodyText: 'loop',
      messageId: '<self@x.test>', inReplyTo: null,
      headers: { 'x-josi-thread': t.routing_token, 'auto-submitted': 'auto-generated' },
    });
    expect(result).toEqual({ kind: 'quarantined', reason: 'loop_suspected' });
  });
});

// --------------------------------------------------- M37, M39, M40 threads

describe('threads belong to their initiator', () => {
  it('do not appear in anyone else list', async () => {
    await thread(alice);
    expect(await listThreadsFor(db, { ownerUserId: alice })).toHaveLength(1);
    expect(await listThreadsFor(db, { ownerUserId: bob })).toHaveLength(0);
  });

  it('keep the subject out of the audit log', async () => {
    await createThread(db, { ownerUserId: alice, subject: 'PRIVATE-SUBJECT-LINE' });
    const events = JSON.stringify(await db.query(`select * from events`));
    expect(events).not.toContain('PRIVATE-SUBJECT-LINE');
  });
});

describe('trash and retention', () => {
  it('puts a deleted thread in recoverable trash', async () => {
    const t = await thread();
    const { recoverableUntil } = await trashThread(db, { threadId: t.id, actorUserId: alice });
    expect(recoverableUntil).toBeTruthy();
    expect(await listThreadsFor(db, { ownerUserId: alice })).toHaveLength(0);
    expect(await listThreadsFor(db, { ownerUserId: alice, includeTrashed: true })).toHaveLength(1);

    expect(await restoreThread(db, { threadId: t.id, actorUserId: alice })).toBe(true);
    expect(await listThreadsFor(db, { ownerUserId: alice })).toHaveLength(1);
  });

  it('deletes immediately when the admin configured no trash', async () => {
    await db.query(`update mail_policy set trash_days = 0`);
    const t = await thread();
    const { recoverableUntil } = await trashThread(db, { threadId: t.id, actorUserId: alice });
    expect(recoverableUntil).toBeNull();
    expect(await db.query(`select 1 from email_threads`)).toHaveLength(0);
  });

  it('empties trash when its time is up, and not before', async () => {
    const t = await thread();
    await trashThread(db, { threadId: t.id, actorUserId: alice });
    expect((await runRetention(db)).purged).toBe(0);

    await db.query(`update email_threads set purge_after = now() - interval '1 day'`);
    expect((await runRetention(db)).purged).toBe(1);
    expect(await db.query(`select 1 from email_threads`)).toHaveLength(0);
  });

  it('keeps threads forever when no retention maximum is set', async () => {
    const t = await thread();
    await db.query(`update email_threads set last_activity_at = now() - interval '10 years'`);
    expect((await runRetention(db)).expired).toBe(0);
    expect(await db.query(`select 1 from email_threads where id = $1`, [t.id])).toHaveLength(1);
  });

  it('applies an admin retention maximum', async () => {
    await db.query(`update mail_policy set retention_days = 30`);
    await thread();
    await db.query(`update email_threads set last_activity_at = now() - interval '60 days'`);
    expect((await runRetention(db)).expired).toBe(1);
  });

  it('warns the owner before anything is deleted', async () => {
    // M39: affected people must be shown the policy and warned first.
    await db.query(`update mail_policy set retention_days = 30`);
    await thread();
    await db.query(`update email_threads set last_activity_at = now() - interval '60 days'`);
    const notice = await retentionNotice(db, alice);
    expect(notice).toMatchObject({ retentionDays: 30, affected: 1 });
    expect(notice.earliest).toBeTruthy();
  });

  it('says there is nothing to warn about when retention is off', async () => {
    await thread();
    expect(await retentionNotice(db, alice)).toMatchObject({ retentionDays: null, affected: 0 });
  });
});

describe('the policy row', () => {
  it('has sensible defaults', async () => {
    const policy = await mailPolicy(db);
    expect(policy).toMatchObject({ retention_days: null, trash_days: 30, inbound_enabled: false });
    expect(policy.max_recipients).toBeGreaterThan(0);
  });

  it('refuses a nonsensical recipient ceiling', async () => {
    await expect(db.query(`update mail_policy set max_recipients = 0`)).rejects.toThrow();
    await expect(db.query(`update mail_policy set max_recipients = 5000`)).rejects.toThrow();
  });
});
