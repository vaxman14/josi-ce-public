# Telegram

Josi CE can be reached from Telegram. This is the first channel that is not the
web app, and it exists because the honest answer to "can I use Josi on my
phone?" was *Coming soon* for the whole of 0.1.

## What it is, and what it is not

**It is your own bot talking to your own server.** You create a bot in
Telegram's BotFather, paste its token into Josi, and Telegram delivers messages
straight to your installation over HTTPS. There is no Josi-operated relay, no
shared bot, and nowhere in the product to configure one.

**It is not a second inbox.** A Telegram message becomes a message in one of
your own conversations, owned by you, private to you unless you share it,
covered by the same backup, export, retention and audit rules as everything
else you say to Josi.

**It is not group chat.** Josi refuses any chat that is not a one-to-one
private chat, and there is no setting to change that. A group has no single
owner, so routing a group message to one person's assistant would let everybody
else in the group speak as them.

**Your administrator cannot read it.** They can see that a link exists, when it
was made, when it was last used, and they can revoke it. The admin screens do
not receive message text and do not receive your chat identifier.

---

## For the administrator

### 1. Create the bot

In Telegram, message [@BotFather](https://t.me/BotFather):

```
/newbot
```

Give it a name and a username. BotFather answers with a token that looks like
`123456789:AAH...`. **That token is a credential.** Anyone holding it can send
messages as your assistant to everyone who has linked, and read everything sent
to it. Treat it like a password.

While you are there, two settings worth changing:

```
/setprivacy    → Enable    (the bot only sees messages addressed to it)
/setjoingroups → Disable   (the bot cannot be added to groups at all)
```

Josi refuses group chats regardless, but turning it off at Telegram means the
refusal never has to happen.

### 2. Give Josi the token

**Admin → Telegram → Bot token from BotFather → Save and test.**

Josi calls Telegram's `getMe` before it stores anything. A token that fails is
not saved — you get the reason and the installation is left as it was, rather
than holding a credential that will silently never work.

The token is encrypted with the installation master key before it reaches the
database. It is never shown again, and no screen or API response returns it or
its ciphertext.

### 3. Register the webhook

**Admin → Telegram → Register the webhook.**

This needs your installation to already be reachable at a public HTTPS address —
Telegram will not deliver to plain HTTP, and will not deliver to a name it
cannot resolve. The address Josi registers is the `APP_URL` from your `.env`,
with `/telegram/webhook` on the end.

Josi generates a 32-byte secret and gives it to Telegram. Telegram sends it back
on every delivery in the `X-Telegram-Bot-Api-Secret-Token` header, and that
header is the only thing distinguishing a real delivery from anybody on the
internet POSTing to a URL they guessed. Anything without it gets a 404.

If you change your domain, register the webhook again. If you replace the token,
Josi mints a **new** webhook secret and clears the old registration — you have
to register again, deliberately, because the value that authenticated inbound
deliveries while the old token was in use should not survive it.

### 4. Turn it on

**Admin → Telegram → Turn on.** Josi refuses to enable a channel whose token has
not passed a test.

Setting a token does not turn the channel on. Those are two decisions and each
gets its own click.

### 5. Files (optional)

Off by default. **Admin → Telegram → Files → Accept files** turns it on, with a
ceiling you set. Telegram will not serve a file larger than 20 MB whatever you
choose, so that is the hard maximum.

Accepted: `txt`, `md`, `csv`, `tsv`, `json`, `pdf`, `png`, `jpg`, `jpeg`,
`webp`, `heic`, `docx`, `xlsx`, `pptx`. Everything else is refused with a reason
the sender can read.

> **Note on what happens next.** As of Phase 13.1, an accepted file is recorded
> and acknowledged; the document pipeline that parses and indexes it is Phase
> 13.5 and is not built yet. Turning files on today means Josi accepts them and
> tells the sender it cannot read them yet — which is the honest state, and is
> why the setting is off by default.

### Revoking somebody's link

**Admin → Telegram → Linked accounts → Revoke.** Effective on the next message,
because every inbound update resolves the chat through a query that filters on
`status = 'active'`.

Revoking also invalidates any outstanding link code that person holds, so they
cannot re-link by tapping an old message.

### Health

**Admin → Telegram → Delivery health** shows counts for the last seven days:
messages sent, failed, accepted, refused, and how many arrived from chats that
were not linked. Failures are grouped by category. There is no message text
anywhere on that screen and no way to reach any.

---

## For the person using it

**Settings → Telegram → Create a link.**

Josi gives you a `t.me/...` link that opens Telegram with a one-time code
already filled in. Tap it, send the message it prepares, and the chat is linked.

The code:

- works **once**
- expires after **15 minutes**
- is shown **once** — reload the page and it is gone, because a code you can
  come back to is a code somebody else can come back to
- stops working the moment you create another one, or unlink

If you would rather type it, send `/start <code>` to the bot yourself.

### In the chat

- Send a message, get an answer. It is the same assistant, with the same
  personality and the same memory as the web app, because it is the same
  conversation.
- Every reply carries the AI disclosure your administrator configured. The
  wording is theirs to change; its presence is not.
- `/help` — what this chat can do.
- `/unlink` — disconnect this chat. Works from inside Telegram, which matters
  if you have lost access to the browser.

### Things that will not work, and why

| What | Why |
|---|---|
| Voice notes, video, stickers | Josi cannot read them. It says so rather than going quiet. |
| Group chats | No single owner, so no single account to route to. |
| Anything needing you to re-enter your password | There is no session in Telegram to step up. Josi tells you to use the browser. |
| Messages from a second Telegram account | A chat belongs to exactly one Josi account. Unlink first. |

---

## Troubleshooting

**"Telegram is not turned on"** on the Settings page — the administrator has not
configured a bot, or has not enabled the channel.

**The link opens Telegram but nothing happens.** The webhook is probably not
registered, or is registered to an address that no longer resolves. Check
**Admin → Telegram → Delivery**; if the registered URL is not your current
public address, register again.

**Messages arrive but Josi never answers.** Check **Delivery health**. A run of
`unauthorized` means the token was revoked in BotFather. A run of
`blocked_by_user` means that person blocked the bot — Josi revokes the link
rather than retrying forever, and they will see it as unlinked.

**"That link code cannot be used."** Every reason gives the same sentence on
purpose: used, expired, invalidated and never-existed are indistinguishable to
whoever is holding the code, because telling them which one it was confirms that
the code was real. Create a new one. The administrator can see the actual reason
in the audit log.

**A stranger is messaging the bot.** They get a refusal and nothing else. If it
is persistent, the rate limiter cuts them off after 20 messages a minute per
chat, and every refusal is in the audit log. Telegram's `/setprivacy` and
`/setjoingroups` reduce the surface further.

**I lost the bot token.** BotFather can revoke and reissue it (`/token`). Paste
the new one into Josi, register the webhook again, and turn the channel back on.
Existing links keep working — they are bound to accounts, not to the token.

---

## Validating an installation

With the channel configured and enabled:

```bash
# 1. The webhook exists but is invisible without the secret.
curl -si https://your.domain/telegram/webhook -X POST \
  -H 'Content-Type: application/json' -d '{}' | head -1
# expect: HTTP/2 404

# 2. It is not reachable through the API router, so no CSRF exemption exists.
curl -si https://your.domain/api/telegram/webhook -X POST | head -1
# expect: HTTP/2 404

# 3. A member cannot reach the admin surface.
#    (signed in as a member, with the CSRF pair set)
curl -si https://your.domain/api/admin/telegram | head -1
# expect: HTTP/2 403
```

Then, end to end: link a chat, send a message, confirm the reply arrives with
the disclosure, unlink, and confirm the next message is refused.

---

## Where the code is

| Concern | File |
|---|---|
| Bot API client, retries, download cap | `packages/channels/src/telegram/api.ts` |
| Token, probe, webhook registration | `packages/channels/src/telegram/config.ts` |
| Link codes and link rows | `packages/channels/src/telegram/linking.ts` |
| Routing an inbound update | `packages/channels/src/telegram/inbound.ts` |
| Sending, retries, dead-chat revocation | `packages/channels/src/telegram/outbound.ts` |
| MarkdownV2 escaping and chunking | `packages/channels/src/telegram/format.ts` |
| Attachment gates | `packages/channels/src/telegram/attachments.ts` |
| HTTP surface and the webhook | `apps/api/src/http/telegramRoutes.ts` |
| Schema | `packages/db/migrations/0014_telegram.sql` |
| Threat model | `docs/THREAT_MODEL.md` T-42 … T-50 |
