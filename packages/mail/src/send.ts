// Sending operational mail.
//
// Everything that decides whether a message may go out is in this file, in one
// order, so there is one place to read and one place to attack:
//
//   1. Is the capability on for this person at all?
//   2. Is this operational mail, or is it a mailing list wearing a hat? (M42)
//   3. Does it need approval, and is there one that pins EXACTLY this? (M43/M44)
//   4. Has this already been sent? (exactly-once)
//   5. Only then: hand it to SMTP.
//
// The order is not cosmetic. Checking approval before the recipient policy
// would mean asking someone to approve a send that was never allowed; checking
// exactly-once before approval would let a duplicate slip past the gate.
import { randomBytes } from 'node:crypto';
import { appendEvent, approvalHash, type Db } from '@josi-ce/core';
import {
  applyDisclosure, assertSafeAddress, encodeDisplayName, messageFingerprint, messagePayload,
  operationalSender, replyAddressFor,
} from './identity.js';

export type SendErrorCategory =
  | 'auth' | 'connection' | 'rejected_recipient' | 'rejected_content' | 'rate_limited' | 'unknown';

export class MailError extends Error {
  category: SendErrorCategory = 'unknown';
  constructor(message: string, category?: SendErrorCategory) {
    super(message);
    if (category) this.category = category;
  }
}

/** Why a send was refused before it reached SMTP. Distinct from MailError so a
 * caller cannot confuse "we would not" with "the server would not". */
export class SendRefused extends Error {
  constructor(
    readonly reason:
      | 'capability_off' | 'too_many_recipients' | 'bcc_not_permitted'
      | 'needs_approval' | 'approval_mismatch' | 'thread_deleted' | 'loop_guard',
    message: string,
    /** Set when the caller should raise an approval and try again. */
    readonly approvalId?: string,
  ) {
    super(message);
  }
}

export interface Attachment {
  filename: string;
  contentType: string;
  content: Buffer;
  sha256: string;
}

export interface SmtpTransport {
  send(message: {
    from: string;
    replyTo: string;
    to: string[];
    cc: string[];
    subject: string;
    text: string;
    headers: Record<string, string>;
    attachments: Array<{ filename: string; contentType: string; content: Buffer }>;
  }): Promise<{ messageId: string }>;
}

export interface MailPolicy {
  retention_days: number | null;
  trash_days: number;
  disclosure: string;
  inbound_enabled: boolean;
  max_recipients: number;
}

export async function mailPolicy(db: Db): Promise<MailPolicy> {
  const [row] = await db.query<MailPolicy>(
    `select retention_days, trash_days, disclosure, inbound_enabled, max_recipients
     from mail_policy where id = true`,
  );
  return row;
}

export function newRoutingToken(): string {
  return randomBytes(24).toString('base64url'); // 32 chars, matches the address grammar
}

// ------------------------------------------------------------------ M42

/** Operational mail reaches the people in a conversation. It does not reach a
 * list.
 *
 * The map is explicit that this is an intent boundary rather than a
 * one-recipient rule: group scheduling and CC'd participants are fine. What is
 * not fine is BCC, because BCC to many people is the shape of a mailing list
 * and there is no legitimate operational use for hiding participants from each
 * other in a thread Josi is coordinating. */
export function checkRecipientPolicy(args: {
  to: string[];
  cc: string[];
  bcc?: string[];
  maxRecipients: number;
}): void {
  if (args.bcc?.length) {
    throw new SendRefused(
      'bcc_not_permitted',
      'Josi does not send blind copies. Everyone in an operational thread can see who else is on it.',
    );
  }
  const total = args.to.length + args.cc.length;
  if (total === 0) throw new SendRefused('too_many_recipients', 'there is nobody to send this to');
  if (total > args.maxRecipients) {
    throw new SendRefused(
      'too_many_recipients',
      `This is addressed to ${total} people, and this installation's limit for one operational message is `
      + `${args.maxRecipients}. Josi coordinates conversations; it is not for announcements or outreach.`,
    );
  }
}

// ------------------------------------------------------------ M43 and M44

export interface PendingApproval {
  id: string;
  action: string;
  summary: string;
  payload: unknown;
}

/** What this send needs the initiator to agree to before it happens.
 *
 * Returns null when nothing extra is required. Note what is NOT consulted here:
 * the person's routine-automatic preference. M44 says an attachment always
 * requires approval "even when routine email sending is otherwise allowed
 * automatically", and M43 says the same for a new recipient — so these two are
 * decided before any preference is read. */
