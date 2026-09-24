// Reminders: private content in the reminder row, timing/revision only in jobs.
import { enqueue } from './queue.js';
import { appendEvent } from './events.js';
import type { Db } from './db.js';

export const REMINDER_JOB_KIND = 'reminder.deliver';
export const MAX_REMINDER_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

/** Content-free reminder intent for status/calendar export only. Server push
 * remains authoritative; this contract does not transfer delivery ownership. */
export interface NativeReminderAction {
  version: 1;
  id: string;
  threadId: string;
  revision: number;
  operation: 'upsert' | 'cancel';
  at?: string;
  timezone?: string;
}

export interface Reminder {
  id: string;
  owner_user_id: string;
  thread_id: string | null;
  body: string;
  due_at: string;
  timezone: string;
  revision: number;
  status: 'scheduled' | 'delivered' | 'cancelled' | 'failed';
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

export class ReminderError extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizedDue(dueAt: Date): Date {
  return new Date(Math.floor(dueAt.getTime() / 1000) * 1000);
}

function validateDue(dueAt: Date): Date {
  const due = normalizedDue(dueAt);
  const ahead = due.getTime() - Date.now();
  if (!Number.isFinite(ahead)) throw new ReminderError('that is not a time Josi can schedule');
  if (ahead <= 0) throw new ReminderError('that time has already passed');
  if (ahead > MAX_REMINDER_AHEAD_MS) throw new ReminderError('that is more than a year away — ask again nearer the time');
  return due;
}

export function validateReminderTimezone(timezone: string): string {
  const value = timezone.trim();
  if (!value || value.length > 100) throw new ReminderError('choose a valid IANA timezone');
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0)); }
  catch { throw new ReminderError('choose a valid IANA timezone'); }
  return value;
}

/** Format an absolute instant with the offset and local clock for its IANA zone.
 * The native v1 validator intentionally requires both to agree, including DST
 * folds/gaps, rather than accepting a UTC instant plus an unrelated zone. */
