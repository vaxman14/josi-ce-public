// The installation's bot: setting it up, proving it works, taking it away.
//
// Everything here is super-admin territory, and the shape follows Phase 4's
// provider configuration for a reason — the operator supplies a credential,
// CE proves it against the provider before trusting it, and what comes back
// from the probe is stored rather than what the human believed.
//
// TWO SECRETS, NOT ONE, and they are unrelated on purpose:
//
//   * the BOT TOKEN authenticates CE to Telegram
//   * the WEBHOOK SECRET authenticates Telegram to CE
//
// Reusing one for both would mean the value that proves an inbound delivery is
// genuine is the same value that lets its holder send as the bot. They are
// generated separately, sealed separately, and only ever compared in constant
// time.
import {
  Secret, appendEvent, asSecret, openSealed, seal, type Db, type MasterKey,
} from '@josi-ce/core';
import { randomBytes } from 'node:crypto';
import { TelegramApiError, TelegramBotApi, type TelegramErrorCategory } from './api.js';

export class TelegramConfigError extends Error {
  constructor(message: string, readonly category: TelegramErrorCategory | 'no_master_key' | 'not_configured' = 'malformed') {
    super(message);
  }
}

export interface TelegramConfigRow {
  enabled: boolean;
  bot_token_enc: string | null;
  bot_id: string | null;
  bot_username: string | null;
  webhook_secret_enc: string | null;
  webhook_url: string | null;
  webhook_set_at: string | null;
  probed_at: string | null;
  probe_ok: boolean | null;
  probe_error: string | null;
  attachments_enabled: boolean;
  max_attachment_bytes: string | number;
}

export async function loadConfig(db: Db): Promise<TelegramConfigRow> {
  const [row] = await db.query<TelegramConfigRow>(
    `select enabled, bot_token_enc, bot_id, bot_username, webhook_secret_enc, webhook_url,
            webhook_set_at, probed_at, probe_ok, probe_error, attachments_enabled,
            max_attachment_bytes
     from telegram_config where id = true`,
  );
  return row;
}

/**
 * What the admin screen is allowed to see.
 *
 * No ciphertext. Phase 4's M18 and Phase 7 both shipped a version of this
 * mistake — handing an administrator a sealed credential because it "is not
 * plaintext" — and both times the answer was the same: ciphertext is still a
 * credential, and a boolean answers every legitimate question. So the token is
 * reported as `tokenSet: true` and the webhook secret is not reported at all.
 */
export function describeConfig(row: TelegramConfigRow): {
  enabled: boolean;
  tokenSet: boolean;
  botUsername: string | null;
  botId: string | null;
  webhookUrl: string | null;
  webhookSetAt: string | null;
  probedAt: string | null;
  probeOk: boolean | null;
  probeError: string | null;
  attachmentsEnabled: boolean;
  maxAttachmentBytes: number;
} {
  return {
    enabled: row.enabled,
    tokenSet: !!row.bot_token_enc,
    botUsername: row.bot_username,
    botId: row.bot_id,
    webhookUrl: row.webhook_url,
    webhookSetAt: row.webhook_set_at,
    probedAt: row.probed_at,
    probeOk: row.probe_ok,
    probeError: row.probe_error,
    attachmentsEnabled: row.attachments_enabled,
    maxAttachmentBytes: Number(row.max_attachment_bytes),
  };
}

/** BotFather's format: `<digits>:<35-ish url-safe characters>`.
 *
 * Checked before the token is sealed and before a request is spent, so a
 * pasted-with-a-newline token fails with "that is not the shape of a token"
 * rather than with Telegram's 401 — which reads as "your bot is broken". */
export function looksLikeBotToken(value: string): boolean {
  return /^\d{5,16}:[A-Za-z0-9_-]{30,}$/.test(value);
}

export function openToken(masterKey: MasterKey | null, row: TelegramConfigRow): Secret {
  if (!row.bot_token_enc) {
    throw new TelegramConfigError('no Telegram bot token is configured', 'not_configured');
  }
  if (!masterKey) {
    throw new TelegramConfigError(
      'the installation master key is unavailable, so the stored bot token cannot be opened',
      'no_master_key',
    );
  }
  return asSecret(openSealed<{ token: string }>(masterKey, row.bot_token_enc).token);
}

export function openWebhookSecret(masterKey: MasterKey | null, row: TelegramConfigRow): Secret {
  if (!row.webhook_secret_enc) {
    throw new TelegramConfigError('no webhook secret is configured', 'not_configured');
  }
  if (!masterKey) {
    throw new TelegramConfigError(
      'the installation master key is unavailable, so the webhook secret cannot be opened',
      'no_master_key',
    );
  }
  return asSecret(openSealed<{ secret: string }>(masterKey, row.webhook_secret_enc).secret);
}