export function approvalRequiredFor(args: {
  attachments: Attachment[];
  newRecipients: string[];
  historyMessageCount: number;
}): { action: string; summary: string } | null {
  if (args.attachments.length) {
    const names = args.attachments.map((a) => `${a.filename} (${describeSize(a.content.length)})`);
    return {
      action: 'send_attachment',
      summary: `Send ${args.attachments.length === 1 ? 'the file' : 'the files'} ${names.join(', ')}.`,
    };
  }
  if (args.newRecipients.length) {
    // M43: name the newcomer and say exactly how much they will see.
    const history = args.historyMessageCount === 0
      ? 'They will not see any earlier messages.'
      : `They will be able to see all ${args.historyMessageCount} earlier `
        + `${args.historyMessageCount === 1 ? 'message' : 'messages'} in this conversation.`;
    return {
      action: 'add_recipient',
      summary: `Add ${args.newRecipients.join(', ')} to this conversation. ${history}`,
    };
  }
  return null;
}

function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- sending

export interface SendArgs {
  db: Db;
  transport: SmtpTransport;
  threadId: string;
  /** The person this is sent on behalf of. Their name is in the From. */
  initiator: { id: string; name: string };
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachments?: Attachment[];
  /** An approval that already covers exactly this. */
  approvalId?: string;
  /** The installation's sending identity. */
  profile: { fromAddress: string; fromName: string };
  /** Checked before anything else; supplied by the caller so this file does not
   * reach into the connector package. */
  capabilityAllowed: boolean;
}

export interface SendResult {
  messageId: string;
  /** True when this exact message had already gone out and was not sent twice. */
  deduplicated: boolean;
}

