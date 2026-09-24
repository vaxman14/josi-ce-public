// The approval gate for custom API writes and deletes.
//
// A write or a delete never happens because a model decided to. It becomes a
// row in `custom_api_pending_calls`, its owner is shown exactly what would be
// sent, and the request is made only after they say so — once, for that exact
// request.
//
// WHY THIS IS NOT `core/approvals.ts`
//
// It uses the same MECHANISM — a pinned payload hash, so approving "update the
// record" cannot be spent on a different record — and deliberately not the same
// table. `approvals` is keyed to a task, a thread, a folder mapping or a
// document, and its decision route only records a verdict: something else
// executes afterwards, later, elsewhere. For an outbound HTTP call that gap is
// the failure mode worth designing out. An approved request that sits
// unexecuted is a promise nobody kept; one executed twice by two surfaces is a
// duplicate charge on somebody's account.
//
// So the decision and the request are one route here, and the thing that makes
// "exactly once" true is `claimApproved` below: a single conditional UPDATE
// that moves a row out of `pending` and returns it. Two simultaneous approvals
// race on that statement and exactly one wins — which is the same guarantee a
// transaction would give, expressed in the one statement the Db seam has.
//
// WHAT IS AND IS NOT STORED
//
//   * The arguments are SEALED. A request body on the way to a CRM is
//     somebody's data and has no business being readable in a database dump
//     while it waits for an answer.
//   * The summary is CONTENT — it may quote what is about to be sent — so it
//     belongs to its owner and is never copied into an audit payload.
//   * The result is a STATUS NUMBER. Never a body.
import {
  appendEvent, approvalHash, openSealed, seal,
  type Db, type MasterKey,
} from '@josi-ce/core';
import type {
  CustomApiConnectionRow, CustomApiEndpointRow, CustomApiPendingCallRow,
} from './customApi.js';
import type { BuiltCustomApiRequest } from './customApiRequest.js';

/** How long an unanswered request stays answerable.
 *
 * Thirty minutes: long enough to walk away from the screen and come back,
 * short enough that nobody is ever shown a request from a conversation they no
 * longer remember. A pending write from last month is not consent, and offering
 * it as one is how somebody approves something they have forgotten. */
export const PENDING_CALL_TTL_SECONDS = 30 * 60;

/** A refusal about a pending request.
 *
 * `notFound` is carried on the error rather than decided by the route, because
 * the route would have to match on a message to tell "not yours" from "already
 * decided" — and those two must answer differently. A request belonging to
 * somebody else is 404, exactly like one that never existed: 403 would confirm
 * that a colleague asked Josi for something. */
export class CustomApiCallError extends Error {
  constructor(message: string, readonly notFound = false) {
    super(message);
  }
}

/** What gets sealed and what the hash pins.
 *
 * The URL is included deliberately: pinning only the arguments would let an
 * endpoint row be edited between "may I?" and "yes" and turn an approved read
 * of one record into a write to another. */
export interface SealedCustomApiRequest {
  url: string;
  method: string;
  body: unknown;
}

const UUID = /^[0-9a-fA-F-]{36}$/;

/**
 * The sentence the owner reads before they agree.
 *
 * Written from the ALLOWLIST ROW and the arguments, not from anything the model
 * said about them: a model asked to describe its own action can describe a
 * gentler one. Method and capability are named in plain words because "PATCH"
 * is not something everybody reads as "change".
 */
