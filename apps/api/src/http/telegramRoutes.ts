// Telegram over HTTP: the user's linking surface, the admin's plumbing, and
// the webhook.
//
// THREE ROUTERS, AND THE SPLIT IS THE ACCESS CONTROL
//
//   telegramRoutes       — a signed-in member. Mints a code, sees and revokes
//                          THEIR OWN links. Nothing else.
//   adminTelegramRoutes  — super admin. Token, probe, webhook, enable, and the
//                          power to revoke anybody's link. No content, ever.
//   telegramWebhook      — nobody. Unauthenticated by definition, so it is
//                          mounted OUTSIDE `/api` and authenticates itself on
//                          the secret header instead of a session.
//
// The third one is why the split matters. Mounting the webhook inside `/api`
// would put it behind `requireCsrf` and the setup gate, and the only way to
// make it work there would be an exemption — a named hole in two controls that
// a later route could copy by accident. Outside the router it needs no
// exemption, because it was never inside.
import { Router, type Express, type Request, type Response } from 'express';
import {
  Secret, appendEvent, asSecret, type Db, type MasterKey, type LoadOptions,
} from '@josi-ce/core';
import {
  LinkError, TelegramApiError, TelegramBotApi, TelegramConfigError,
  describeConfig, handleUpdate, historyFor, listLinksFor, loadConfig, mintLinkCode,
  openToken, openWebhookSecret, probeBot, registerWebhook, removeBot, revokeLink,
  sendChunk, setBotToken, setEnabled, threadFor, webhookSecretMatches,
  type RetryOptions, type TelegramUpdate,
} from '@josi-ce/channels';
import { mailPolicy } from '@josi-ce/mail';
import { runAssistantTurn } from '@josi-ce/agent';
import { loadMasterKey } from '@josi-ce/core';
import { requireAuth, requireSuperAdmin, assertMetadataOnly } from './authz.js';
import { asyncRoute, param } from './async.js';

export interface TelegramRoutesCtx {
  db: Db;
  /** How the master key is found, or `false` in tests that do not need one. */
  masterKey?: LoadOptions | false;
  /** Injected by tests. No suite ever contacts api.telegram.org. */
  fetchImpl?: typeof fetch;
  /** This installation's public address, for webhook registration. */
  appUrl: string;
  /** Provider HTTP/DNS for the model call a turn makes. */
  llmFetch?: typeof fetch;
  llmResolve?: (hostname: string) => Promise<string[]>;
  /** HTTP for connected-provider (Gmail, Graph…) calls a turn's data tools
   * make. Injected by tests; unset in production. */
  connectorFetch?: typeof fetch;
  /** Short retries in tests so a backoff assertion does not take 30 seconds. */
  retry?: RetryOptions;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return asyncRoute(async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err: unknown) {
      if (err instanceof RouteError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      if (err instanceof LinkError) {
        // 'not_yours' is a 404 for the reason requireOwnership gives: a 403
        // would confirm that somebody else has a link with that id.
        const status = err.reason === 'not_yours' || err.reason === 'not_linked' ? 404 : 409;
        res.status(status).json({ error: err.message });
        return;
      }
      if (err instanceof TelegramConfigError) {
        res.status(err.category === 'no_master_key' ? 503 : 400)
          .json({ error: err.message, category: err.category });
        return;
      }
      if (err instanceof TelegramApiError) {
        // A category and one of our sentences. Never Telegram's description —
        // some failure modes echo the request, and the request URL is the token.
        res.status(err.category === 'unauthorized' ? 400 : 502)
          .json({ error: err.message, category: err.category });
        return;
      }
      throw err;
    }
  });
}

