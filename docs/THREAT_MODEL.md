# Josi CE 0.1 — Threat model

Every entry below names a **Control** (where the defence lives) and a **Test**
(what would fail if it were removed), or is marked **Accepted** with a reason.
`apps/api/test/threatModel.test.ts` parses this file and fails the suite if any
entry is missing one, if a named control file does not exist, or if a named test
is not in the suite. The acceptance criterion for Phase 11 is therefore checked
by the build rather than by reading.

Entries are written as *what the attacker does*, not as a feature that exists.

## How to read an entry

```
### T-nn Title
**Attacker:** who, and what they already have
**Impact:** what they get if it works
**Control:** path/to/file.ts — one line on the mechanism
**Test:** the exact test name that fails if the control is removed
```

---

## Setup and installation

### T-01 Setup is completed by whoever reaches the server first
**Attacker:** anyone who can reach a freshly deployed installation before its
owner does.
**Impact:** they become the super admin of somebody else's installation.
**Control:** `scripts/aio-install.sh` — the temporary TLS installer creates a
high-entropy one-time code before it deploys the application; the
authenticated installer browser receives a separate one-time handoff token in
the URL fragment. Only its SHA-256 hash reaches the application environment;
setup routes return 404 without the matching token. The application then uses
a single-row `setup_state` and refuses setup replay.
**Test:** binds first-admin setup to the installer handoff token

### T-02 The master key is read out of the image, the database, or a log
**Attacker:** anyone holding a database dump, an image layer, or log output.
**Impact:** every stored credential becomes readable.
**Control:** `packages/core/src/masterKey.ts` — mounted as a Docker secret, and
`MasterKey`/`Secret` redact through `String`, template literals, `JSON.stringify`
and `util.inspect`.
**Test:** never bakes a secret into the image

### T-03 A weak or reused installation key is accepted
**Attacker:** an operator in a hurry.
**Impact:** brute-forceable credential encryption.
**Control:** `scripts/install.sh` — 32 bytes from a CSPRNG, `umask 077`, refuses
to overwrite an existing key because a new one orphans every stored credential.
**Test:** generates the key from a CSPRNG and never prints it

---

## Authentication and sessions

### T-04 Credential stuffing against sign-in
**Attacker:** anyone with a password list.
**Impact:** account takeover.
**Control:** `packages/auth/src/ratelimit.ts` — failures counted per identifier
and per IP, forgotten on success, since what is being limited is guessing.
**Test:** locks out after repeated failures

### T-05 A stolen session is used to change security settings
**Attacker:** someone with a live session from an unlocked screen.
**Impact:** silent privilege or configuration change.
**Control:** `packages/core/src/stepUp.ts` — re-authentication for sensitive
actions. This defends a held session, not a stolen password.
**Test:** refuses a consequential action on a session alone

### T-06 Cross-site request forgery
**Attacker:** any site the user visits while signed in.
**Impact:** actions performed as the user.
**Control:** `apps/api/src/http/cookies.ts` — double-submit token required on
every mutating request; a GET needs none.
**Test:** refuses a state-changing request with no token

---

## Isolation between users

### T-07 One member reads another member's content
**Attacker:** an ordinary member of the same workspace.
**Impact:** access to a colleague's threads, mail, documents or mappings.
**Control:** `packages/core/src/ownership.ts` — one decision point, owner or an
explicit share, and **404 rather than 403** so the reply does not confirm the
row exists.
**Test:** 404 a colleague, and 404 the administrator

### T-08 The super admin reads member content through an admin screen
**Attacker:** the installation's own administrator.
**Impact:** the privacy promise of the product fails.
**Control:** `apps/api/src/http/storageRoutes.ts` and `mailRoutes.ts` — admin
routes read metadata tables that have no content columns, so widening a SELECT
cannot leak content.
**Test:** contains no subject and no body