export function reminderInstant(dueAt: Date | string, timezone: string): string {
  const zone = validateReminderTimezone(timezone);
  const instant = normalizedDue(dueAt instanceof Date ? dueAt : new Date(dueAt));
  if (!Number.isFinite(instant.getTime())) throw new ReminderError('that is not a time Josi can schedule');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
  const rawOffset = part('timeZoneName' as Intl.DateTimeFormatPartTypes);
  const offset = rawOffset === 'GMT' || rawOffset === 'UTC' ? 'Z'
    : /^GMT[+-]\d{2}:\d{2}$/.test(rawOffset) ? rawOffset.slice(3)
    : (() => { throw new ReminderError('choose a timezone with a supported UTC offset'); })();
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset}`;
}

export function nativeReminderAction(reminder: Reminder): NativeReminderAction | null {
  if (!reminder.thread_id || !Number.isSafeInteger(Number(reminder.revision))) return null;
  if (reminder.status === 'cancelled') {
    return { version: 1, id: reminder.id, threadId: reminder.thread_id, revision: Number(reminder.revision), operation: 'cancel' };
  }
  if (reminder.status !== 'scheduled') return null;
  return {
    version: 1, id: reminder.id, threadId: reminder.thread_id, revision: Number(reminder.revision), operation: 'upsert',
    at: reminderInstant(reminder.due_at, reminder.timezone), timezone: reminder.timezone,
  };
}

async function transaction<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new Error('reminder mutation requires transaction support');
  return db.transaction(work);
}

export async function reminderTimezoneFor(db: Db, ownerUserId: string, requested?: string | null): Promise<string> {
  if (requested?.trim()) return validateReminderTimezone(requested);
  const [device] = await db.query<{ timezone: string }>(
    `select timezone from mobile_devices where owner_user_id=$1 and revoked_at is null order by last_seen_at desc limit 1`,
    [ownerUserId],
  );
  return validateReminderTimezone(device?.timezone ?? 'UTC');
}

export async function createReminder(
  db: Db,
  args: { ownerUserId: string; threadId?: string | null; body: string; dueAt: Date; timezone?: string },
): Promise<Reminder> {
  const body = args.body.trim();
  if (!body) throw new ReminderError('a reminder needs something to say');
  if (body.length > 2000) throw new ReminderError('that reminder is too long to store — keep it under 2000 characters');
  const due = validateDue(args.dueAt);
  const timezone = validateReminderTimezone(args.timezone ?? 'UTC');
  if (args.threadId && !uuid.test(args.threadId)) throw new ReminderError('a reminder needs a valid conversation');
  return transaction(db, async tx => {
    const [row] = await tx.query<Reminder>(
      `insert into reminders (owner_user_id,thread_id,body,due_at,timezone)
       values ($1,$2::uuid,$3,$4,$5) returning *`,
      [args.ownerUserId, args.threadId ?? null, body, due.toISOString(), timezone],
    );
    await enqueue(tx, { kind: REMINDER_JOB_KIND, payload: { reminderId: row.id, revision: Number(row.revision) }, runAt: due });
    await appendEvent(tx, { actorUserId: args.ownerUserId, actor: 'user', kind: 'reminder.created', subjectType: 'reminder', subjectId: row.id,
      payload: { dueAt: row.due_at, timezone, revision: Number(row.revision), bodyChars: body.length } });
    return row;
  });
}

export async function updateReminder(
  db: Db,
  args: { ownerUserId: string; reminderId: string; body?: string; dueAt?: Date; timezone?: string },
): Promise<Reminder | null> {
  if (!uuid.test(args.reminderId)) return null;
  if (args.body === undefined && args.dueAt === undefined && args.timezone === undefined) {
    throw new ReminderError('choose what to change about the reminder');
  }
  const body = args.body === undefined ? null : args.body.trim();
  if (body !== null && !body) throw new ReminderError('a reminder needs something to say');
  if (body !== null && body.length > 2000) throw new ReminderError('that reminder is too long to store — keep it under 2000 characters');
  return transaction(db, async tx => {
    const [current] = await tx.query<Reminder>(`select * from reminders where id=$1 and owner_user_id=$2 and status='scheduled' for update`, [args.reminderId, args.ownerUserId]);
    if (!current) return null;
    const due = args.dueAt ? validateDue(args.dueAt) : new Date(current.due_at);
    const timezone = validateReminderTimezone(args.timezone ?? current.timezone);
    const [row] = await tx.query<Reminder>(
      `update reminders set body=coalesce($3,body),due_at=$4,timezone=$5,revision=revision+1
       where id=$1 and owner_user_id=$2 and status='scheduled' returning *`,
      [args.reminderId, args.ownerUserId, body, due.toISOString(), timezone],
    );
    if (!row) return null;
    await enqueue(tx, { kind: REMINDER_JOB_KIND, payload: { reminderId: row.id, revision: Number(row.revision) }, runAt: due });
    await appendEvent(tx, { actorUserId: args.ownerUserId, actor: 'user', kind: 'reminder.updated', subjectType: 'reminder', subjectId: row.id,
      payload: { dueAt: row.due_at, timezone, revision: Number(row.revision), bodyChars: row.body.length } });
    return row;
  });
}

export async function listRemindersFor(db: Db, args: { ownerUserId: string; includeSettled?: boolean; limit?: number }): Promise<Reminder[]> {
  return db.query<Reminder>(`select * from reminders where owner_user_id=$1 and ($2 or status='scheduled') order by due_at asc limit $3`,
    [args.ownerUserId, args.includeSettled === true, Math.min(args.limit ?? 50, 200)]);
}

export async function listNativeReminderActions(db: Db, args: { ownerUserId: string }): Promise<NativeReminderAction[]> {
  const rows = await db.query<Reminder>(
    `select * from reminders where owner_user_id=$1 and thread_id is not null and status in ('scheduled','cancelled') order by updated_at,id`,
    [args.ownerUserId],
  );
  return rows.map(nativeReminderAction).filter((action): action is NativeReminderAction => action !== null);
}

export async function cancelReminder(db: Db, args: { ownerUserId: string; reminderId: string }): Promise<Reminder | null> {
  if (!uuid.test(args.reminderId)) return null;
  return transaction(db, async tx => {
    const [row] = await tx.query<Reminder>(
      `update reminders set status='cancelled',revision=revision+1 where id=$1 and owner_user_id=$2 and status='scheduled' returning *`,
      [args.reminderId, args.ownerUserId],
    );
    if (!row) return null;
    await appendEvent(tx, { actorUserId: args.ownerUserId, actor: 'user', kind: 'reminder.cancelled', subjectType: 'reminder', subjectId: row.id,
      payload: { revision: Number(row.revision) } });
    return row;
  });
}

export async function deliverReminderPersisted(
  db: Db,
  args: { reminderId: string; revision: number; text: string; category: 'reminder' | 'calendar'; pushBody: string },
): Promise<Reminder | null> {
  const [row] = await db.query<Reminder>(`with claimed as (
    update reminders set status='delivered',delivered_at=now() where id=$1 and revision=$2 and status='scheduled' and due_at<=now() returning *
  ), fresh_thread as (
    insert into threads(owner_user_id,title) select owner_user_id,'Reminders' from claimed where thread_id is null returning id
  ), target as (
    select c.*,coalesce(c.thread_id,f.id) target_thread_id from claimed c left join fresh_thread f on true
  ), cleared as (
    update assistant_action_states set presented_turn_id=null where thread_id in(select target_thread_id from target) and status='prepared' and presented_turn_id is not null returning id
  ), message as (
    insert into messages(thread_id,direction,channel,body) select target_thread_id,'out','web',$3 from target returning id,thread_id
  ), touched as (
    update threads set last_activity_at=now() where id in(select thread_id from message) returning id
  ), pushed as (
    insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,route_thread_id,title,body,explicit_reminder)
      select t.owner_user_id,d.id,'reminder:'||t.id||':'||t.revision,$4,'reminder',t.id,coalesce(t.thread_id,(select thread_id from message limit 1)),'Josi reminder',$5,true from target t
      join mobile_devices d on d.owner_user_id=t.owner_user_id and d.revoked_at is null and coalesce((d.categories->>$4)::boolean,true)
      on conflict(device_id,event_key) do nothing
  ) select * from claimed`, [args.reminderId, args.revision, args.text, args.category, args.pushBody]);
  return row ?? null;
}

export async function reminderOverview(db: Db, args: { ownerUserId: string; recentDays?: number }): Promise<{ upcoming: Reminder[]; recent: Reminder[] }> {
  const days = Math.min(Math.max(args.recentDays ?? 7, 1), 31);
  const upcoming = await db.query<Reminder>(`select * from reminders where owner_user_id=$1 and status='scheduled' order by due_at asc limit 100`, [args.ownerUserId]);
  const recent = await db.query<Reminder>(`select * from reminders where owner_user_id=$1 and status<>'scheduled' and coalesce(delivered_at,updated_at,due_at)>now()-make_interval(days=>$2) order by coalesce(delivered_at,updated_at,due_at) desc limit 100`, [args.ownerUserId, days]);
  return { upcoming, recent };
}

export async function markReminderFailed(db: Db, reminderId: string): Promise<void> {
  await db.query(`update reminders set status='failed',delivered_at=null where id=$1`, [reminderId]);
}