/**
 * Store a token, prove it, and record what the provider said.
 *
 * The order matters: the token is PROVEN before it is stored. A token that
 * fails `getMe` never reaches the database, so an administrator cannot end up
 * with a configuration row that looks set and is not — the state Phase 4's
 * `activated_at` exists to prevent, applied here as "nothing is written on
 * failure" because there is nothing worth keeping.
 *
 * The webhook secret is minted here too, and only here. There is no route that
 * accepts one from a request body: a secret an administrator can choose is a
 * secret an administrator can choose badly.
 */
export async function setBotToken(
  db: Db,
  args: {
    masterKey: MasterKey | null;
    token: Secret;
    actorUserId: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<{ botId: number; botUsername: string | null }> {
  if (!args.masterKey) {
    throw new TelegramConfigError(
      'the installation master key is unavailable, so a bot token cannot be stored',
      'no_master_key',
    );
  }
  const raw = args.token.reveal();
  if (!looksLikeBotToken(raw)) {
    throw new TelegramConfigError(
      'that does not look like a bot token from BotFather (it should be digits, a colon, then a long code)',
    );
  }

  const api = new TelegramBotApi({
    token: args.token, fetchImpl: args.fetchImpl, timeoutMs: args.timeoutMs,
  });

  let me: Awaited<ReturnType<TelegramBotApi['getMe']>>;
  try {
    me = await api.getMe();
  } catch (err) {
    const category = err instanceof TelegramApiError ? err.category : 'unknown';
    // The failure is recorded so the admin screen can show it, but the token is
    // NOT stored. A probe row without a credential is honest; a credential
    // stored because it might work later is how a bot silently never runs.
    await db.query(
      `update telegram_config
       set probed_at = now(), probe_ok = false, probe_error = $1
       where id = true`,
      [probeErrorFor(category)],
    );
    await appendEvent(db, {
      actorUserId: args.actorUserId,
      actor: 'super_admin',
      kind: 'telegram.token_rejected',
      subjectType: 'telegram_config',
      payload: { category },
    });
    throw err;
  }

  if (!me.is_bot) {
    throw new TelegramConfigError('that token belongs to a user account, not a bot');
  }

  // A fresh webhook secret every time the token changes. If the token was
  // rotated because it leaked, the value that authenticates inbound deliveries
  // should not be the one that was in place while it was leaking.
  const webhookSecret = generateWebhookSecret();

  await db.query(
    `update telegram_config set
       bot_token_enc = $1,
       webhook_secret_enc = $2,
       bot_id = $3,
       bot_username = $4,
       probed_at = now(),
       probe_ok = true,
       probe_error = null,
       -- Changing the token invalidates any registration made with the old one.
       webhook_url = null,
       webhook_set_at = null,
       -- Never auto-enable. Setting a token is one decision and turning the
       -- channel on is another, and the second one deserves its own click.
       enabled = false
     where id = true`,
    [
      seal(args.masterKey, { token: args.token }),
      seal(args.masterKey, { secret: webhookSecret }),
      String(me.id),
      me.username ?? null,
    ],
  );

  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'telegram.token_set',
    subjectType: 'telegram_config',
    // The bot's own id and public @username are the bot's public identity, not
    // anybody's content. The token is not here and cannot be: `appendEvent`
    // refuses a payload key named `token`.
    payload: { botId: String(me.id), botUsername: me.username ?? null },
  });

  return { botId: me.id, botUsername: me.username ?? null };
}

/** 32 bytes, url-safe, well inside Telegram's 1–256 character allowance for
 * the secret token header. Generated, never chosen. */
export function generateWebhookSecret(): Secret {
  return asSecret(randomBytes(32).toString('base64url'));
}

function probeErrorFor(category: string): string {
  switch (category) {
    case 'unauthorized': return 'unauthorized';
    case 'network': return 'network';
    case 'rate_limited': return 'rate_limited';
    case 'malformed': return 'malformed';
    default: return 'unknown';
  }
}