export async function sendOperationalEmail(args: SendArgs): Promise<SendResult> {
  const { db } = args;
  const to = args.to.map(assertSafeAddress);
  const cc = (args.cc ?? []).map(assertSafeAddress);
  const attachments = args.attachments ?? [];

  // 1. May this person send at all?
  if (!args.capabilityAllowed) {
    throw new SendRefused('capability_off', 'Sending email is not switched on for this account.');
  }

  const [thread] = await db.query<{
    id: string; owner_user_id: string; subject: string; routing_token: string; deleted_at: string | null;
  }>(`select id, owner_user_id, subject, routing_token, deleted_at from email_threads where id = $1`,
    [args.threadId]);
  if (!thread) throw new SendRefused('thread_deleted', 'that conversation no longer exists');
  if (thread.deleted_at) {
    throw new SendRefused('thread_deleted', 'that conversation is in the trash; restore it first');
  }

  const policy = await mailPolicy(db);

  // 2. Operational, not a mailing list.
  checkRecipientPolicy({ to, cc, bcc: args.bcc, maxRecipients: policy.max_recipients });

  // 3. Approval, for the things that always need one.
  const existing = await db.query<{ address: string }>(
    `select address from email_participants where thread_id = $1`, [args.threadId],
  );
  const known = new Set(existing.map((p) => p.address.toLowerCase()));
  const newRecipients = [...to, ...cc].filter((a) => !known.has(a.toLowerCase()));
  const [{ count: historyCount }] = await db.query<{ count: string }>(
    `select count(*)::text as count from email_messages where thread_id = $1`, [args.threadId],
  );

  const needed = approvalRequiredFor({
    attachments,
    newRecipients,
    historyMessageCount: Number(historyCount),
  });

  const identity = {
    threadId: args.threadId, to, cc,
    subject: args.subject, body: args.body,
    attachments: attachments.map((a) => ({ filename: a.filename, sha256: a.sha256 })),
  };
  const fingerprint = messageFingerprint(identity);
  // What an approval for this message would have stored. `requestApproval`
  // hashes its payload, so the comparison has to hash the same way — computing
  // it here, from the same canonical form, is what keeps the two in step.
  const approvedHash = approvalHash(messagePayload(identity));

  if (needed) {
    if (!args.approvalId) {
      throw new SendRefused('needs_approval', needed.summary);
    }
    const [approval] = await db.query<{
      id: string; status: string; action: string; payload_hash: string; owner_user_id: string;
    }>(`select id, status, action, payload_hash, owner_user_id from approvals where id = $1`,
      [args.approvalId]);

    // Every one of these is a way the gate could be walked around, so each is
    // its own condition rather than a single truthiness check.
    const valid = approval
      && approval.status === 'approved'
      && approval.action === needed.action
      && approval.owner_user_id === thread.owner_user_id
      && approval.payload_hash === approvedHash;
    if (!valid) {
      throw new SendRefused(
        'approval_mismatch',
        'that approval does not cover this exact message — ask again with what will actually be sent',
      );
    }
  }

  // 4. Exactly once. The unique index is the real guarantee; this is the
  //    friendly path that returns the original instead of raising.
  const [already] = await db.query<{ id: string; message_id: string | null }>(
    `select id, message_id from email_messages
     where thread_id = $1 and content_hash = $2 and direction = 'out'`,
    [args.threadId, fingerprint],
  );
  if (already) {
    return { messageId: already.message_id ?? already.id, deduplicated: true };
  }

  // 5. Send.
  const replyTo = replyAddressFor(args.profile.fromAddress, thread.routing_token);
  const sender = operationalSender({
    personName: args.initiator.name,
    profileFromName: args.profile.fromName,
    profileFromAddress: args.profile.fromAddress,
    replyToAddress: replyTo,
  });
  const body = applyDisclosure({
    body: args.body, disclosure: policy.disclosure, personName: args.initiator.name,
  });

  const [row] = await db.query<{ id: string }>(
    `insert into email_messages
       (thread_id, direction, from_address, to_addresses, cc_addresses, subject, body_text, content_hash)
     values ($1, 'out', $2, $3, $4, $5, $6, $7) returning id`,
    [args.threadId, sender.fromAddress, to, cc, args.subject, body, fingerprint],
  );

  for (const attachment of attachments) {
    await db.query(
      `insert into email_attachments (message_id, filename, content_type, byte_size, sha256)
       values ($1, $2, $3, $4, $5)`,
      [row.id, attachment.filename, attachment.contentType, attachment.content.length, attachment.sha256],
    );
  }

  const idempotencyKey = `${args.threadId}:${fingerprint}`;
  for (const recipient of [...to, ...cc]) {
    await db.query(
      `insert into email_sends (message_id, initiating_user_id, recipient, idempotency_key)
       values ($1, $2, $3, $4) on conflict (idempotency_key) do nothing`,
      [row.id, args.initiator.id, recipient, `${idempotencyKey}:${recipient}`],
    );
  }

  let messageId: string;
  try {
    const sent = await args.transport.send({
      from: `${encodeDisplayName(sender.fromName)} <${sender.fromAddress}>`,
      replyTo: sender.replyTo,
      to, cc,
      subject: args.subject,
      text: body,
      headers: {
        // Loop prevention, in the form other mail systems already understand.
        // A well-behaved autoresponder will not answer these.
        'Auto-Submitted': 'auto-generated',
        Precedence: 'auto_reply',
        // Ours, for the inbound side to recognise its own output.
        'X-Josi-Thread': thread.routing_token,
      },
      attachments: attachments.map((a) => ({
        filename: a.filename, contentType: a.contentType, content: a.content,
      })),
    });
    messageId = sent.messageId;
  } catch (err) {
    const category = err instanceof MailError ? err.category : 'unknown';
    await db.query(
      `update email_sends set status = 'failed', attempts = attempts + 1, error_category = $2
       where message_id = $1`,
      [row.id, category],
    );
    await appendEvent(db, {
      actorUserId: args.initiator.id,
      actor: 'system',
      kind: 'mail.send_failed',
      subjectType: 'email_thread',
      subjectId: args.threadId,
      // A category. Never the SMTP response, which quotes the message.
      payload: { category, recipients: to.length + cc.length },
    });
    throw err;
  }

  await db.query(`update email_messages set message_id = $2 where id = $1`, [row.id, messageId]);
  await db.query(
    `update email_sends set status = 'sent', sent_at = now(), attempts = attempts + 1 where message_id = $1`,
    [row.id],
  );
  await db.query(`update email_threads set last_activity_at = now() where id = $1`, [args.threadId]);

  // New participants join from now on, unless an approval said otherwise.
  for (const address of newRecipients) {
    await db.query(
      `insert into email_participants (thread_id, address, added_by) values ($1, $2, $3)
       on conflict (thread_id, address) do nothing`,
      [args.threadId, address.toLowerCase(), args.initiator.id],
    );
  }

  await appendEvent(db, {
    actorUserId: args.initiator.id,
    actor: 'user',
    kind: 'mail.sent',
    subjectType: 'email_thread',
    subjectId: args.threadId,
    // Counts, never addresses and never the subject.
    payload: { recipients: to.length + cc.length, attachments: attachments.length },
  });

  return { messageId, deduplicated: false };
}