### T-09 A share is used to widen or pass on access
**Attacker:** a colleague who was given access to help.
**Impact:** access compounds beyond what the owner agreed to.
**Control:** `apps/api/src/http/authz.ts` — sharing requires `owner`, not
`write`, so somebody trusted to help cannot decide who else reads it.
**Test:** a colleague with write access cannot share it onward

---

## Connectors and outbound requests

### T-10 An operator-supplied endpoint reaches cloud metadata
**Attacker:** an operator pasting a URL from a forum post, or one who has been
socially engineered.
**Impact:** the host's cloud IAM credentials are exfiltrated.
**Control:** `packages/llm/src/ssrf.ts` — link-local and metadata ranges refused
at request time as well as save time, redirects never followed.
**Test:** refuses a cloud-metadata endpoint

### T-11 A telemetry or support URL bypasses the SSRF guard
**Attacker:** the same operator, using the settings Phase 10 added.
**Impact:** as T-10, through a surface built later than the guard.
**Control:** `packages/ops/src/telemetry.ts` — `assertOutboundUrlSafe` on set and
again on send, because a hostname that resolved benignly when saved can resolve
to metadata later.
**Test:** refuses one that only resolves to metadata at send time

### T-12 An OAuth callback is used to attach somebody else's account
**Attacker:** anyone who can reach the callback URL.
**Impact:** a connection created under the wrong user.
**Control:** `packages/connectors/src/oauthState.ts` — the state row carries the
user and session; the callback never trusts a query parameter for identity.
**Test:** refuses a callback carrying another person state

---

## Mapped folders and untrusted files

### T-13 A mapped path escapes its folder
**Attacker:** a member with a mapping, or a crafted filename on disk.
**Impact:** reads anywhere the container can reach.
**Control:** `packages/storage/src/paths.ts` — normalise, structural containment
check, resolve symlinks, check again; `startsWith` is explicitly not used.
**Test:** refuses a symlink that leaves the folder

### T-14 An archive expands until the disk is full
**Attacker:** anyone who can place a file in a mapped folder.
**Impact:** denial of service on a small host.
**Control:** `packages/storage/src/gates.ts` — bounds on entry count, expanded
bytes, recursion depth and wall clock, checked **before** accepting each entry.
**Test:** stops a zip bomb at the size limit, BEFORE accepting the entry

### T-15 An archive entry writes outside the extraction root
**Attacker:** a crafted ZIP.
**Impact:** arbitrary file write.
**Control:** `packages/storage/src/gates.ts` — entry paths get the same traversal
rules as request paths.
**Test:** refuses an entry whose path escapes

### T-16 A malicious document is indexed and its text served back
**Attacker:** anyone who can place a file in a mapped folder.
**Impact:** malware spread, or content laundering through search.
**Control:** `packages/storage/src/ingest.ts` — a finding blocks processing,
purges any extracted text, and **does not touch the source**; an enabled but
unreachable scanner stops processing rather than passing files through.
**Test:** stops processing when the scanner is enabled but unreachable

### T-17 Josi destroys a customer file on a false positive
**Attacker:** none — this is the antivirus being wrong.
**Impact:** data loss caused by the product.
**Control:** `packages/storage/src/ingest.ts` — no move, quarantine, rename or
delete; the source hash is taken before and after so "unmodified" is measured.
**Test:** there is no code path that moves, renames or deletes the source

### T-18 OCR exhausts a small host
**Attacker:** ordinary use on Pi-class hardware.
**Impact:** the installation becomes unusable.
**Control:** `packages/storage/src/queue.ts` — off by default, super-admin only,
concurrency ceiling and an hour window; no per-user override exists.
**Test:** OCR is refused when disabled, with no way for a user to override

---

## Search and derived data

### T-19 Search crosses owners
**Attacker:** a member issuing a crafted query.
**Impact:** reads a colleague's documents.
**Control:** `packages/storage/src/search.ts` — the owner is a required argument
rather than a filter, and no request parameter can widen it.
**Test:** never returns a colleague's document, however well it matches

