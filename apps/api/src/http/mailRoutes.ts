import { emailTemplateRoutes } from './emailTemplateRoutes.js';
// Operational email over HTTP.
//
// The admin half of this file is the one to read carefully. M38 says an
// administrator may see delivery METADATA — who sent it, to which address,
// when, what happened — and never a subject, a body, an attachment or a reply.
//
// That is enforced by where the data comes from, not by remembering to omit
// columns: `email_sends` has no subject column and no body column, so the
// metadata query cannot leak content even if someone widens the SELECT. The
// test asserts it anyway.
import { Router, type Request, type Response } from 'express';
import {
  appendEvent, canWrite, decideApproval, loadMasterKey, requestApproval, resolveAccess,
  shareResource, unshareResource,
  type Db, type LoadOptions, type MasterKey,
} from '@josi-ce/core';
import { accessorOf, requireAuth, requireOwnership, requireSuperAdmin } from './authz.js';
import {
  MailError, NoProfileError, SendRefused,
  approvalRequiredFor, createThread, listThreadsFor, loadProfile, mailPolicy,
  messagePayload, quarantineSummary, restoreThread, retentionNotice, sendOperationalEmail, smtpTransport,
  trashThread, type SmtpTransport,
} from '@josi-ce/mail';
import { can } from '@josi-ce/connectors';
import { asyncRoute, param } from './async.js';

export interface MailRoutesCtx {
  db: Db;
  masterKey?: LoadOptions | false;
  /** Injected by the tests. No suite contacts a mail server. */
  transport?: SmtpTransport;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v: unknown, max = 50): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, 320)).filter(Boolean).slice(0, max) : [];

function requireKey(ctx: MailRoutesCtx): MasterKey {
  if (ctx.masterKey === false) throw new RouteError(503, 'this installation cannot open stored secrets');
  try {
    return loadMasterKey(ctx.masterKey ?? {});
  } catch {
    throw new RouteError(503, 'the installation master key is missing or unusable');
  }
}

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncRoute(async (req: Request, res: Response) => {
    try {
      return await fn(req, res);
    } catch (err: unknown) {
      if (err instanceof RouteError) return res.status(err.status).json({ error: err.message });
      if (err instanceof NoProfileError) return res.status(409).json({ error: err.message });
      if (err instanceof SendRefused) {
        // 409 with the reason and the sentence: the caller has to be able to
        // tell "raise an approval" apart from "this is not allowed at all".
        return res.status(409).json({ error: err.message, reason: err.reason });
      }
      if (err instanceof MailError) {
        // A category. Never the mail server's own words.
        return res.status(502).json({ error: err.message, category: err.category });
      }
      throw err;
    }
  });

// ------------------------------------------------------------------ member