export function describeCustomApiCall(args: {
  connection: CustomApiConnectionRow;
  endpoint: CustomApiEndpointRow;
  arguments: Record<string, unknown>;
  hasBody: boolean;
}): string {
  const verb = args.endpoint.capability === 'delete' ? 'delete something in' : 'change something in';
  const supplied = Object.entries(args.arguments)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`);

  return [
    `Josi wants to ${verb} ${args.connection.name}.`,
    `Action: ${args.endpoint.operation_id} — ${args.endpoint.summary}`,
    `Request: ${args.endpoint.method} ${args.endpoint.path_template}`,
    supplied.length ? `With: ${supplied.join(', ')}` : 'With no extra details.',
    args.hasBody ? 'It also sends a block of details Josi has prepared.' : '',
  ].filter(Boolean).join(' ').slice(0, 2000);
}

/**
 * Records a request that is waiting on its owner.
 *
 * Idempotent for the same person, action and payload: the unique index on
 * (owner, endpoint, payload_hash) where status = 'pending' means a second
 * identical "shall I?" updates the existing row rather than adding a second
 * card. Two identical prompts is a bug that trains people to click yes.
 */
export async function requestCustomApiCall(
  db: Db,
  key: MasterKey,
  args: {
    ownerUserId: string;
    threadId?: string | null;
    connection: CustomApiConnectionRow;
    endpoint: CustomApiEndpointRow;
    request: BuiltCustomApiRequest;
    summary: string;
    ttlSeconds?: number;
  },
): Promise<CustomApiPendingCallRow> {
  const payload: SealedCustomApiRequest = {
    url: args.request.url,
    method: args.request.method,
    body: args.request.body ?? null,
  };
  const hash = approvalHash(payload);
  const rows = await db.query<CustomApiPendingCallRow>(
    `insert into custom_api_pending_calls
       (owner_user_id, endpoint_id, thread_id, summary, request_enc, payload_hash, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7::int))
     on conflict (owner_user_id, endpoint_id, payload_hash) where status = 'pending'
       do update set summary = excluded.summary, expires_at = excluded.expires_at
     returning *`,
    [
      args.ownerUserId, args.endpoint.id, args.threadId ?? null, args.summary,
      seal(key, payload), hash, args.ttlSeconds ?? PENDING_CALL_TTL_SECONDS,
    ],
  );
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'agent',
    kind: 'custom_api.call_requested',
    subjectType: 'custom_api_pending_call',
    subjectId: rows[0].id,
    // Which action, and what class of thing it does. Never the arguments, never
    // the summary — the summary is what the action WOULD say, and it stays with
    // its owner.
    payload: {
      slug: args.connection.slug,
      operationId: args.endpoint.operation_id,
      method: args.endpoint.method,
      capability: args.endpoint.capability,
    },
  });
  return rows[0];
}

/** Somebody's own pending requests. Owner-scoped by the query, so there is no
 * id for a caller to substitute. */
export async function listPendingCalls(
  db: Db,
  ownerUserId: string,
): Promise<Array<CustomApiPendingCallRow & {
  operation_id: string; endpoint_summary: string; capability: string; method: string;
  connection_name: string; slug: string;
}>> {
  return db.query(
    `select p.*, e.operation_id, e.summary as endpoint_summary, e.capability, e.method,
            c.name as connection_name, c.slug
       from custom_api_pending_calls p
       join custom_api_endpoints e on e.id = p.endpoint_id
       join custom_api_connections c on c.id = e.connection_id
      where p.owner_user_id = $1 and p.status = 'pending' and p.expires_at > now()
      order by p.created_at desc
      limit 100`,
    [ownerUserId],
  );
}

export async function pendingCallById(
  db: Db,
  id: string,
): Promise<CustomApiPendingCallRow | null> {
  if (!UUID.test(id)) return null;
  const rows = await db.query<CustomApiPendingCallRow>(
    `select * from custom_api_pending_calls where id = $1`, [id],
  );
  return rows[0] ?? null;
}

/**
 * Claims a pending request for execution, atomically.
 *
 * The whole "exactly once" guarantee is this one statement. `status = 'pending'`
 * in the WHERE clause means two concurrent approvals — two browser tabs, a
 * double-tapped button, a retried request — produce one row and one null, and
 * the caller that got null makes no request.
 *
 * `decidedBy` must be the OWNER. A super admin configured the pipe; they do not
 * get to decide what somebody sends through it, and there is no role branch in
 * this function for one to be added to.
 */
export async function claimApproved(
  db: Db,
  args: { callId: string; decidedBy: string },
): Promise<CustomApiPendingCallRow> {
  const existing = await pendingCallById(db, args.callId);
  // Same sentence AND the same status as "does not exist": telling somebody a
  // request exists but is not theirs confirms a colleague asked for something.
  if (!existing || existing.owner_user_id !== args.decidedBy) {
    throw new CustomApiCallError('there is no request with that id', true);
  }
  if (existing.status !== 'pending') {
    throw new CustomApiCallError(`that request was already ${existing.status}`);
  }
  if (new Date(existing.expires_at) < new Date()) {
    await db.query(
      `update custom_api_pending_calls set status = 'expired' where id = $1 and status = 'pending'`,
      [args.callId],
    );
    throw new CustomApiCallError(
      'that request expired. Ask again and Josi will prepare a fresh one — an old request is not consent.',
    );
  }

  const rows = await db.query<CustomApiPendingCallRow>(
    `update custom_api_pending_calls
        set status = 'approved', decided_at = now(), decided_by = $2
      where id = $1 and status = 'pending' and expires_at > now()
      returning *`,
    [args.callId, args.decidedBy],
  );
  if (!rows.length) throw new CustomApiCallError('that request was already decided');

  await appendEvent(db, {
    actorUserId: args.decidedBy,
    actor: 'user',
    kind: 'custom_api.call_approved',
    subjectType: 'custom_api_pending_call',
    subjectId: args.callId,
  });
  return rows[0];
}

export async function denyCustomApiCall(
  db: Db,
  args: { callId: string; decidedBy: string },
): Promise<CustomApiPendingCallRow> {
  const existing = await pendingCallById(db, args.callId);
  if (!existing || existing.owner_user_id !== args.decidedBy) {
    throw new CustomApiCallError('there is no request with that id', true);
  }
  const rows = await db.query<CustomApiPendingCallRow>(
    `update custom_api_pending_calls
        set status = 'denied', decided_at = now(), decided_by = $2
      where id = $1 and status = 'pending'
      returning *`,
    [args.callId, args.decidedBy],
  );
  if (!rows.length) throw new CustomApiCallError(`that request was already ${existing.status}`);
  await appendEvent(db, {
    actorUserId: args.decidedBy,
    actor: 'user',
    kind: 'custom_api.call_denied',
    subjectType: 'custom_api_pending_call',
    subjectId: args.callId,
  });
  return rows[0];
}

/**
 * Opens the sealed request and checks it is still the one that was approved.
 *
 * The hash is re-verified rather than trusted, because the row was written by
 * one code path and is being read by another — and a sealed value that opens is
 * only proof that the master key sealed it, not proof of which request it was.
 */
export function openApprovedRequest(
  key: MasterKey,
  row: CustomApiPendingCallRow,
): SealedCustomApiRequest {
  const payload = openSealed<SealedCustomApiRequest>(key, row.request_enc);
  if (approvalHash(payload) !== row.payload_hash) {
    throw new CustomApiCallError(
      'that request no longer matches what was approved, so Josi did not make it',
    );
  }
  return payload;
}

/** What happened. A status number, never a body. */
export async function recordCallResult(
  db: Db,
  args: { callId: string; ownerUserId: string; ok: boolean; status?: number | null; slug: string; operationId: string },
): Promise<void> {
  await db.query(
    `update custom_api_pending_calls
        set status = $2, executed_at = now(), result_status = $3
      where id = $1`,
    [args.callId, args.ok ? 'executed' : 'failed', args.status ?? null],
  );
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: args.ok ? 'custom_api.call_executed' : 'custom_api.call_failed',
    subjectType: 'custom_api_pending_call',
    subjectId: args.callId,
    payload: {
      slug: args.slug,
      operationId: args.operationId,
      // The HTTP status the API answered with. A number, never its body.
      resultStatus: args.status ?? null,
    },
  });
}

/** Expires requests nobody answered. Run by the worker, beside `expireApprovals`. */
export async function expireCustomApiCalls(db: Db): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `update custom_api_pending_calls set status = 'expired'
      where status = 'pending' and expires_at < now()
      returning id`,
  );
  return rows.length;
}