### T-20 Document text leaves the installation without consent
**Attacker:** an administrator enabling semantic search.
**Impact:** customer documents sent to a third party.
**Control:** `packages/storage/src/search.ts` — Local-only first, then the
administrator's switch, then the individual's consent; consent cannot even be
recorded in Local-only.
**Test:** is refused in Local-only even with the policy on and consent given

### T-21 Revoked access still yields content through old citations
**Attacker:** a member whose access was withdrawn.
**Impact:** continued reading after revocation.
**Control:** `packages/storage/src/search.ts` — citations resolve at display
time, so revocation takes effect immediately without rewriting messages.
**Test:** stops offering it once the document is purged, and says what it was

---

## Mail

### T-22 Josi is used to send mail as somebody else
**Attacker:** a member, or a bug in the send path.
**Impact:** forged mail from a colleague's address.
**Control:** `packages/mail/src/identity.ts` — the From is the installation
mailbox with a display name; the person's own address is never the sender.
**Test:** sends as "<person> via Josi" from the installation mailbox

### T-23 Header injection through an address or subject
**Attacker:** anyone who can influence a recipient string.
**Impact:** added recipients, spoofed headers.
**Control:** `packages/mail/src/identity.ts` — CRLF and `<>,;` refused outright.
**Test:** refuses an address that could carry a second header

### T-24 A reply loop between two automatons
**Attacker:** an ordinary out-of-office reply.
**Impact:** a mail storm from the installation.
**Control:** `packages/mail/src/inbound.ts` — header conventions plus a per-thread
budget, because headers only stop the well-behaved ones.
**Test:** a reply loop terminates

### T-25 An unowned shared inbox forms
**Attacker:** none — this is drift.
**Impact:** everybody can read everybody's correspondence.
**Control:** `packages/mail/src/inbound.ts` — every inbound resolves to a thread
owner or is quarantined; quarantine keeps headers only.
**Test:** quarantines a message with no token rather than guessing an owner

---

## Backup, restore and updates

### T-26 A stolen backup yields credentials
**Attacker:** anyone who obtains an archive.
**Impact:** every provider key, OAuth token and mail password.
**Control:** `packages/ops/src/backup.ts` — the master key is never in an
archive, enforced by a database constraint as well as by absence of a code path.
**Test:** a backup never contains the master key, and the database refuses one that claims to

### T-27 A backup is written somewhere it can be read
**Attacker:** a member with a mapped folder.
**Impact:** an archive of the whole database inside a folder they can read.
**Control:** `packages/db/migrations/0011_operations.sql` — archives constrained
to `/data/backups`, traversal refused, filenames stripped of separators.
**Test:** lives inside Josi and cannot traverse out

### T-28 A broken update leaves the installation unusable
**Attacker:** none — this is a bad release.
**Impact:** downtime with no way back.
**Control:** `packages/ops/src/update.ts` — back up first and refuse to proceed
if that fails, health check afterwards, roll back on failure, and report a failed
rollback as its own category rather than softening it.
**Test:** rolls back when the health check fails, and keeps the old version

### T-29 An update happens without anybody deciding to
**Attacker:** none — this is a default.
**Impact:** an unattended change to a production installation.
**Control:** `packages/db/migrations/0011_operations.sql` — there is no column
that could enable automatic updating, because a setting that exists can be
flipped.
**Test:** there is no setting anywhere that could enable one

---

## Diagnostics and support

### T-30 A support bundle carries customer content
**Attacker:** none — this is the product being careless.
**Impact:** messages or documents in a third party's ticket system.
**Control:** `packages/ops/src/diagnostics.ts` — the builder can only render a
fixed list of sections, so a table added later cannot leak through a redactor
nobody updated.
**Test:** can only produce the sections on the list

### T-31 A bundle carries a credential
**Attacker:** none — a token in a log line.
**Impact:** a live credential in a support ticket.
**Control:** `packages/ops/src/diagnostics.ts` — redaction per section, then a
second scan over the assembled bundle, which must pass before submission.
**Test:** a bundle built from secret-bearing logs comes out clean

