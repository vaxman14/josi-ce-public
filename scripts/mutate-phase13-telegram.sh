#!/usr/bin/env bash
# Phase 13.1 mutation testing: the Telegram channel.
#
# The mutations are grouped by the property they break, and every one of them is
# an edit somebody could plausibly make while "simplifying" or "fixing" the
# channel: drop the constant-time compare, trust the payload's user, allow
# groups, skip de-duplication, retry a dead chat, escape one character fewer.
set -uo pipefail
cd "$(dirname "$0")/.."

FILES=(
  packages/channels/src/telegram/inbound.ts
  packages/channels/src/telegram/linking.ts
  packages/channels/src/telegram/format.ts
  packages/channels/src/telegram/api.ts
  packages/channels/src/telegram/attachments.ts
  packages/channels/src/telegram/config.ts
  packages/channels/src/telegram/outbound.ts
  apps/api/src/http/telegramRoutes.ts
)

BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do mkdir -p "$BACKUP/$(dirname "$f")"; cp "$f" "$BACKUP/$f"; done
restore() {
  for f in "${FILES[@]}"; do cp "$BACKUP/$f" "$f"; done
  npx tsc -b >/dev/null 2>&1 || true
}
trap 'restore; rm -rf "$BACKUP"; echo; echo "(interrupted — sources restored)"; exit 130' INT TERM
trap 'restore; rm -rf "$BACKUP"' EXIT

run() {
  npx tsc -b >/dev/null 2>&1
  npx vitest run 2>&1 | grep -E "^ +Tests +" | tail -1
}

M_FROM="${M_FROM:-1}"; M_TO="${M_TO:-999}"; N=0
should_run() { N=$((N+1)); [[ $N -ge $M_FROM && $N -le $M_TO ]]; }

assert_mutated() {
  local changed=0
  for f in "${FILES[@]}"; do cmp -s "$BACKUP/$f" "$f" || changed=1; done
  if [[ $changed -eq 0 ]]; then
    echo "  !! MUTATION DID NOT APPLY — result below is meaningless"; return 1
  fi
  return 0
}

echo "=== BASELINE ==="; run
mut() { echo; echo "=== M$N: $1 ==="; }
# Mutations are applied through a QUOTED heredoc, never through a double-quoted
# shell string. The first version of this file used `python3 -c "$1"`, and the
# mutation whose replacement contained a backtick — a JavaScript template
# literal — was read by the shell as command substitution. The script died
# silently at M12 with exit code 0 and eleven of forty-five mutations run, which
# is the worst possible failure for a harness whose whole job is to notice
# things. `<<'MUT'` passes the body through untouched.

# ---------------------------------------------------------------- authenticity