/** Re-probe an already stored token, for the admin screen's "test" button. */
export async function probeBot(
  db: Db,
  args: { masterKey: MasterKey | null; actorUserId: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ ok: boolean; botUsername: string | null; category?: string }> {
  const row = await loadConfig(db);
  const token = openToken(args.masterKey, row);
  const api = new TelegramBotApi({ token, fetchImpl: args.fetchImpl, timeoutMs: args.timeoutMs });
  try {
    const me = await api.getMe();
    await db.query(
      `update telegram_config set probed_at = now(), probe_ok = true, probe_error = null,
              bot_id = $1, bot_username = $2
       where id = true`,
      [String(me.id), me.username ?? null],
    );
    await appendEvent(db, {
      actorUserId: args.actorUserId, actor: 'super_admin', kind: 'telegram.probed',
      subjectType: 'telegram_config', payload: { ok: true },
    });
    return { ok: true, botUsername: me.username ?? null };
  } catch (err) {
    const category = err instanceof TelegramApiError ? err.category : 'unknown';
    await db.query(
      `update telegram_config set probed_at = now(), probe_ok = false, probe_error = $1 where id = true`,
      [probeErrorFor(category)],
    );
    await appendEvent(db, {
      actorUserId: args.actorUserId, actor: 'super_admin', kind: 'telegram.probed',
      subjectType: 'telegram_config', payload: { ok: false, category },
    });
    return { ok: false, botUsername: row.bot_username, category };
  }
}

/**
 * Turn the channel on or off.
 *
 * Enabling requires a successful probe, checked here rather than trusted from
 * the UI. Disabling is unconditional and immediate — an operator switching this
 * off is usually doing it because something is wrong, and a disable that can
 * fail is a disable that does not work when it is needed.
 */
export async function setEnabled(
  db: Db,
  args: { enabled: boolean; actorUserId: string },
): Promise<void> {
  if (args.enabled) {
    const row = await loadConfig(db);
    if (!row.bot_token_enc) {
      throw new TelegramConfigError('set a bot token before turning the channel on', 'not_configured');
    }
    if (row.probe_ok !== true) {
      throw new TelegramConfigError('the bot token has not passed a test yet', 'unauthorized');
    }
  }
  await db.query(`update telegram_config set enabled = $1 where id = true`, [args.enabled]);
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: args.enabled ? 'telegram.enabled' : 'telegram.disabled',
    subjectType: 'telegram_config',
  });
}

/**
 * Forget the bot entirely.
 *
 * Deletes the webhook at Telegram on a best-effort basis and clears the row
 * regardless. The order is deliberate: if the remote call fails, the local
 * credential is still removed, because "we could not tell Telegram to stop"
 * must not leave a usable token in the database.
 */
export async function removeBot(
  db: Db,
  args: { masterKey: MasterKey | null; actorUserId: string; fetchImpl?: typeof fetch },
): Promise<{ webhookDeleted: boolean }> {
  const row = await loadConfig(db);
  let webhookDeleted = false;
  if (row.bot_token_enc && args.masterKey) {
    try {
      const api = new TelegramBotApi({
        token: openToken(args.masterKey, row), fetchImpl: args.fetchImpl,
      });
      await api.deleteWebhook();
      webhookDeleted = true;
    } catch {
      webhookDeleted = false;
    }
  }
  await db.query(
    `update telegram_config set enabled = false, bot_token_enc = null, webhook_secret_enc = null,
            bot_id = null, bot_username = null, webhook_url = null, webhook_set_at = null,
            probed_at = null, probe_ok = null, probe_error = null
     where id = true`,
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId, actor: 'super_admin', kind: 'telegram.removed',
    subjectType: 'telegram_config', payload: { webhookDeleted },
  });
  return { webhookDeleted };
}

/** Registers the webhook. The URL must be this installation's own public
 * origin over HTTPS — Telegram refuses plain HTTP anyway, and checking here
 * turns a confusing remote rejection into a local sentence. */
export async function registerWebhook(
  db: Db,
  args: { masterKey: MasterKey | null; appUrl: string; actorUserId: string; fetchImpl?: typeof fetch },
): Promise<{ url: string }> {
  const row = await loadConfig(db);
  const token = openToken(args.masterKey, row);
  const secret = openWebhookSecret(args.masterKey, row);

  let base: URL;
  try {
    base = new URL(args.appUrl);
  } catch {
    throw new TelegramConfigError('this installation has no valid public address configured');
  }
  if (base.protocol !== 'https:') {
    throw new TelegramConfigError(
      'Telegram only delivers to HTTPS, so this installation needs a public HTTPS address first',
    );
  }
  const url = new URL(TELEGRAM_WEBHOOK_PATH, base).toString();

  const api = new TelegramBotApi({ token, fetchImpl: args.fetchImpl });
  await api.setWebhook({ url, secretToken: secret });

  await db.query(
    `update telegram_config set webhook_url = $1, webhook_set_at = now() where id = true`, [url],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId, actor: 'super_admin', kind: 'telegram.webhook_set',
    subjectType: 'telegram_config',
    // The path is fixed and public; the host is the installation's own address,
    // which the administrator configured and can see in their browser.
    payload: { host: base.host },
  });
  return { url };
}

/** Fixed, and mounted outside `/api` so it misses CSRF and the setup gate by
 * construction rather than by an exemption somebody could copy. */
export const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';