### T-32 Something is sent before the user has seen it
**Attacker:** none — this is consent theatre.
**Impact:** the user consented to something they never read.
**Control:** `packages/ops/src/diagnostics.ts` — inspect, then approve, then
scan, as three separate acts, with a database constraint refusing a submission
that skipped any.
**Test:** the database refuses a submission that skipped any step

---

## Telemetry

### T-33 Telemetry carries content or identifiable data
**Attacker:** none — this is a field added later without thought.
**Impact:** customer data leaving every installation, silently and permanently.
**Control:** `packages/ops/src/telemetry.ts` — an allowlist rather than a
denylist, free text refused even in allowlisted fields, nested objects reduced
to counts and flags.
**Test:** carries only allowlisted fields, whatever it is handed

### T-34 Telemetry is on without anybody choosing it
**Attacker:** none — a default.
**Impact:** an installation transmitting without consent.
**Control:** `packages/db/migrations/0002_setup.sql` — off by default with a
constraint that enabling implies a recorded opt-in.
**Test:** is off by default

---

## Resource exhaustion

### T-35 One person exhausts the installation with expensive requests
**Attacker:** any member holding down a button.
**Impact:** a small server made unusable for everybody.
**Control:** `packages/core/src/ratelimit.ts` — per-subject fixed windows on the
expensive endpoints, never global, because a global counter turns a rate limit
into the outage it was meant to prevent.
**Test:** refuses once the allowance is spent, per subject

### T-36 A parser or archive error message quotes the document
**Attacker:** none — this is an error path.
**Impact:** document content in an API response or a log.
**Control:** `packages/storage/src/ingest.ts` and `packages/mail/src/smtp.ts` —
fixed vocabularies of categories; no library message reaches a caller.
**Test:** never repeats the server text, which quotes the message that bounced

---

## Telegram channel

Every entry in this section rests on one fact: **an inbound Telegram update is
an unauthenticated claim.** The chat id, the sender id and the username are all
chosen by whoever sent the message, and CE has no way to challenge any of them.
So the channel's whole trust story is `telegram_links` — a row a signed-in user
created deliberately — and these entries are the ways somebody might try to get
around it.

### T-42 Anyone POSTs to the webhook URL
**Attacker:** anyone on the internet who guesses or discovers
`https://<host>/telegram/webhook`, which is a fixed, public path.
**Impact:** they inject messages that CE treats as coming from Telegram —
spending model budget, and, if a chat id could be spoofed into a linked one,
speaking into somebody's private conversation.
**Control:** `apps/api/src/http/telegramRoutes.ts` — the handler compares
Telegram's `X-Telegram-Bot-Api-Secret-Token` against a 32-byte generated secret
in constant time BEFORE the body is read for meaning, and answers 404 (not 403)
on any mismatch, so a disabled or unconfigured installation is
indistinguishable from one that never had Telegram.
**Test:** refuses a wrong secret, and records the probe

### T-43 A stranger messages the bot and gets somebody's assistant
**Attacker:** anyone who finds the operator's bot in Telegram search.
**Impact:** free use of the installation's model budget at minimum; reading or
writing into a colleague's conversation at worst.
**Control:** `packages/channels/src/telegram/inbound.ts` — an unknown chat is
refused and told how to link; the only thing an unlinked chat may do is redeem
a code. Nothing in the payload selects an account: the user id comes from
`resolveChat`, which filters on `status = 'active'` in the WHERE clause.
**Test:** a linked chat reaches ITS OWN owner, whatever the payload claims

### T-44 A link code is stolen, replayed, or guessed
**Attacker:** someone who sees a code over a shoulder, in a screenshot, in a
support ticket, or in a database dump.
**Impact:** their Telegram account becomes attached to somebody else's Josi.
**Control:** `packages/channels/src/telegram/linking.ts` — 160 bits from a
CSPRNG, stored only as a SHA-256 hash, single-use via a conditional UPDATE
rather than a read-then-write, 15-minute TTL, invalidated on unlink and on
minting a replacement, and every failure returns one indistinguishable sentence
so the reason is not an oracle.
**Test:** is SINGLE USE — a replay is refused