/** Resolves the master key the same way the rest of the API does. */
function masterKeyOf(ctx: TelegramRoutesCtx): MasterKey | null {
  if (ctx.masterKey === false) return null;
  try {
    return loadMasterKey(ctx.masterKey ?? undefined);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the member

export function telegramRoutes(ctx: TelegramRoutesCtx): Router {
  const { db } = ctx;
  const r = Router();
  r.use(requireAuth);

  /** What this person needs to decide what to do next. Notably it includes
   * whether the CHANNEL is on, because "I minted a code and nothing happened"
   * is otherwise unanswerable from the user's side. */
  r.get('/', handle(async (req, res) => {
    const config = await loadConfig(db);
    const links = await listLinksFor(db, req.user!.id);
    return res.json({
      channel: {
        enabled: config.enabled,
        configured: !!config.bot_token_enc,
        botUsername: config.bot_username,
        attachmentsEnabled: config.attachments_enabled,
      },
      links: links.map(publicLink),
    });
  }));

  r.post('/link-code', handle(async (req, res) => {
    const config = await loadConfig(db);
    if (!config.enabled) {
      throw new RouteError(409, 'Telegram is not turned on for this installation yet.');
    }
    const minted = await mintLinkCode(db, {
      userId: req.user!.id,
      botUsername: config.bot_username,
    });
    // Returned exactly once, to the session that asked. Nothing reads it back:
    // the database has only the hash.
    return res.status(201).json({
      code: minted.code,
      deepLink: minted.deepLink,
      expiresAt: minted.expiresAt,
    });
  }));

  r.delete('/links/:id', handle(async (req, res) => {
    await revokeLink(db, { linkId: param(req, 'id'), actorUserId: req.user!.id });
    return res.json({ revoked: true });
  }));

  return r;
}

/** A link as its owner may see it. The chat id is theirs and identifies their
 * own Telegram account to them, so it is not withheld from the owner — but see
 * `adminLink` below, where it is. */
function publicLink(row: {
  id: string; chat_id: string; telegram_username: string | null; status: string;
  linked_at: string; revoked_at: string | null; last_inbound_at: string | null;
}) {
  return {
    id: row.id,
    chatId: String(row.chat_id),
    telegramUsername: row.telegram_username,
    status: row.status,
    linkedAt: row.linked_at,
    revokedAt: row.revoked_at,
    lastInboundAt: row.last_inbound_at,
  };
}

// ----------------------------------------------------------------- the admin

export function adminTelegramRoutes(ctx: TelegramRoutesCtx): Router {
  const { db } = ctx;
  const r = Router();
  r.use(requireSuperAdmin);

  r.get('/', handle(async (_req, res) => {
    const dto = describeConfig(await loadConfig(db));
    // Belt and braces. `describeConfig` already omits every credential; this
    // throws if a future edit spreads the row instead.
    assertMetadataOnly(dto as unknown as Record<string, unknown>);
    return res.json({ telegram: dto });
  }));

  r.post('/token', handle(async (req, res) => {
    const token = asSecret(req.body?.token);
    if (token.isEmpty) throw new RouteError(400, 'paste the token BotFather gave you');
    const result = await setBotToken(db, {
      masterKey: masterKeyOf(ctx),
      token,
      actorUserId: req.user!.id,
      fetchImpl: ctx.fetchImpl,
    });
    return res.status(201).json({
      botId: String(result.botId), botUsername: result.botUsername, enabled: false,
    });
  }));

  r.post('/probe', handle(async (req, res) => {
    const result = await probeBot(db, {
      masterKey: masterKeyOf(ctx), actorUserId: req.user!.id, fetchImpl: ctx.fetchImpl,
    });
    return res.json(result);
  }));

  r.post('/webhook', handle(async (req, res) => {
    const result = await registerWebhook(db, {
      masterKey: masterKeyOf(ctx),
      appUrl: ctx.appUrl,
      actorUserId: req.user!.id,
      fetchImpl: ctx.fetchImpl,
    });
    return res.json(result);
  }));

  r.post('/enabled', handle(async (req, res) => {
    const enabled = req.body?.enabled === true;
    await setEnabled(db, { enabled, actorUserId: req.user!.id });
    return res.json({ enabled });
  }));

  r.post('/attachments', handle(async (req, res) => {
    const enabled = req.body?.enabled === true;
    const raw = Number(req.body?.maxBytes);
    const maxBytes = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
    if (maxBytes !== null && maxBytes > 20 * 1024 * 1024) {
      throw new RouteError(400, 'Telegram will not serve a file larger than 20 MB');
    }
    await db.query(
      `update telegram_config set attachments_enabled = $1,
              max_attachment_bytes = coalesce($2, max_attachment_bytes)
       where id = true`,
      [enabled, maxBytes],
    );
    await appendEvent(db, {
      actorUserId: req.user!.id, actor: 'super_admin', kind: 'telegram.attachments_policy',
      subjectType: 'telegram_config', payload: { enabled, maxBytes },
    });
    return res.json({ enabled, maxBytes });
  }));

  r.delete('/', handle(async (req, res) => {
    const result = await removeBot(db, {
      masterKey: masterKeyOf(ctx), actorUserId: req.user!.id, fetchImpl: ctx.fetchImpl,
    });
    return res.json(result);
  }));

  /**
   * Connection health, and nothing else.
   *
   * M30's rule for connectors applies unchanged: an administrator sees that a
   * link exists, whose it is, and whether it is working. They do not see the
   * chat id — knowing it would let an administrator who also holds the bot
   * token message a colleague's private Telegram AS Josi, which is a channel
   * into somebody's phone that nobody asked for.
   */
  r.get('/links', handle(async (_req, res) => {
    const rows = await db.query<{
      id: string; user_id: string; status: string; linked_at: string;
      revoked_at: string | null; last_inbound_at: string | null; last_outbound_at: string | null;
    }>(
      `select id, user_id, status, linked_at, revoked_at, last_inbound_at, last_outbound_at
       from telegram_links order by linked_at desc limit 500`,
    );
    const links = rows.map((row) => {
      const dto = {
        id: row.id,
        owner_user_id: row.user_id,
        status: row.status,
        linked_at: row.linked_at,
        revoked_at: row.revoked_at,
        last_inbound_at: row.last_inbound_at,
        last_outbound_at: row.last_outbound_at,
      };
      assertMetadataOnly(dto);
      return dto;
    });
    return res.json({ links });
  }));

  r.delete('/links/:id', handle(async (req, res) => {
    await revokeLink(db, {
      linkId: param(req, 'id'), actorUserId: req.user!.id, asAdmin: true,
    });
    return res.json({ revoked: true });
  }));

  /** Delivery health: counts and categories. No chat ids, no text. */
  r.get('/health', handle(async (_req, res) => {
    const [outbound] = await db.query<{ sent: number; failed: number; pending: number }>(
      `select count(*) filter (where state = 'sent')::int as sent,
              count(*) filter (where state = 'failed')::int as failed,
              count(*) filter (where state = 'pending')::int as pending
       from telegram_outbound where created_at > now() - interval '7 days'`,
    );
    const inbound = await db.query<{ outcome: string; n: number }>(
      `select outcome, count(*)::int as n from telegram_updates
       where received_at > now() - interval '7 days' group by outcome`,
    );
    const errors = await db.query<{ error_category: string; n: number }>(
      `select error_category, count(*)::int as n from telegram_outbound
       where error_category is not null and created_at > now() - interval '7 days'
       group by error_category order by n desc`,
    );
    return res.json({
      outbound: outbound ?? { sent: 0, failed: 0, pending: 0 },
      inbound: Object.fromEntries(inbound.map((i) => [i.outcome, i.n])),
      errors: errors.map((e) => ({ category: e.error_category, count: e.n })),
    });
  }));

  return r;
}

// --------------------------------------------------------------- the webhook

/**
 * Mounts the unauthenticated webhook on the app root.
 *
 * Everything about this handler is written on the assumption that the caller is
 * hostile until the secret header says otherwise, and that the caller is
 * Telegram's retrying delivery machine after that.
 *
 * IT ALWAYS ANSWERS 200 once the secret matched. Telegram redelivers on any
 * non-2xx, so returning 500 on a failure this installation cannot recover from
 * turns one bad message into an indefinite retry loop against the model cap.
 * The outcome is recorded in `telegram_updates` instead, where an administrator
 * can see it.
 */
export function mountTelegramWebhook(app: Express, ctx: TelegramRoutesCtx): void {
  const { db } = ctx;

  app.post(
    '/telegram/webhook',
    asyncRoute(async (req: Request, res: Response) => {
      // No cache, no referrer, and no hint that this endpoint is interesting.
      res.set('Cache-Control', 'no-store');

      const config = await loadConfig(db);
      const key = masterKeyOf(ctx);

      // A channel that is off does not have a webhook. Answering 404 rather
      // than 403 keeps a disabled installation indistinguishable from one that
      // never had Telegram at all.
      if (!config.enabled || !config.webhook_secret_enc || !key) {
        res.status(404).json({ error: 'not found' });
        return;
      }

      let expected: Secret;
      try {
        expected = openWebhookSecret(key, config);
      } catch {
        res.status(404).json({ error: 'not found' });
        return;
      }

      const provided = req.get('x-telegram-bot-api-secret-token');
      if (!webhookSecretMatches(provided, expected.reveal())) {
        // Recorded, because a run of these is somebody probing. No body is
        // read, no update id is claimed, nothing is parsed for meaning.
        await appendEvent(db, {
          actor: 'system',
          kind: 'telegram.webhook_rejected',
          subjectType: 'telegram_config',
          payload: { hadHeader: typeof provided === 'string' },
        });
        res.status(404).json({ error: 'not found' });
        return;
      }

      const update = (req.body ?? {}) as TelegramUpdate;
      const api = new TelegramBotApi({
        token: openToken(key, config), fetchImpl: ctx.fetchImpl,
      });
      const policy = await mailPolicy(db);

      try {
        const outcome = await handleUpdate(
          {
            db,
            disclosure: policy.disclosure.replace('{user}', 'you'),
            botUsername: config.bot_username,
            attachments: {
              enabled: config.attachments_enabled,
              maxBytes: Number(config.max_attachment_bytes),
            },
            send: async (args) => {
              await sendChunk(
                { db, api, retry: ctx.retry },
                { chatId: args.chatId, text: args.text, kind: args.kind },
              );
            },
            runTurn: async (args) => {
              const result = await runAssistantTurn({
                db,
                registry: {
                  db, masterKey: key, fetchImpl: ctx.llmFetch, resolve: ctx.llmResolve,
                },
                userId: args.userId,
                threadId: args.threadId,
                history: await historyFor(db, args.threadId),
                inbound: args.inbound,
                connectorFetch: ctx.connectorFetch,
                channel: 'telegram',
                // The step-up scope is the THREAD, not a session — there is no
                // session here. A person cannot re-authenticate over Telegram,
                // so anything needing step-up is refused with the message the
                // agent produces, which tells them to use the web app.
                sessionKey: args.threadId,
              });
              return { reply: result.reply, refusal: result.refusal, actions: result.actions, retry: result.retry,
                mediaRequest: result.mediaRequest, mediaResult: result.mediaResult };
            },
          },
          update,
        );
        res.status(200).json({ ok: true, outcome });
      } catch (err) {
        // Last resort. The outcome is already recorded by handleUpdate for
        // every path it controls; this catches the ones it does not, and still
        // answers 200 so Telegram stops.
        console.error('telegram webhook failed', (err as Error).message);
        res.status(200).json({ ok: true, outcome: 'failed' });
      }
    }),
  );
}

/** Exported so a test can prove the thread resolution is per-link without
 * driving a whole webhook delivery. */
export { threadFor };