if should_run; then mut "the webhook secret is compared with =="
python3 - <<'MUT'
p='packages/channels/src/telegram/inbound.ts'; s=open(p).read()
s=s.replace('''  if (typeof provided !== 'string' || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);''','''  return provided === expected;''',1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an empty expected secret matches an empty header"
python3 - <<'MUT'
p='packages/channels/src/telegram/inbound.ts'; s=open(p).read()
s=s.replace("  if (typeof provided !== 'string' || !expected) return false;","  if (typeof provided !== 'string') return false;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the webhook answers before checking the header"
python3 - <<'MUT'
p='apps/api/src/http/telegramRoutes.ts'; s=open(p).read()
s=s.replace('''      if (!webhookSecretMatches(provided, expected.reveal())) {''','''      if (false && !webhookSecretMatches(provided, expected.reveal())) {''',1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a rejected webhook answers 403 instead of 404"
python3 - <<'MUT'
p='apps/api/src/http/telegramRoutes.ts'; s=open(p).read()
s=s.replace('''      if (!config.enabled || !config.webhook_secret_enc || !key) {
        res.status(404).json({ error: 'not found' });''','''      if (!config.enabled || !config.webhook_secret_enc || !key) {
        res.status(403).json({ error: 'telegram is disabled' });''',1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# -------------------------------------------------------------------- identity

if should_run; then mut "the payload's from.id selects the account"
python3 - <<'MUT'
p='packages/channels/src/telegram/inbound.ts'; s=open(p).read()
s=s.replace('''    result = await deps.runTurn({ userId: link.user_id, threadId, inbound: text });''','''    result = await deps.runTurn({
      userId: String(message.from?.id ?? link.user_id), threadId, inbound: text,
    });''',1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an unlinked chat is answered instead of refused"
python3 - <<'MUT'
p='packages/channels/src/telegram/inbound.ts'; s=open(p).read()
s=s.replace('''  if (!link) {
    await deps.send({ chatId, kind: 'notice', text: NOT_LINKED_HINT });
    return finish('unlinked');
  }''','''  if (!link) {
    const [any] = await db.query<{ id: string; user_id: string; thread_id: string | null }>(
      `select id, user_id, thread_id from telegram_links where status = 'active' limit 1`,
    );
    if (!any) {
      await deps.send({ chatId, kind: 'notice', text: NOT_LINKED_HINT });
      return finish('unlinked');
    }
    link = any as typeof link;
  }''',1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "resolveChat stops filtering on status"
python3 - <<'MUT'
p='packages/channels/src/telegram/linking.ts'; s=open(p).read()
s=s.replace("`select * from telegram_links where chat_id = $1 and status = 'active'`","`select * from telegram_links where chat_id = $1 order by linked_at desc limit 1`",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "group chats are accepted"
python3 - <<'MUT'
p='packages/channels/src/telegram/inbound.ts'; s=open(p).read()
s=s.replace("  if (message.chat?.type !== 'private') {","  if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# ------------------------------------------------------------------- link code

if should_run; then mut "the code is stored in plaintext"
python3 - <<'MUT'
p='packages/channels/src/telegram/linking.ts'; s=open(p).read()
s=s.replace("export function hashLinkCode(code: string): string {\n  return createHash('sha256').update(code, 'utf8').digest('hex');","export function hashLinkCode(code: string): string {\n  return code;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the code is reusable"
python3 - <<'MUT'
p='packages/channels/src/telegram/linking.ts'; s=open(p).read()
s=s.replace('''     where code_hash = $1
       and used_at is null
       and invalidated_at is null
       and expires_at > now()''','''     where code_hash = $1''',1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "expiry is not checked"
python3 - <<'MUT'
p='packages/channels/src/telegram/linking.ts'; s=open(p).read()
s=s.replace('''       and invalidated_at is null
       and expires_at > now()''','''       and invalidated_at is null''',1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the refusal names the reason, becoming an oracle"
python3 - <<'MUT'
p='packages/channels/src/telegram/linking.ts'; s=open(p).read()
s=s.replace("    throw new LinkError('that link code cannot be used', reason);","    throw new LinkError(`that link code is ${reason}`, reason);",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "minting leaves the previous code alive"
python3 - <<'MUT'
p='packages/channels/src/telegram/linking.ts'; s=open(p).read()
s=s.replace("  await invalidateCodesFor(db, args.userId);\n\n  const code = generateLinkCode();","  const code = generateLinkCode();",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a chat can be taken over by a second account"
python3 - <<'MUT'
p='packages/channels/src/telegram/linking.ts'; s=open(p).read()
s=s.replace("  if (existingLink && existingLink.user_id !== userId) {","  if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "revoking leaves outstanding codes alive"
python3 - <<'MUT'
p='packages/channels/src/telegram/linking.ts'; s=open(p).read()
s=s.replace("  await invalidateCodesFor(db, row.user_id);\n\n  await appendEvent(db, {\n    actorUserId: args.actorUserId,\n    actor: args.asAdmin ? 'super_admin' : 'user',","  await appendEvent(db, {\n    actorUserId: args.actorUserId,\n    actor: args.asAdmin ? 'super_admin' : 'user',",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a member may revoke anybody's link"
python3 - <<'MUT'
p='packages/channels/src/telegram/linking.ts'; s=open(p).read()
s=s.replace("  if (!args.asAdmin && row.user_id !== args.actorUserId) {","  if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# ------------------------------------------------------------------ idempotence

if should_run; then mut "update_id de-duplication is dropped"
python3 - <<'MUT'
p='packages/channels/src/telegram/inbound.ts'; s=open(p).read()
s=s.replace("    if (!claimed.length) return 'ignored';","    void claimed;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# ------------------------------------------------------------------- formatting

if should_run; then mut "one reserved character stops being escaped"
python3 - <<'MUT'
p='packages/channels/src/telegram/format.ts'; s=open(p).read()
s=s.replace("  '{', '}', '.', '!',","  '{', '}', '!',",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a chunk may land inside an escape pair"
python3 - <<'MUT'
p='packages/channels/src/telegram/format.ts'; s=open(p).read()
s=s.replace("    cut = pullBackOffEscape(rest, cut);","    // cut = pullBackOffEscape(rest, cut);",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the escape run is counted as even/odd the wrong way round"
python3 - <<'MUT'
p='packages/channels/src/telegram/format.ts'; s=open(p).read()
s=s.replace("  return backslashes % 2 === 1 ? cut - 1 : cut;","  return backslashes % 2 === 0 ? cut - 1 : cut;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the disclosure becomes optional"
python3 - <<'MUT'
p='packages/channels/src/telegram/format.ts'; s=open(p).read()
s=s.replace('''  if (!disclosure) {
    throw new Error('the AI disclosure is missing — it can be reworded but not removed');
  }''','''  if (!disclosure) return [escapeMarkdownV2(body)];''',1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an empty reply sends a bare disclosure"
python3 - <<'MUT'
p='packages/channels/src/telegram/format.ts'; s=open(p).read()
s=s.replace("  if (!body) return [];","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# ------------------------------------------------------------------- the client

if should_run; then mut "Telegram's description is passed through"
python3 - <<'MUT'
p='packages/channels/src/telegram/api.ts'; s=open(p).read()
s=s.replace("    return new TelegramApiError('malformed', 'Telegram refused the request.');","    return new TelegramApiError('malformed', `Telegram refused the request: ${payload?.description ?? ''}`);",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the envelope's error_code is ignored"
python3 - <<'MUT'
p='packages/channels/src/telegram/api.ts'; s=open(p).read()
s=s.replace("    throw categorise(payload?.error_code ?? res.status, payload);","    throw categorise(res.status, payload);",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an unauthorized token is retried"
python3 - <<'MUT'
p='packages/channels/src/telegram/api.ts'; s=open(p).read()
s=s.replace("    return this.category === 'rate_limited' || this.category === 'network';","    return true;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "retry_after is ignored in favour of our own guess"
python3 - <<'MUT'
p='packages/channels/src/telegram/api.ts'; s=open(p).read()
s=s.replace('''      const asked = err instanceof TelegramApiError && err.retryAfterSeconds !== undefined
        ? err.retryAfterSeconds * 1000
        : base * 2 ** (attempt - 1);''','''      const asked = base * 2 ** (attempt - 1);''',1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a hostile retry_after is not capped"
python3 - <<'MUT'
p='packages/channels/src/telegram/api.ts'; s=open(p).read()
s=s.replace("      await sleep(Math.min(maxDelay, Math.max(0, asked)));","      await sleep(Math.max(0, asked));",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the download trusts Content-Length instead of counting"
python3 - <<'MUT'
p='packages/channels/src/telegram/api.ts'; s=open(p).read()
s=s.replace('''        if (total > maxBytes) {''','''        if (false) {''',1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the download follows a redirect"
python3 - <<'MUT'
p='packages/channels/src/telegram/api.ts'; s=open(p).read()
s=s.replace('''      const res = await this.#fetch(this.#fileEndpoint(filePath), {
        signal: controller.signal,
        redirect: 'error',
      });''','''      const res = await this.#fetch(this.#fileEndpoint(filePath), {
        signal: controller.signal,
        redirect: 'follow',
      });''',1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "link previews are enabled"
python3 - <<'MUT'
p='packages/channels/src/telegram/api.ts'; s=open(p).read()
s=s.replace("      link_preview_options: { is_disabled: args.disableWebPagePreview !== false },","      link_preview_options: { is_disabled: false },",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the webhook accepts every update kind"
python3 - <<'MUT'
p='packages/channels/src/telegram/api.ts'; s=open(p).read()
s=s.replace("      allowed_updates: args.allowedUpdates ?? ['message'],","      allowed_updates: args.allowedUpdates,",1)
s=s.replace("      drop_pending_updates: true,","      drop_pending_updates: false,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# ------------------------------------------------------------------ attachments

if should_run; then mut "the attachment size gate is skipped"
python3 - <<'MUT'
p='packages/channels/src/telegram/attachments.ts'; s=open(p).read()
s=s.replace("  if (declared > policy.maxBytes) {","  if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the allowlist becomes advisory"
python3 - <<'MUT'
p='packages/channels/src/telegram/attachments.ts'; s=open(p).read()
s=s.replace("  if (!ALLOWED.has(extension)) {","  if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a double extension resolves to the first part"
python3 - <<'MUT'
p='packages/channels/src/telegram/attachments.ts'; s=open(p).read()
s=s.replace("  const dot = base.lastIndexOf('.');","  const dot = base.indexOf('.');",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "traversal in a filename is tolerated"
python3 - <<'MUT'
p='packages/channels/src/telegram/attachments.ts'; s=open(p).read()
s=s.replace("  if (isUnsafeName(attachment.fileName)) {","  if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the filename is stored"
python3 - <<'MUT'
p='packages/channels/src/telegram/attachments.ts'; s=open(p).read()
s=s.replace("      args.attachment.mime_type ?? null,","      args.attachment.mime_type ?? null,",1)
s=s.replace("      args.attachment.mimeType ?? null, args.verdict.extension || null, args.verdict.outcome,","      args.attachment.fileName ?? args.attachment.mimeType ?? null, args.verdict.extension || null, args.verdict.outcome,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# ------------------------------------------------------------------- the config

if should_run; then mut "a failed probe stores the token anyway"
python3 - <<'MUT'
p='packages/channels/src/telegram/config.ts'; s=open(p).read()
s=s.replace('''    throw err;
  }

  if (!me.is_bot) {''','''    me = { id: 0, is_bot: true };
  }

  if (!me.is_bot) {''',1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the admin screen is handed the ciphertext"
python3 - <<'MUT'
p='packages/channels/src/telegram/config.ts'; s=open(p).read()
s=s.replace("    tokenSet: !!row.bot_token_enc,","    tokenSet: !!row.bot_token_enc,\n    api_key_enc: row.bot_token_enc,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the token shape is not checked before a request is spent"
python3 - <<'MUT'
p='packages/channels/src/telegram/config.ts'; s=open(p).read()
s=s.replace("  if (!looksLikeBotToken(raw)) {","  if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the channel can be turned on without a passing probe"
python3 - <<'MUT'
p='packages/channels/src/telegram/config.ts'; s=open(p).read()
s=s.replace("    if (row.probe_ok !== true) {","    if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "rotating the token keeps the old webhook secret"
python3 - <<'MUT'
p='packages/channels/src/telegram/config.ts'; s=open(p).read()
s=s.replace('''  const webhookSecret = generateWebhookSecret();''','''  const existing = await loadConfig(db);
  const webhookSecret = existing.webhook_secret_enc
    ? openWebhookSecret(args.masterKey, existing) : generateWebhookSecret();''',1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "removing the bot keeps the token when Telegram is unreachable"
python3 - <<'MUT'
p='packages/channels/src/telegram/config.ts'; s=open(p).read()
s=s.replace('''    } catch {
      webhookDeleted = false;
    }
  }
  await db.query(
    `update telegram_config set enabled = false, bot_token_enc = null''','''    } catch {
      return { webhookDeleted: false };
    }
  }
  await db.query(
    `update telegram_config set enabled = false, bot_token_enc = null''',1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# ----------------------------------------------------------------- the outbound

if should_run; then mut "a blocked chat is left active and retried forever"
python3 - <<'MUT'
p='packages/channels/src/telegram/outbound.ts'; s=open(p).read()
s=s.replace("    if (category === 'blocked_by_user' || category === 'chat_not_found') {","    if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------- the API

if should_run; then mut "the admin link list includes the chat id"
python3 - <<'MUT'
p='apps/api/src/http/telegramRoutes.ts'; s=open(p).read()
s=s.replace('''      const dto = {
        id: row.id,
        owner_user_id: row.user_id,''','''      const dto = {
        id: row.id,
        owner_user_id: row.user_id,
        chatId: (row as unknown as { chat_id?: string }).chat_id ?? null,''',1)
s=s.replace('''      `select id, user_id, status, linked_at, revoked_at, last_inbound_at, last_outbound_at
       from telegram_links order by linked_at desc limit 500`,''','''      `select id, user_id, chat_id, status, linked_at, revoked_at, last_inbound_at, last_outbound_at
       from telegram_links order by linked_at desc limit 500`,''',1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a member may reach the admin routes"
python3 - <<'MUT'
p='apps/api/src/http/telegramRoutes.ts'; s=open(p).read()
s=s.replace("  const r = Router();\n  r.use(requireSuperAdmin);","  const r = Router();\n  r.use(requireAuth);",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a link code can be minted while the channel is off"
python3 - <<'MUT'
p='apps/api/src/http/telegramRoutes.ts'; s=open(p).read()
s=s.replace("    if (!config.enabled) {","    if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "revoking somebody else's link answers 403, confirming it exists"
python3 - <<'MUT'
p='apps/api/src/http/telegramRoutes.ts'; s=open(p).read()
s=s.replace("        const status = err.reason === 'not_yours' || err.reason === 'not_linked' ? 404 : 409;","        const status = err.reason === 'not_yours' ? 403 : 404;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the attachment ceiling may exceed what Telegram serves"
python3 - <<'MUT'
p='apps/api/src/http/telegramRoutes.ts'; s=open(p).read()
s=s.replace("    if (maxBytes !== null && maxBytes > 20 * 1024 * 1024) {","    if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

echo
echo "=== DONE (restoring sources) ==="