### T-45 A group chat becomes an unowned shared inbox
**Attacker:** any member of a Telegram group the bot is added to.
**Impact:** everyone in the group talks as whichever single person the group
resolved to — the unowned-inbox failure Phase 8 named for mail.
**Control:** `packages/channels/src/telegram/inbound.ts` — anything whose
`chat.type` is not `private` is refused before the link lookup. There is no
group mode to configure, which is the strongest form of the rule.
**Test:** refuses a group chat outright

### T-46 An attachment is a zip bomb, an executable, or a path
**Attacker:** anybody with access to a linked person's phone, or anybody who
forwarded them a file.
**Impact:** memory exhaustion, an executable on the server, or a write outside
the intended directory.
**Control:** `packages/channels/src/telegram/attachments.ts` — attachments are
off until an administrator turns them on; four gates run cheapest-first; the
filename is never kept, only a sanitised extension against an allowlist with a
separate executable deny list; and `api.ts` caps the download on the bytes as
they ARRIVE, so a lying `Content-Length` cannot exceed the ceiling.
**Test:** refuses a LYING Content-Length by counting the bytes as they arrive

### T-47 The bot token leaks through an error, a log, or an admin screen
**Attacker:** anyone who can read an error response, a log line, an audit
payload, or the admin UI.
**Impact:** they can send as the operator's assistant to every person who ever
linked, and read everything sent to the bot.
**Control:** `packages/channels/src/telegram/api.ts` — the token is in the URL,
so no provider description, cause or URL is ever passed outward; every failure
becomes one of a fixed set of categories. The token is sealed with the master
key and `describeConfig` reports `tokenSet: true` rather than the ciphertext.
**Test:** NEVER passes Telegram's description through to the message

### T-48 Telegram redelivers an update and the turn runs twice
**Attacker:** not an attacker — Telegram's own retry, triggered by exactly the
slow model call that costs the most.
**Impact:** duplicate answers, duplicate charges against the installation cap,
and duplicate side effects from any tool the turn ran.
**Control:** `packages/channels/src/telegram/inbound.ts` — `update_id` is
claimed with `insert … on conflict do nothing` before anything expensive, and a
zero-row result means acknowledge and stop. The handler always answers 200 once
the secret matched, so a deterministic failure cannot become a retry loop.
**Test:** a redelivered update_id is dropped

### T-49 One chat floods the installation
**Attacker:** anyone who can message the bot, linked or not.
**Impact:** the installation's model cap is spent by one person, denying the
feature to everybody else.
**Control:** `packages/core/src/ratelimit.ts` — a `telegram_inbound` bucket
keyed on the CHAT rather than the user, because an unlinked chat has no user to
charge, and spent before the link lookup. A refused flood is answered with
silence, since replying to a flood participates in it.
**Test:** the allowance is per chat, so one person cannot mute another

### T-50 An administrator uses the bot token to reach a colleague's phone
**Attacker:** the super admin, who holds the bot token by definition.
**Impact:** messaging a colleague's private Telegram as Josi, or correlating
their chat id with their identity.
**Control:** `apps/api/src/http/telegramRoutes.ts` — the admin link view returns
owner, status and timestamps and deliberately omits `chat_id`; every DTO passes
`assertMetadataOnly`. This narrows T-38 rather than closing it: an
administrator who edits the database directly still holds both halves.
**Test:** the link list has no chat id and no message text

---

### T-69 A handshake state is replayed
**Attacker:** anyone who observes a callback URL — browser history, a referrer,
a shared screen, a proxy log.
**Impact:** a second connection attached from one consent, or an authorization
code redeemed twice.
**Control:** `packages/connectors/src/oauthState.ts` — the state is claimed by a
conditional `update … where consumed_at is null`, so two concurrent redemptions
resolve to exactly one winner, and a replay is refused before the code is
exchanged.
**Test:** refuses a state that has already been used

