// Threads and messages.
//
// A thread is one person's running conversation with Josi. The engine kept
// these per tenant and wrote the full text of every exchange into the event
// log; CE does neither.
//
// The event log here records that an exchange happened and how long it was.
// The words live in `messages`, behind the thread's ownership, where a share
// decides who may read them. Copying them into `events` would put private
// conversation into the one table the super admin is expected to read — and
// `appendEvent` refuses payload keys like `body` and `message` precisely so
// that mistake fails loudly instead of shipping.
import { json, type Db } from './db.js';
import { appendEvent } from './events.js';

export interface Thread {
  id: string;
  owner_user_id: string;
  contact_id: string | null;
  title: string | null;
  status: 'open' | 'closed';
  last_activity_at: string;
  created_at: string;
}

export interface Message {
  id: string;
  thread_id: string;
  direction: 'in' | 'out';
  channel: string;
  body: string;
  meta: Record<string, unknown>;
  created_at: string;
}

export async function createThread(
  db: Db,
  args: { ownerUserId: string; title?: string | null; contactId?: string | null },
): Promise<Thread> {
  const rows = await db.query<Thread>(
    `insert into threads (owner_user_id, title, contact_id) values ($1, $2, $3) returning *`,
    [args.ownerUserId, args.title ?? null, args.contactId ?? null],
  );
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'thread.created',
    subjectType: 'thread',
    subjectId: rows[0].id,
  });
  return rows[0];
}

export async function getThread(db: Db, threadId: string): Promise<Thread | null> {
  const rows = await db.query<Thread>(`select * from threads where id = $1`, [threadId]);
  return rows[0] ?? null;
}

export async function listThreadsFor(
  db: Db,
  args: { ownerUserId: string; limit?: number },
): Promise<Thread[]> {
  return db.query<Thread>(
    `select * from threads where owner_user_id = $1 order by last_activity_at desc limit $2`,
    [args.ownerUserId, Math.min(200, args.limit ?? 50)],
  );
}

/** Messages in a thread, oldest first. Callers must have resolved access to the
 * THREAD first — there is no per-message check, by design, so a share cannot be
 * half-applied. */
export async function listMessages(
  db: Db,
  args: { threadId: string; limit?: number },
): Promise<Message[]> {
  return db.query<Message>(
    `select * from messages where thread_id = $1 order by created_at limit $2`,
    [args.threadId, Math.min(500, args.limit ?? 200)],
  );
}

export async function addMessage(
  db: Db,
  args: {
    threadId: string;
    direction: 'in' | 'out';
    body: string;
    channel?: string;
    meta?: Record<string, unknown>;
  },
): Promise<Message> {
  // Only the immediately preceding assistant turn may receive a bare yes/no.
  // Clear presentation bindings before every new outbound message; the caller
  // that is actually presenting a prepared action re-binds its task after the
  // message is inserted. This is deterministic even when database timestamps
  // have the same resolution.
  if(args.direction==='out')await db.query(`update assistant_action_states set presented_turn_id=null
    where thread_id=$1 and status='prepared' and presented_turn_id is not null`,[args.threadId]);
  // `created_at` is also the conversation-order key. Database clocks can give
  // several fast messages the same timestamp, and random UUIDs are not a safe
  // tie-breaker for "immediately preceding" semantics. Updating the thread row
  // first serializes concurrent writers and gives every message a monotonic
  // per-thread timestamp.
  const rows = await db.query<Message>(
    `with activity as (
       update threads
          set last_activity_at = greatest(now(), last_activity_at + interval '1 microsecond')
        where id = $1
        returning last_activity_at
     )
     insert into messages (thread_id, direction, channel, body, meta, created_at)
     select $1, $2, $3, $4, $5, last_activity_at from activity
     returning *`,
    [args.threadId, args.direction, args.channel ?? 'web', args.body, json(args.meta)],
  );
  if (rows[0]) return rows[0];
  // Preserve the database's ordinary foreign-key refusal for a missing thread.
  const missingThread = await db.query<Message>(
    `insert into messages (thread_id, direction, channel, body, meta)
     values ($1, $2, $3, $4, $5) returning *`,
    [args.threadId, args.direction, args.channel ?? 'web', args.body, json(args.meta)],
  );
  return missingThread[0];
}

/** Record one full exchange. Lengths, not words: enough to see that a
 * conversation is happening and roughly how big it is, without the audit trail
 * becoming a transcript. */
export async function recordExchange(
  db: Db,
  args: {
    ownerUserId: string;
    threadId: string;
    channel?: string;
    inbound: string;
    reply: string;
    inboundMeta?: Record<string, unknown>;
    outboundMeta?: Record<string, unknown>;
  },
): Promise<{ inbound: Message; outbound: Message }> {
  const inbound = await addMessage(db, { threadId: args.threadId, direction: 'in', body: args.inbound, channel: args.channel, meta: args.inboundMeta });
  const outbound = await addMessage(db, { threadId: args.threadId, direction: 'out', body: args.reply, channel: args.channel, meta: args.outboundMeta });
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'thread.exchange',
    subjectType: 'thread',
    subjectId: args.threadId,
    payload: {
      channel: args.channel ?? 'web',
      inboundChars: args.inbound.length,
      replyChars: args.reply.length,
    },
  });
  return { inbound, outbound };
}

// ---------- contacts ----------

export interface Contact {
  id: string;
  owner_user_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  notes: Record<string, unknown>;
  created_at: string;
}

export async function createContact(
  db: Db,
  args: { ownerUserId: string; name?: string | null; phone?: string | null; email?: string | null },
): Promise<Contact> {
  const rows = await db.query<Contact>(
    `insert into contacts (owner_user_id, name, phone, email) values ($1, $2, $3, $4) returning *`,
    [args.ownerUserId, args.name ?? null, args.phone ?? null, args.email ?? null],
  );
  // A contact's name, number and address are all content. The log gets the fact
  // that one was created and nothing that identifies who.
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'contact.created',
    subjectType: 'contact',
    subjectId: rows[0].id,
  });
  return rows[0];
}

export async function listContactsFor(
  db: Db,
  args: { ownerUserId: string; limit?: number },
): Promise<Contact[]> {
  return db.query<Contact>(
    `select * from contacts where owner_user_id = $1 order by created_at desc limit $2`,
    [args.ownerUserId, Math.min(500, args.limit ?? 100)],
  );
}
