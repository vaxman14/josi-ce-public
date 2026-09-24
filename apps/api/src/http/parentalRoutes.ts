// Parental Controls over HTTP.
//
// TWO ROUTERS, AND THE SPLIT IS THE FEATURE.
//
//   `adminParentalRoutes` is BUYING. Activate a licence, see what this
//   installation is entitled to, switch it off again. It is mounted behind
//   `requireSuperAdmin` and it returns no child, no name, no schedule, no
//   minute and no message — there is no query in it that touches
//   `parental_links`, `child_controls`, `child_activity_minutes`, `threads` or
//   `messages`, which is asserted by a test that reads this file.
//
//   `parentalRoutes` is AUTHORITY. Every route in it resolves
//   `parentalAuthority(parent, child)` — a row in `parental_links` — and
//   nothing else. Role is never consulted. The super admin who activated the
//   module reaches exactly as far here as a stranger: 404.
//
// WHY 404 EVERYWHERE, INCLUDING FOR THE MODULE ITSELF
//
// Two different facts are being protected and both deserve the same answer.
// With the module inert, `/api/parental/...` should be indistinguishable from
// an endpoint that was never written — the same reasoning `requireCapability`
// gives. And for one member asking about another member's account, 403 would
// confirm "that account is somebody's managed child", which is a disclosure
// about a family made to a stranger.
//
// WHAT COSTS WHAT
//
//   read your own family's pages          a session
//   change a limit or a timetable         a session + the password again
//                                         (`change_settings` step-up — the
//                                         threat is the child on the parent's
//                                         open laptop, and it is a real one)
//   create, or end, a relationship        a session + the password + a TOTP
//                                         code, proved in one request, spent
//                                         once, within five minutes
//
// The third is the one this module exists to protect. Everything else about a
// person can be repaired; a relationship row silently added by somebody who
// borrowed a laptop is a stranger reading a child's conversations.
import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import {
  CHILD_DISCLOSURE, CHILD_DISCLOSURE_LIMITS, MAX_CHILDREN_PER_PARENT, PARENTAL_MODULE,
  ScheduleError, activateEntitlement, appendEvent, checkChildAccess, checkStepUp, childrenOf,
  consumeAuthorityGrant, controllerOf, createLink, endLink, entitlementStatus, getControls,
  issueAuthorityGrant, listMessages, loadMasterKey, minutesUsedToday, normalizeWindows,
  openSealed, parentalAuthority, publisherKey, revokeEntitlement, setControls, usageSummary,
  type Db, type LoadOptions,
} from '@josi-ce/core';
import { UserError, createUser, issueAuthToken, verifyPassword } from '@josi-ce/auth';
import { verify as verifyTotp } from 'otplib';
import { asyncRoute, param } from './async.js';
import { requireAuth, requireSuperAdmin } from './authz.js';

export interface ParentalRoutesCtx {
  db: Db;
  /** Where an invite link points, for a child account just created. */
  appUrl: string;
  /** The TOTP secret is sealed, so proving a second factor needs the key. An
   * installation without one cannot check a code and says so rather than
   * quietly accepting a password alone. */
  masterKey?: LoadOptions | false;
  /** The publisher key licences are checked against. Undefined means "use the
   * one stamped into this build", which is what production does; the tests
   * inject their own, exactly as they inject every other outside thing. */
  entitlementPublicKey?: string | null;
}

/** How many wrong password/code attempts before a cool-down, and how long it
 * looks back. The same shape as `stepUp.ts`, and for the reason recorded
 * there: a counter over all time locks an owner out of their own family. */
const MAX_AUTHORITY_ATTEMPTS = 5;
const AUTHORITY_LOCKOUT_SECONDS = 15 * 60;

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

class RouteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncRoute(async (req: Request, res: Response) => {
    try {
      return await fn(req, res);
    } catch (err) {
      if (err instanceof RouteError) return res.status(err.status).json({ error: err.message });
      if (err instanceof ScheduleError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

/** What every screen in this module says about what it is and is not. One
 * string, exported, so the API and the pages cannot drift into two different
 * promises about the same feature. */
export const PARENTAL_HONESTY = {
  scope: 'These controls cover time spent talking to Josi here — the web app and any '
    + 'messaging channel connected to this account. They are enforced on this server.',
  notDevice: 'They are not device controls. Josi cannot lock a phone, close another app, '
    + 'filter the web, or see anything that happens outside Josi. Nothing here should be '
    + 'relied on as the only limit on a child’s device.',
  minutes: 'A minute is counted when your child sends something to Josi. Time spent reading '
    + 'a reply is not counted, because this server cannot see a screen being looked at.',
  admin: 'The person who administers this installation cannot see any of this. They can see '
    + 'that the module is switched on, and nothing about who is looking after whom.',
} as const;

// ------------------------------------------------------------ the member side

export function parentalRoutes(ctx: ParentalRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireAuth);

  /** The module gate. Mounted first, so no handler below can be reached on an
   * installation that has not bought it — and answering 404 rather than 403 so
   * an unentitled installation looks like one that never had the routes. */
  r.use((req, res, next) => {
    void (async () => {
      const status = await entitlementStatus(db, PARENTAL_MODULE);
      if (!status.entitled) {
        res.status(404).json({ error: 'no such endpoint' });
        return;
      }
      next();
    })().catch(next);
  });

  /** Resolves `:childUserId` through the relationship and nothing else. */
  async function authorizedChild(req: Request): Promise<string> {
    const childUserId = param(req, 'childUserId');
    const allowed = await parentalAuthority(db, { parentUserId: req.user!.id, childUserId });
    if (!allowed) throw new RouteError(404, 'not found');
    return childUserId;
  }

  /** Parent-only. A managed child may not hold authority over anybody — the
   * check is here rather than only in the UI because hiding a button is not a
   * control. */
  async function refuseManagedChild(req: Request): Promise<void> {
    if (await controllerOf(db, req.user!.id)) {
      throw new RouteError(403, 'A managed account cannot look after another account.');
    }
  }

  async function requirePasswordAgain(req: Request): Promise<void> {
    const decision = await checkStepUp(db, {
      userId: req.user!.id, sessionKey: req.user!.session_id, action: 'change_settings',
    });
    if (!decision.allowed) {
      throw new RouteError(401, decision.message ?? 'Confirm your password to change this.');
    }
  }

  // ------------------------------------------------------------- the overview
  //
  // One route answers for both people, because "which am I?" is a question the
  // server should answer rather than the client guess. A member who is neither
  // gets `none` and no data at all — not an empty list of somebody's children,
  // which would still confirm the shape of somebody's family.
  r.get('/overview', handle(async (req, res) => {
    const status = await entitlementStatus(db, PARENTAL_MODULE);
    const asChild = await controllerOf(db, req.user!.id);

    if (asChild) {
      const controls = await getControls(db, req.user!.id);
      const access = await checkChildAccess(db, { userId: req.user!.id });
      const [guardian] = await db.query<{ display_name: string | null; username: string }>(
        `select display_name, username from users where id = $1`, [asChild.parent_user_id],
      );
      // What the adult has actually done, shown to the child. A child who can
      // see the watching is being supervised; one who cannot is being
      // monitored, and those are different things.
      const seen = await db.query<{ kind: string; created_at: string }>(
        `select kind, created_at from events
         where kind like 'parental.%'
           and ((subject_type = 'user' and subject_id = $1) or payload->>'child' = $1)
         order by id desc limit 25`,
        [req.user!.id],
      );
      return res.json({
        module: { state: status.state },
        role: 'child',
        honesty: PARENTAL_HONESTY,
        child: {
          guardian: guardian?.display_name || guardian?.username || 'your parent',
          since: asChild.created_at,
          controls: controls ? publicControls(controls) : null,
          usedMinutesToday: controls
            ? await minutesUsedToday(db, { childUserId: req.user!.id, timezone: controls.timezone })
            : 0,
          access: { allowed: access.allowed, reason: access.reason, message: access.message ?? null, opensAgain: access.opensAgain ?? null },
          canSee: [...CHILD_DISCLOSURE],
          cannotSee: [...CHILD_DISCLOSURE_LIMITS],
          activity: seen.map((e) => ({ kind: e.kind, at: e.created_at })),
        },
      });
    }

    const links = await childrenOf(db, req.user!.id);
    const children = [];
    for (const link of links) {
      const controls = await getControls(db, link.child_user_id);
      const [account] = await db.query<{ username: string; display_name: string | null; status: string }>(
        `select username, display_name, status from users where id = $1`, [link.child_user_id],
      );
      const access = await checkChildAccess(db, { userId: link.child_user_id });
      children.push({
        childUserId: link.child_user_id,
        username: account?.username ?? '',
        displayName: account?.display_name ?? null,
        accountStatus: account?.status ?? 'active',
        since: link.created_at,
        controls: controls ? publicControls(controls) : null,
        usedMinutesToday: controls
          ? await minutesUsedToday(db, { childUserId: link.child_user_id, timezone: controls.timezone })
          : 0,
        access: { allowed: access.allowed, reason: access.reason, opensAgain: access.opensAgain ?? null },
      });
    }

    const [mfa] = await db.query<{ mfa_enabled_at: string | null }>(
      `select mfa_enabled_at from users where id = $1`, [req.user!.id],
    );
    return res.json({
      module: { state: status.state },
      role: children.length ? 'parent' : 'none',
      honesty: PARENTAL_HONESTY,
      // Surfaced so the page can say what is missing BEFORE somebody fills in
      // a form they cannot submit. It is not the control — `/authority` checks
      // the same thing and refuses.
      secondFactorReady: !!mfa?.mfa_enabled_at && ctx.masterKey !== false,
      maxChildren: MAX_CHILDREN_PER_PARENT,
      children,
    });
  }));

  // ------------------------------------------------------- proving it is them
  //
  // The password AND the code, in one request. Not two steps that each leave a
  // usable state behind: a "password accepted, now the code" flow means a
  // borrowed session is already half way through.
  r.post('/authority', handle(async (req, res) => {
    await refuseManagedChild(req);
    if (ctx.masterKey === false) {
      throw new RouteError(503, 'This installation cannot check a second factor, so it cannot change who looks after whom.');
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const code = str(req.body?.code, 40).replace(/\s/g, '');

    const [failures] = await db.query<{ n: string }>(
      `select count(*) as n from events
       where kind = 'parental.authority_failed' and actor_user_id = $1
         and created_at > now() - make_interval(secs => $2)
         and created_at > coalesce((
           select max(created_at) from events
           where kind = 'parental.authority_granted' and actor_user_id = $1), 'epoch'::timestamptz)`,
      [req.user!.id, AUTHORITY_LOCKOUT_SECONDS],
    );
    if (Number(failures?.n ?? 0) >= MAX_AUTHORITY_ATTEMPTS) {
      throw new RouteError(429, 'Too many attempts. Wait a few minutes and try again.');
    }

    const [account] = await db.query<{
      password_hash: string | null; totp_secret_enc: string | null; mfa_enabled_at: string | null;
    }>(
      `select password_hash, totp_secret_enc, mfa_enabled_at from users where id = $1`,
      [req.user!.id],
    );
    if (!account?.totp_secret_enc || !account.mfa_enabled_at) {
      // Refused rather than downgraded to a password. Two-factor is the point
      // of this gate, and a gate that quietly accepts one factor when the
      // second is missing is a gate that says something untrue on screen.
      throw new RouteError(409, 'Turn on two-factor authentication for your own account first. '
        + 'Changing who looks after whom needs your password and a code from your authenticator.');
    }

    const failed = async (stage: 'password' | 'code'): Promise<never> => {
      await appendEvent(db, {
        actorUserId: req.user!.id, actor: 'user', kind: 'parental.authority_failed',
        subjectType: 'user', subjectId: req.user!.id, payload: { stage },
      });
      // One sentence for both stages: which of the two was wrong is
      // information an attacker with one of them would like to have.
      throw new RouteError(401, 'That password and code did not match.');
    };

    if (!(await verifyPassword(account.password_hash, password))) await failed('password');

    const secret = openSealed<{ secret: string }>(
      loadMasterKey(ctx.masterKey ?? {}), account.totp_secret_enc,
    ).secret;
    let ok = (await verifyTotp({ secret, token: code, epochTolerance: 30 })).valid;
    if (!ok) {
      // A recovery code is a second factor somebody printed out, and burning
      // one here is the same act as burning one at sign-in.
      const used = await db.query<{ id: string }>(
        `update mfa_recovery_codes set used_at = now()
         where user_id = $1 and code_hash = $2 and used_at is null returning id`,
        [req.user!.id, createHash('sha256').update(code.toUpperCase()).digest('hex')],
      );
      ok = used.length > 0;
    }
    if (!ok) await failed('code');

    const grant = await issueAuthorityGrant(db, {
      userId: req.user!.id, sessionKey: req.user!.session_id,
    });
    return res.json({
      ok: true,
      expiresAt: grant.expiresAt,
      note: 'Confirmed. Use it once, in the next five minutes.',
    });
  }));

  // ------------------------------------------------------------ the relationship
  r.post('/children', handle(async (req, res) => {
    await refuseManagedChild(req);
    const username = str(req.body?.username, 40);
    const email = str(req.body?.email, 320);
    const displayName = str(req.body?.displayName, 80) || null;
    const timezone = str(req.body?.timezone, 60) || 'UTC';
    if (!username || !email) throw new RouteError(400, 'A username and an email address are needed.');

    const existing = await childrenOf(db, req.user!.id);
    if (existing.length >= MAX_CHILDREN_PER_PARENT) {
      throw new RouteError(409, `One account can look after ${MAX_CHILDREN_PER_PARENT} accounts at most.`);
    }

    // Spent BEFORE anything is created, so a failure after this point costs a
    // fresh password and code rather than leaving a spendable grant behind.
    if (!(await consumeAuthorityGrant(db, {
      userId: req.user!.id, sessionKey: req.user!.session_id, purpose: 'create_child',
    }))) {
      throw new RouteError(401, 'Confirm your password and a code from your authenticator first.');
    }

    // ONLY AN ACCOUNT CREATED HERE CAN BE MANAGED. There is deliberately no
    // route that links an existing account: "make this colleague my managed
    // child" is surveillance with a nice name, and the person on the other end
    // of it would never be asked.
    let child;
    try {
      child = await createUser(db, { email, username, displayName, role: 'member' });
    } catch (err) {
      if (err instanceof UserError) throw new RouteError(409, err.message);
      throw err;
    }
    await createLink(db, {
      parentUserId: req.user!.id, childUserId: child.id, actorUserId: req.user!.id, timezone,
    });
    const { token } = await issueAuthToken(db, { userId: child.id, purpose: 'invite' });
    return res.status(201).json({
      child: { childUserId: child.id, username: child.username, displayName: child.display_name },
      // Handed back rather than mailed, exactly as the admin invite is: the
      // parent is standing next to the child, and mail may not be configured.
      inviteLink: `${ctx.appUrl.replace(/\/$/, '')}/set-password?token=${token}`,
      note: 'Set this up on their device. They will be told, on their own Family page, '
        + 'exactly what you can see.',
    });
  }));

  r.delete('/children/:childUserId', handle(async (req, res) => {
    const childUserId = await authorizedChild(req);
    if (!(await consumeAuthorityGrant(db, {
      userId: req.user!.id, sessionKey: req.user!.session_id, purpose: 'end_link',
    }))) {
      throw new RouteError(401, 'Confirm your password and a code from your authenticator first.');
    }
    await endLink(db, { parentUserId: req.user!.id, childUserId, actorUserId: req.user!.id });
    return res.json({
      ok: true,
      note: 'The account stays, and is now an ordinary account here. You can no longer see its '
        + 'conversations, its limits and hours are gone, and the record of when it was being '
        + 'used has been deleted. Nothing it wrote was touched — those conversations are theirs.',
    });
  }));

  // ----------------------------------------------------------------- controls
  r.get('/children/:childUserId/controls', handle(async (req, res) => {
    const childUserId = await authorizedChild(req);
    const controls = await getControls(db, childUserId);
    return res.json({ controls: controls ? publicControls(controls) : null, honesty: PARENTAL_HONESTY });
  }));

  r.put('/children/:childUserId/controls', handle(async (req, res) => {
    const childUserId = await authorizedChild(req);
    await requirePasswordAgain(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const controls = await setControls(db, {
      childUserId,
      actorUserId: req.user!.id,
      timezone: body.timezone === undefined ? undefined : str(body.timezone, 60),
      dailyLimitMinutes: body.dailyLimitMinutes === undefined
        ? undefined
        : (body.dailyLimitMinutes === null ? null : Number(body.dailyLimitMinutes)),
      scheduleEnabled: body.scheduleEnabled === undefined ? undefined : !!body.scheduleEnabled,
      windows: body.windows === undefined ? undefined : normalizeWindows(body.windows),
    });
    return res.json({ controls: controls ? publicControls(controls) : null });
  }));

  // ------------------------------------------------------------ conversations
  //
  // The words, and the fact that somebody read them. Both routes write an
  // audit entry BEFORE answering: an access that fails to be recorded must not
  // be an access that happened.
  r.get('/children/:childUserId/conversations', handle(async (req, res) => {
    const childUserId = await authorizedChild(req);
    const threads = await db.query<{
      id: string; title: string | null; last_activity_at: string; created_at: string; messages: string;
    }>(
      `select t.id, t.title, t.last_activity_at, t.created_at,
              (select count(*) from messages m where m.thread_id = t.id) as messages
       from threads t where t.owner_user_id = $1
       order by t.last_activity_at desc limit 200`,
      [childUserId],
    );
    await appendEvent(db, {
      actorUserId: req.user!.id, actor: 'user', kind: 'parental.conversations_listed',
      subjectType: 'user', subjectId: childUserId,
      payload: { child: childUserId, conversations: threads.length },
    });
    return res.json({
      conversations: threads.map((t) => ({
        id: t.id, title: t.title, lastActivityAt: t.last_activity_at,
        createdAt: t.created_at, messages: Number(t.messages),
      })),
    });
  }));

  r.get('/children/:childUserId/conversations/:threadId', handle(async (req, res) => {
    const childUserId = await authorizedChild(req);
    const threadId = param(req, 'threadId');
    // Ownership re-checked against the CHILD rather than trusted from the URL:
    // a thread id belonging to somebody else must not be readable by naming a
    // child in the path.
    const [thread] = await db.query<{ id: string; title: string | null; created_at: string }>(
      `select id, title, created_at from threads where id = $1 and owner_user_id = $2`,
      [threadId, childUserId],
    );
    if (!thread) throw new RouteError(404, 'not found');
    await appendEvent(db, {
      actorUserId: req.user!.id, actor: 'user', kind: 'parental.conversation_read',
      subjectType: 'thread', subjectId: threadId, payload: { child: childUserId },
    });
    const messages = await listMessages(db, { threadId, limit: 500 });
    return res.json({
      conversation: { id: thread.id, title: thread.title, createdAt: thread.created_at },
      messages: messages.map((m) => ({
        id: m.id, direction: m.direction, channel: m.channel, body: m.body, createdAt: m.created_at,
      })),
      note: 'Your child can see, on their own Family page, that you opened this.',
    });
  }));

  r.get('/children/:childUserId/usage', handle(async (req, res) => {
    const childUserId = await authorizedChild(req);
    const controls = await getControls(db, childUserId);
    const summary = await usageSummary(db, {
      childUserId,
      timezone: controls?.timezone ?? 'UTC',
      days: Number(req.query.days) || 14,
    });
    await appendEvent(db, {
      actorUserId: req.user!.id, actor: 'user', kind: 'parental.usage_viewed',
      subjectType: 'user', subjectId: childUserId, payload: { child: childUserId },
    });
    return res.json({ usage: summary, honesty: PARENTAL_HONESTY });
  }));

  return r;
}

/** The controls a person is shown. A shape rather than a row spread, so a
 * column added later is not published by accident. */
function publicControls(controls: {
  timezone: string; dailyLimitMinutes: number | null; scheduleEnabled: boolean;
  windows: Array<{ weekday: number; startMinute: number; endMinute: number }>; updatedAt: string | null;
}) {
  return {
    timezone: controls.timezone,
    dailyLimitMinutes: controls.dailyLimitMinutes,
    scheduleEnabled: controls.scheduleEnabled,
    windows: controls.windows,
    updatedAt: controls.updatedAt,
  };
}

// ------------------------------------------------------------- the admin side

/**
 * Buying, and nothing else.
 *
 * Every route here is about the LICENCE. None of them reads a table that holds
 * a relationship, a timetable, a minute or a message, and `parentalDataTables`
 * below is the list a test greps this file against — an administrator surface
 * that grew a query into `parental_links` would fail the suite rather than ship.
 */
export function adminParentalRoutes(ctx: ParentalRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireSuperAdmin);

  const describe = async () => {
    const status = await entitlementStatus(db, PARENTAL_MODULE);
    return {
      module: PARENTAL_MODULE,
      state: status.state,
      entitled: status.entitled,
      issuedTo: status.issuedTo,
      licenseId: status.licenseId,
      expiresAt: status.expiresAt,
      activatedAt: status.activatedAt,
      boundToThisInstallation: status.boundToThisInstallation,
      // Whether this artefact can check a licence at all. Said plainly,
      // because "nothing I paste works" is otherwise a support ticket.
      canVerifyLicenses: !!publisherKey(ctx.entitlementPublicKey),
      honesty: PARENTAL_HONESTY,
      note: 'Switching this on gives the people here the ability to look after a child '
        + 'account they create. It gives you nothing: you cannot see who is looking after '
        + 'whom, or read anything a child says to Josi.',
    };
  };

  r.get('/', handle(async (_req, res) => res.json(await describe())));

  r.post('/license', handle(async (req, res) => {
    const token = str(req.body?.license, 4000);
    if (!token) throw new RouteError(400, 'Paste the licence key you were given.');
    const result = await activateEntitlement(db, {
      module: PARENTAL_MODULE,
      token,
      publicKey: publisherKey(ctx.entitlementPublicKey),
      actorUserId: req.user!.id,
    });
    if (!result.ok) throw new RouteError(400, result.message);
    return res.json(await describe());
  }));

  r.delete('/license', handle(async (req, res) => {
    await revokeEntitlement(db, { module: PARENTAL_MODULE, actorUserId: req.user!.id });
    return res.json(await describe());
  }));

  return r;
}