### T-70 A state is redeemed at the wrong provider's callback
**Attacker:** anyone who can make the browser follow a chosen callback URL.
**Impact:** a consent granted for one provider used to attach a connection at
another, with scopes nobody agreed to.
**Control:** `packages/connectors/src/oauthState.ts` — the stored handshake
records which provider it was minted for, and the callback compares it, so a
Google state at the Microsoft callback is `wrong_provider` rather than an
exchange.
**Test:** refuses a Google state redeemed at the Microsoft callback

### T-71 A token is stored against the wrong person
**Attacker:** a member who completes a handshake somebody else started, or who
replays a callback in their own session.
**Impact:** one person's provider account attached to another's connection —
which is a mailbox and a calendar handed to the wrong colleague.
**Control:** `apps/api/src/http/connectorRoutes.ts` — the owner comes from the
STORED handshake and never from the session on the callback request or from the
query string, and the state is additionally bound to the session that minted it.
**Test:** stores the token against the handshake’s owner, not the caller

### T-72 A connection id is used by somebody who does not own it
**Attacker:** a signed-in member who has learned another member's connection id.
**Impact:** reading, re-permissioning or deleting a colleague's connection.
**Control:** `apps/api/src/http/connectorRoutes.ts` — every route resolves the
connection and compares its owner, answering 404 rather than 403 so the reply
does not confirm that an id belonging to somebody else exists.
**Test:** does not let one person point a connection id at their own request

---

## Contact synchronisation

### T-51 A deleted contact comes back on the next full resync
**Attacker:** no attacker — the provider itself, expiring a sync cursor as it
routinely does, which makes Josi re-read the whole address book.
**Impact:** every contact the user deleted is recreated. They delete it again,
it returns again, and they stop trusting the product with their data.
**Control:** `packages/connectors/src/contactSync.ts` — a deletion writes a
tombstone keyed by owner, provider, account and the provider's own id, and an
incoming record is checked against it before anything is created, so a full
re-read cannot undo a deletion.
**Test:** does not bring a deleted contact back on the next full resync

### T-52 One person's address book reaches another
**Attacker:** any member of the installation with their own connected account.
**Impact:** they read a colleague's clients, suppliers and personal contacts.
**Control:** `packages/connectors/src/contactSync.ts` — every query is keyed by
`owner_user_id` taken from the sync origin rather than from a request, so there
is no argument a caller can pass that reaches another owner's contacts.
**Test:** sync separate address books that never meet

### T-53 A guessed origin or contact id reaches somebody else's sync
**Attacker:** a signed-in member enumerating uuids.
**Impact:** running, stopping or merging into another person's contacts.
**Control:** `apps/api/src/http/contactSyncRoutes.ts` — no route accepts an
owner id; ownership is resolved from the origin or the connection, and an id
belonging to somebody else answers 404 rather than 403, because confirming that
it exists is itself a disclosure.
**Test:** refuses to merge a contact belonging to somebody else

### T-54 An administrator starts somebody's contact sync in order to read it
**Attacker:** the super admin of the installation.
**Impact:** an address book they have no route to read becomes readable by
being imported on the owner's behalf.
**Control:** `apps/api/src/http/contactSyncRoutes.ts` — there is deliberately no
administrative equivalent of any route in this file, so the capability an
administrator would abuse does not exist rather than being guarded.
**Test:** is not reachable by an administrator either

### T-55 A provider cursor points Josi at an attacker's server
**Attacker:** anyone who can influence what a provider returns, including a
compromised or spoofed Graph response.
**Impact:** Josi calls that URL **with a bearer token attached**, handing the
account's access token to whoever answers.
**Control:** `packages/connectors/src/providers/contacts.ts` — a Microsoft
cursor is a URL that will be requested with the token, so it is checked against
the Graph origin before any request is made, and a foreign one is refused
rather than followed.
**Test:** refuses a cursor that points somewhere other than Graph

