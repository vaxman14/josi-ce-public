// Where a reply goes.
//
// THE RISK THIS FILE EXISTS TO ANSWER, in the phase plan's own words: "an
// unowned shared inbox forming → every inbound message resolves to an
// initiating user or is quarantined."
//
// There are exactly two outcomes below and no third. A message either resolves
// to a thread — which always has an owner — or it is quarantined with a reason.
// There is deliberately no "unassigned" state, no nearest-match, and no
// fallback to the administrator: each of those is how a pile of correspondence
// belonging to nobody starts.
//
// Quarantine keeps HEADERS ONLY. The body of a message we could not attribute
// belongs to no one, so storing it would create the very thing this is
// preventing.
import { appendEvent, type Db } from '@josi-ce/core';
import { routingTokenFrom } from './identity.js';

export interface InboundMessage {
  /** Every address the message was delivered to, so a token in Cc is found. */
  deliveredTo: string[];
  from: string;
  subject: string;
  bodyText: string;
  messageId: string | null;
  inReplyTo: string | null;
  /** Lower-cased header names to values. */
  headers: Record<string, string>;
}

export type QuarantineReason =
  | 'no_routing_token' | 'unknown_token' | 'thread_deleted' | 'loop_suspected' | 'inbound_disabled';

export type InboundOutcome =
  | { kind: 'delivered'; threadId: string; ownerUserId: string; messageId: string; autoRespond: boolean }
  | { kind: 'quarantined'; reason: QuarantineReason };

/** How many outbound messages Josi will put on one thread in the loop window
 * before it stops answering automatically.
 *
 * Two systems replying to each other is the classic mail loop, and header
 * conventions only stop the well-behaved ones. This is the backstop for the
 * others: the thread stays open and a person can still write on it, but Josi
 * stops adding fuel. */
export const LOOP_WINDOW_MINUTES = 10;
export const LOOP_MAX_AUTO_REPLIES = 5;

/** Does this message look like it came from an automaton?
 *
 * The headers below are the ones the mail world already agreed on. Recognising
 * them is what stops a bounce, an out-of-office, or another assistant from
 * starting a conversation neither side is having. */
export function looksAutomated(headers: Record<string, string>): boolean {
  const get = (name: string) => (headers[name.toLowerCase()] ?? '').toLowerCase();
  const autoSubmitted = get('auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (['bulk', 'junk', 'list', 'auto_reply'].includes(get('precedence'))) return true;
  if (get('x-auto-response-suppress')) return true;
  if (get('list-id') || get('list-unsubscribe')) return true;
  // A bounce. Answering one is the fastest way to build a loop.
  if (get('content-type').includes('multipart/report')) return true;
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(get('from'))) return true;
  return false;
}

export async function ingestInbound(db: Db, message: InboundMessage): Promise<InboundOutcome> {
  const [policy] = await db.query<{ inbound_enabled: boolean }>(
    `select inbound_enabled from mail_policy where id = true`,
  );
  if (!policy?.inbound_enabled) {
    // M36: the setting governs whether inbound is available at all. Off means
    // nothing is read, not that it is read and discarded.
    return quarantine(db, message, 'inbound_disabled');
  }

  // The token is the ONLY thing that attributes a message. Not the From
  // address — anyone can put anything there — and not the subject.
  let token: string | null = null;
  for (const address of message.deliveredTo) {
    token = routingTokenFrom(address);
    if (token) break;
  }
  if (!token) return quarantine(db, message, 'no_routing_token');

  const [thread] = await db.query<{ id: string; owner_user_id: string; deleted_at: string | null }>(
    `select id, owner_user_id, deleted_at from email_threads where routing_token = $1`,
    [token],
  );
  if (!thread) return quarantine(db, message, 'unknown_token');
  if (thread.deleted_at) return quarantine(db, message, 'thread_deleted');

  // Our own message coming back to us. Storing it would duplicate the thread
  // and answering it would be talking to ourselves.
  if ((message.headers['x-josi-thread'] ?? '') === token && looksAutomated(message.headers)) {
    return quarantine(db, message, 'loop_suspected');
  }

  const [row] = await db.query<{ id: string }>(
    `insert into email_messages
       (thread_id, direction, from_address, to_addresses, subject, body_text, message_id, in_reply_to)
     values ($1, 'in', $2, $3, $4, $5, $6, $7) returning id`,
    [
      thread.id, message.from, message.deliveredTo,
      message.subject, message.bodyText, message.messageId, message.inReplyTo,
    ],
  );
  await db.query(`update email_threads set last_activity_at = now() where id = $1`, [thread.id]);

  const autoRespond = await mayAutoRespond(db, { threadId: thread.id, headers: message.headers });

  await appendEvent(db, {
    actorUserId: thread.owner_user_id,
    actor: 'system',
    kind: 'mail.received',
    subjectType: 'email_thread',
    subjectId: thread.id,
    // That one arrived, and whether Josi will answer. Not who from, not what
    // about — the audit log is read by an administrator.
    payload: { autoRespond, automated: looksAutomated(message.headers) },
  });

  return {
    kind: 'delivered',
    threadId: thread.id,
    ownerUserId: thread.owner_user_id,
    messageId: row.id,
    autoRespond,
  };
}

/** Should Josi answer this by itself?
 *
 * Two independent brakes, because they fail differently. The header check stops
 * well-behaved automata immediately; the rate check stops everything else
 * eventually, including a badly-behaved one that sets no headers at all. */
export async function mayAutoRespond(
  db: Db,
  args: { threadId: string; headers: Record<string, string> },
): Promise<boolean> {
  if (looksAutomated(args.headers)) return false;

  const [{ count }] = await db.query<{ count: string }>(
    `select count(*)::text as count from email_messages
     where thread_id = $1 and direction = 'out'
       and created_at > now() - make_interval(mins => $2)`,
    [args.threadId, LOOP_WINDOW_MINUTES],
  );
  return Number(count) < LOOP_MAX_AUTO_REPLIES;
}

async function quarantine(
  db: Db,
  message: InboundMessage,
  reason: QuarantineReason,
): Promise<InboundOutcome> {
  await db.query(
    `insert into email_quarantine
       (from_address, to_address, reason, message_id, subject_length, body_length)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      message.from.slice(0, 320),
      message.deliveredTo[0]?.slice(0, 320) ?? null,
      reason,
      message.messageId,
      // Lengths, so an operator can see something arrived and roughly how big
      // it was. Not the subject and not the body.
      message.subject.length,
      message.bodyText.length,
    ],
  );
  await appendEvent(db, {
    actor: 'system',
    kind: 'mail.quarantined',
    payload: { reason },
  });
  return { kind: 'quarantined', reason };
}

/** What an administrator may see about quarantine: that messages arrived and
 * why they could not be attributed. Never their contents. */
export async function quarantineSummary(
  db: Db,
  limit = 50,
): Promise<Array<{ received_at: string; reason: string; from_address: string | null }>> {
  return db.query(
    `select received_at, reason, from_address from email_quarantine
     order by received_at desc limit $1`,
    [Math.min(200, limit)],
  );
}