export function mailRoutes(ctx: MailRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireAuth);
  r.use('/templates', emailTemplateRoutes(db));

  async function transportFor(): Promise<{ transport: SmtpTransport; profile: { fromAddress: string; fromName: string } }> {
    const profile = await loadProfile(db, requireKey(ctx), 'communications');
    return {
      transport: ctx.transport ?? smtpTransport(profile),
      profile: { fromAddress: profile.fromAddress, fromName: profile.fromName },
    };
  }

  r.get(
    '/threads',
    handle(async (req, res) => {
      const threads = await listThreadsFor(db, {
        ownerUserId: req.user!.id,
        includeTrashed: req.query.trash === '1',
      });
      return res.json({
        threads,
        // M39: shown before anything is deleted, not after.
        retention: await retentionNotice(db, req.user!.id),
      });
    }),
  );

  r.post(
    '/threads',
    handle(async (req, res) => {
      const subject = str(req.body?.subject, 300);
      if (!subject) throw new RouteError(400, 'a subject is required');
      const thread = await createThread(db, {
        ownerUserId: req.user!.id,
        subject,
        participants: list(req.body?.participants),
      });
      return res.status(201).json({ thread });
    }),
  );

  /** The thread and its messages. Owner or an explicit share — the Phase 1
   * spine decides, and a non-owner without a share gets 404. */
  r.get(
    '/threads/:id',
    requireOwnership({ db }, { type: 'email_thread', need: 'read' }),
    handle(async (req, res) => {
      const threadId = param(req, 'id');
      const [thread] = await db.query(`select * from email_threads where id = $1`, [threadId]);
      const messages = await db.query(
        `select id, direction, from_address, to_addresses, cc_addresses, subject, body_text, created_at
         from email_messages where thread_id = $1 order by created_at`,
        [threadId],
      );
      const participants = await db.query(
        `select address, role, added_at from email_participants where thread_id = $1`,
        [threadId],
      );
      return res.json({ thread, messages, participants });
    }),
  );

  /** M37: a colleague sees a thread only after its owner says so.
   *
   * Enforcement alone was not enough. The ownership spine has honoured shares
   * since Phase 1 and every mail route already asks it, but nothing reachable
   * over HTTP could ever CREATE one — so "visible only to the owner unless
   * shared" was true in the sense that sharing was impossible. This is the
   * other half.
   *
   * Read-only by default. `canWrite` is opt-in because writing on a thread
   * means sending mail under the OWNER's name, which is a different thing to
   * agree to than letting someone read along.
   */
  r.post(
    '/threads/:id/share',
    requireOwnership({ db }, { type: 'email_thread', need: 'owner' }),
    handle(async (req, res) => {
      const threadId = param(req, 'id');
      const withUserId = str(req.body?.userId, 64);
      const withWorkspace = req.body?.workspace === true;
      if (!withUserId && !withWorkspace) {
        throw new RouteError(400, 'name a colleague to share with, or share with the workspace');
      }
      if (withUserId && withUserId === req.user!.id) {
        throw new RouteError(400, 'that thread is already yours');
      }
      if (withUserId) {
        const [target] = await db.query<{ id: string }>(
          `select id from users where id = $1 and status = 'active'`,
          [withUserId],
        );
        if (!target) throw new RouteError(404, 'no such colleague');
      }

      const canWriteShare = req.body?.canWrite === true;
      await shareResource(db, {
        type: 'email_thread',
        resourceId: threadId,
        ownerUserId: req.user!.id,
        withUserId: withUserId || null,
        withWorkspace,
        canWrite: canWriteShare,
      });
      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'user',
        kind: 'mail.thread_shared',
        subjectType: 'email_thread',
        subjectId: threadId,
        // Who it went to and how much. Never the subject.
        payload: { workspace: withWorkspace, canWrite: canWriteShare },
      });
      // Said plainly, because the two are very different promises and the
      // workspace case is the one people misjudge.
      const who = withWorkspace ? 'Everyone in this workspace' : 'They';
      return res.json({
        shared: true,
        canWrite: canWriteShare,
        notice: canWriteShare
          ? `${who} can read this thread and send on it under your name.`
          : `${who} can read this thread. ${withWorkspace ? 'They' : 'They'} cannot send on it.`,
      });
    }),
  );

  r.delete(
    '/threads/:id/share',
    requireOwnership({ db }, { type: 'email_thread', need: 'owner' }),
    handle(async (req, res) => {
      const threadId = param(req, 'id');
      await unshareResource(db, {
        type: 'email_thread',
        resourceId: threadId,
        withUserId: str(req.body?.userId, 64) || null,
        withWorkspace: req.body?.workspace === true,
      });
      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'user',
        kind: 'mail.thread_unshared',
        subjectType: 'email_thread',
        subjectId: threadId,
        payload: { workspace: req.body?.workspace === true },
      });
      return res.json({ shared: false });
    }),
  );

  /** Ask for permission to do the thing that needs it.
   *
   * The client sends what it intends; the server computes whether an approval
   * is required and what it would cover, then pins that exact payload. A client
   * cannot ask for approval of one thing and send another — the hash is
   * computed here, from the same fields the send path will hash. */
  r.post(
    '/threads/:id/request-approval',
    requireOwnership({ db }, { type: 'email_thread', need: 'write' }),
    handle(async (req, res) => {
      const threadId = param(req, 'id');
      const to = list(req.body?.to);
      const cc = list(req.body?.cc);
      const subject = str(req.body?.subject, 300);
      const body = str(req.body?.body, 100_000);
      const attachments = list(req.body?.attachmentShas).map((sha, i) => ({
        filename: list(req.body?.attachmentNames)[i] ?? 'attachment', sha256: sha,
      }));

      const existing = await db.query<{ address: string }>(
        `select address from email_participants where thread_id = $1`, [threadId],
      );
      const known = new Set(existing.map((p) => p.address.toLowerCase()));
      const newRecipients = [...to, ...cc].filter((a) => !known.has(a.toLowerCase()));
      const [{ count }] = await db.query<{ count: string }>(
        `select count(*)::text as count from email_messages where thread_id = $1`, [threadId],
      );

      const needed = approvalRequiredFor({
        attachments: attachments.map((a) => ({ ...a, contentType: '', content: Buffer.alloc(0) })),
        newRecipients,
        historyMessageCount: Number(count),
      });
      if (!needed) return res.json({ required: false });

      const [thread] = await db.query<{ owner_user_id: string }>(
        `select owner_user_id from email_threads where id = $1`, [threadId],
      );
      const approval = await requestApproval(db, {
        threadId,
        ownerUserId: thread.owner_user_id,
        actionClass: 'email_send',
        action: needed.action,
        summary: needed.summary,
        // The canonical message, from the same fields the send path will use.
        // `requestApproval` hashes it; handing it a pre-computed hash would
        // hash the hash and the comparison could never match.
        payload: messagePayload({ threadId, to, cc, subject, body, attachments }),
      });
      return res.json({ required: true, approval });
    }),
  );

  r.post(
    '/threads/:id/send',
    requireOwnership({ db }, { type: 'email_thread', need: 'write' }),
    handle(async (req, res) => {
      const threadId = param(req, 'id');
      const [thread] = await db.query<{ owner_user_id: string }>(
        `select owner_user_id from email_threads where id = $1`, [threadId],
      );
      if (!thread) throw new RouteError(404, 'not found');

      // Sent on behalf of the thread's OWNER, whoever pressed the button. A
      // share lets a colleague help with a conversation; it does not let them
      // put mail into the world under someone else's name.
      const [person] = await db.query<{ display_name: string | null; username: string }>(
        `select display_name, username from users where id = $1`, [thread.owner_user_id],
      );

      // The connector capability, if the owner connected an account. Operational
      // mail goes through the installation's own profile, so this is the
      // installation-level permission to send on someone's behalf at all.
      const capability = await can(db, {
        ownerUserId: thread.owner_user_id, capability: 'google.mail.send',
      }).catch(() => ({ allowed: false }));

      const { transport, profile } = await transportFor();
      const result = await sendOperationalEmail({
        db, transport, threadId,
        initiator: { id: thread.owner_user_id, name: person?.display_name ?? person?.username ?? '' },
        to: list(req.body?.to),
        cc: list(req.body?.cc),
        bcc: list(req.body?.bcc),
        subject: str(req.body?.subject, 300),
        body: str(req.body?.body, 100_000),
        approvalId: str(req.body?.approvalId, 64) || undefined,
        profile,
        // Operational mail through the installation profile does not require a
        // connected mailbox; the capability gate applies when it exists.
        capabilityAllowed: capability.allowed || !(await hasConnection(db, thread.owner_user_id)),
      });
      return res.json(result);
    }),
  );

  r.delete(
    '/threads/:id',
    requireOwnership({ db }, { type: 'email_thread', need: 'write' }),
    handle(async (req, res) =>
      res.json(await trashThread(db, { threadId: param(req, 'id'), actorUserId: req.user!.id }))),
  );

  r.post(
    '/threads/:id/restore',
    requireOwnership({ db }, { type: 'email_thread', need: 'write' }),
    handle(async (req, res) => {
      const restored = await restoreThread(db, { threadId: param(req, 'id'), actorUserId: req.user!.id });
      if (!restored) throw new RouteError(409, 'that conversation is not in the trash');
      return res.json({ ok: true });
    }),
  );

  return r;
}