### T-56 A provider error message quotes the address book into a log or a screen
**Attacker:** no attacker — the provider, echoing the request that failed.
**Impact:** names, addresses and phone numbers appear in an error surfaced to an
operator, or in an audit payload that is supposed to hold metadata only.
**Control:** `packages/connectors/src/providers/contacts.ts` — only the
provider's short `code`/`status` is repeated, validated as an identifier rather
than a sentence; the `message` field is never carried, because a request to a
contacts API quotes somebody's contacts.
**Test:** never repeats a provider message, which quotes the address book

### T-57 Two different people are merged into one contact
**Attacker:** no attacker — two colleagues who share a household phone line, or
an `office@` address that everybody lists.
**Impact:** a message meant for one person reaches the other, and the original
records no longer exist to correct it.
**Control:** `packages/core/src/contactIdentity.ts` — a shared line with nothing
else agreeing is graded `weak` and never merges unattended; the only rule that
may act alone is the same record from the same account seen twice.
**Test:** is WEAK about a shared line with nothing else, which is the family phone

### T-58 Write access to a provider is obtained without a second consent
**Attacker:** a member who enables two-way sync on a read-only connection.
**Impact:** Josi writes to their Google or Microsoft account under a permission
nobody granted for writing.
**Control:** `packages/connectors/src/contactSync.ts` — the capability the mode
needs is resolved per provider and checked against what the provider actually
granted, both when the mode is set and again at the moment of every sync run.
**Test:** refuses two-way without the write permission actually granted

### T-59 Contact sync keeps running after the account is disconnected
**Attacker:** no attacker — a user who revoked access and expects it to stop.
**Impact:** continued reads against an account whose owner withdrew consent, or
silent deletion of contacts they wanted to keep.
**Control:** `packages/connectors/src/contactSync.ts` — a disconnected or
revoked origin returns before any provider is contacted, and stopping deletes
nothing on either side because disconnecting a source is not consent to lose
what it brought.
**Test:** does nothing further once disconnected, even if asked

---

## Subscription sign-in

### T-60 Josi is used to harvest the operator's ChatGPT credentials
**Attacker:** a modified build, or a future contributor taking a shortcut.
**Impact:** the operator's ChatGPT login is copied out of the CLI's own storage
and used elsewhere, which is impersonation rather than delegation and is
prohibited by the provider.
**Control:** `packages/llm/src/providers/codexLogin.ts` — no credential store is
read anywhere on this path; the child process is given `PATH`, `HOME` and
`CODEX_HOME` and nothing else, and a source guard fails the suite on any
reference to an auth file, a keychain or a cookie jar.
**Test:** never reads a credential store to find a login

### T-61 The sign-in prompt sends the operator to an attacker's page
**Attacker:** anyone who can influence what the CLI prints, including a
compromised or substituted binary.
**Impact:** the operator signs in to a page of the attacker's choosing while
believing they are completing a Josi-initiated device login.
**Control:** `packages/llm/src/providers/codexLogin.ts` — the verification URL
parsed out of the CLI's output must be an OpenAI address, and a challenge whose
link is anywhere else is discarded rather than shown.
**Test:** takes no URL that is not OpenAI’s

### T-62 A hosted build enables the CE-only subscription path
**Attacker:** whoever runs a hosted or white-label build, by environment
variable, direct SQL, or a modified client request.
**Impact:** a personal ChatGPT plan powers a commercial service, which the
provider's terms exclude and which is the reason the boundary exists.
**Control:** `apps/api/src/setup/setupRoutes.ts` — the sign-in routes are
mounted inside an edition capability check rather than guarded by one, so a
hosted build's route table does not contain them at all and cannot confirm the
capability exists to be asked for.
**Test:** mounts the sign-in routes behind the edition capability, not behind a guard

---

## Setup verification and model discovery

### T-63 A key typed into the wizard is echoed back or stored by discovery
**Attacker:** anyone who can read a response the wizard returns, including the
person at a shared screen.
**Impact:** a provider API key leaks from a step that was only meant to list
models.
**Control:** `apps/api/src/setup/setupRoutes.ts` — model discovery takes the key
from the request, uses it once to ask the provider what the account may use, and
returns only the model list; nothing is written and nothing is reflected.
**Test:** never echoes the key it was given

### T-64 A provider's prose is repeated into setup and carries the prompt
**Attacker:** no attacker — the provider, quoting the request that failed.
**Impact:** the contents of a request, which on this path includes a prompt,
appear in an operator-facing error.
**Control:** `packages/llm/src/providers/openaiCompatible.ts` — only the
provider's short error code is carried, matched against an identifier shape and
capped in length, so a provider that puts prose in a code field is ignored
rather than trusted.
**Test:** never carries the provider’s prose, which quotes the request back

### T-65 Setup completes with a required thing that does not work
**Attacker:** no attacker — an operator clicking through, or a client that
skips a step.
**Impact:** an installation reports itself configured while the model, the mail
server or a connector has never answered, which is the failure this whole audit
exists to remove.
**Control:** `apps/api/src/setup/setupRoutes.ts` — completion rebuilds the
review server-side at the moment of the request and refuses while anything
required is failing or untested, rather than trusting what the review screen
last showed.
**Test:** refuses to finish while the model test is failing

---

## Approval policy

### T-66 A fresh installation acts without approval because nobody set a ceiling
**Attacker:** no attacker — an installation nobody configured, and a user who
chose the loosest setting available to them.
**Impact:** Josi sends mail or changes a calendar on somebody's behalf with
nobody having decided that was allowed.
**Control:** `packages/core/src/approvals.ts` — a missing administrator policy
resolves to `always_ask` rather than to no ceiling, and migration 0016 seeds an
explicit row for every action class so the default is visible as well as safe.
**Test:** does not treat "no policy" as "no ceiling"

### T-67 A ceiling is relaxed without anybody deciding to
**Attacker:** a client bug, a replayed request, or an administrator who did not
realise which direction they were moving.
**Impact:** Josi gains autonomy nobody consciously granted, and no record exists
of who granted it.
**Control:** `packages/core/src/approvals.ts` — loosening requires an explicit
confirmation flag and is refused without it, and it is recorded under its own
event kind carrying the previous value, so a relaxation is findable in an audit
without reading every ceiling change ever made.
**Test:** refuses a relaxation that was not confirmed

### T-68 A checklist dismissal hides a real failure
**Attacker:** no attacker — an administrator clearing a list.
**Impact:** a broken backup or an unverified master-key copy stops being shown,
and the installation looks ready when it is not.
**Control:** `packages/core/src/launchChecklist.ts` — a dismissal applies only to
an item that is merely outstanding, never to one that is failing, and items
whose severity is critical cannot be dismissed at all.
**Test:** ignores a dismissal of something that is failing

---

## Accepted risks

These have no control, deliberately.

### T-37 A compromised host reads everything
**Accepted:** anyone with root on the host can read the master key file, the
database volume and process memory. CE is self-hosted software; defending the
host against its own administrator is not a property it can offer. The
installation guide says so, and recommends full-disk encryption.

### T-38 A malicious administrator abuses their own installation
**Accepted:** an administrator can reset a user's password and sign in as them.
CE narrows this — no admin route reads content, mappings, or mail — so the
abuse is *detectable in the audit log* rather than invisible, but it is not
prevented. A single-workspace product cannot both have an administrator and
defend against one.

### T-39 A user's own LLM provider retains their prompts
**Accepted:** what a provider does with data after it arrives is outside CE's
control. The product's answer is disclosure and Local-only, not a technical
guarantee it cannot make.

### T-40 Deliverability and mail reputation
**Accepted:** whether mail from an installation reaches an inbox depends on SPF,
DKIM, DMARC and the operator's IP reputation. CE makes correct alignment
possible and cannot make it true.

### T-41 Recovery copies are not encrypted by Josi
**Accepted:** M62. Copies inherit the security of the Docker volume and the
host disk. Encrypting them with the master key would put a decryption oracle
next to the data; the honest answer is full-disk encryption, and the product
says so in the words the user sees.