async function hasConnection(db: Db, ownerUserId: string): Promise<boolean> {
  const rows = await db.query(
    `select 1 from connections where owner_user_id = $1 and provider = 'google'`, [ownerUserId],
  );
  return rows.length > 0;
}

// ------------------------------------------------------------------- admin

export function adminMailRoutes(ctx: MailRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireSuperAdmin);

  r.get(
    '/',
    asyncRoute(async (_req, res) => {
      /** M38. Every column here is delivery metadata.
       *
       * `email_sends` has no subject and no body — that is the control. A
       * future edit that adds one to this SELECT cannot leak content because
       * there is none in the table to select. */
      const deliveries = await db.query(
        `select s.id, u.username as initiated_by, s.recipient, s.status, s.attempts,
                s.queued_at, s.sent_at, s.error_category
         from email_sends s
         left join users u on u.id = s.initiating_user_id
         order by s.queued_at desc limit 200`,
      );
      const [counts] = await db.query<{ threads: string; sent: string; failed: string; quarantined: string }>(
        `select
           (select count(*) from email_threads)::text as threads,
           (select count(*) from email_sends where status = 'sent')::text as sent,
           (select count(*) from email_sends where status = 'failed')::text as failed,
           (select count(*) from email_quarantine)::text as quarantined`,
      );
      return res.json({
        policy: await mailPolicy(db),
        deliveries,
        counts: {
          threads: Number(counts.threads), sent: Number(counts.sent),
          failed: Number(counts.failed), quarantined: Number(counts.quarantined),
        },
        // Why messages could not be attributed. Never their contents.
        quarantine: await quarantineSummary(db, 50),
      });
    }),
  );

  r.put(
    '/policy',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const number = (v: unknown): number | null => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };

      const disclosure = typeof body.disclosure === 'string' ? body.disclosure.trim() : '';
      if (disclosure && disclosure.length < 10) {
        // M41. The wording is theirs; its presence is not.
        return res.status(400).json({
          error: 'the AI disclosure can be reworded but not removed — it must be at least 10 characters',
        });
      }

      const trashDays = number(body.trashDays);
      const retentionDays = number(body.retentionDays);
      const maxRecipients = number(body.maxRecipients);
      if (trashDays !== null && (trashDays < 0 || trashDays > 365)) {
        return res.status(400).json({ error: 'trash retention must be between 0 and 365 days' });
      }
      if (retentionDays !== null && retentionDays < 1) {
        return res.status(400).json({ error: 'a retention maximum must be at least one day, or empty for none' });
      }
      if (maxRecipients !== null && (maxRecipients < 1 || maxRecipients > 50)) {
        return res.status(400).json({ error: 'the recipient ceiling must be between 1 and 50' });
      }

      await db.query(
        `update mail_policy set
           retention_days = $1,
           trash_days = coalesce($2, trash_days),
           disclosure = coalesce(nullif($3, ''), disclosure),
           inbound_enabled = coalesce($4, inbound_enabled),
           max_recipients = coalesce($5, max_recipients)
         where id = true`,
        [
          retentionDays, trashDays, disclosure,
          typeof body.inboundEnabled === 'boolean' ? body.inboundEnabled : null,
          maxRecipients,
        ],
      );
      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'mail.policy_changed',
        payload: { fields: Object.keys(body) },
      });
      return res.json({ policy: await mailPolicy(db) });
    }),
  );

  return r;
}
