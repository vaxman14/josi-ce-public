# Contact synchronisation

Google and Microsoft contacts, per user, private by default.

> **Status.** Implemented and covered by **118 tests** against the real
> migrations — identity and matching (25), provider adapters (20), the sync
> engine (41), the HTTP surface including two-user isolation (17), and
> scheduled sync in the worker (15). **No run against a real Google or
> Microsoft account has happened.** `scripts/test-contacts-runtime.sh` exists
> for that and has never been executed — see "What has not been proven".

## What it does

Each person connects their own account. Nobody connects one for anybody else,
and there is no administrator route that starts, runs or reads somebody's
contact sync — an administrator who could start it could read the address book
it moves.

| | |
|---|---|
| **Import only** | The default, and the only mode offered at first connect. Contacts come in; nothing is written back. |
| **Two-way** | Changes made in Josi are pushed back. Needs the provider's write permission, which is a **separate consent**, not a checkbox. |

## What it will not do

These are the decisions worth knowing before you turn it on, because each one
is a place where the obvious behaviour loses data.

**It does not merge people automatically.** The only records joined without
being asked are the same record from the same account seen twice. Everything
else — a shared email address, a shared phone number, the same name — is a
*suggestion*, shown to you, applied only if you say so. Two colleagues who
share a family phone line are the case this protects.

**It does not resurrect what you deleted.** Providers expire their
incremental cursors routinely; when that happens Josi re-reads everything.
Without a memory of what was deleted, every one of those re-reads would undo
every deletion. Tombstones are that memory.

**It does not overwrite an edit.** If a contact changed here *and* at the
provider since the last sync, Josi writes nothing, marks the contact, and shows
you. Last-write-wins is the easy answer and it silently discards whichever edit
was slower.

**It does not delete anything when you disconnect.** Stopping sync stops sync.
The contacts it brought stay where they are, nothing is changed at the
provider, and the same is true when a provider revokes the connection.

**It does not delete a contact two accounts share.** A person deleted in Google
but still in Outlook stays, because you still have them.

## Permissions

Least privilege, and read comes first:

| Mode | Google | Microsoft |
|---|---|---|
| Import only | `contacts.readonly` | `Contacts.Read` |
| Two-way | `contacts` | `Contacts.ReadWrite` |

The write scope is requested only when two-way sync is chosen, and the server
refuses the mode until the provider has actually granted it. A connection that
loses the permission later stops syncing with `insufficient_scope` rather than
failing halfway through.

## Privacy

- Contacts are **owner-scoped**, like conversations. Sharing one with the
  workspace is an explicit action through the existing sharing spine.
- The audit log records **counts and categories only**. No name, address,
  number or provider id reaches an event payload — asserted by a test.
- No provider token is stored in any contact table — also asserted.
- Provider error messages are never repeated. They quote the request, and a
  request to a contacts API quotes somebody's address book; only the provider's
  short error *code* is passed through.

## How often it runs

Every account has its own interval — 5, 15, 30 or 60 minutes, or once a day —
with 15 minutes the default and 5 the floor the server enforces. Per account
rather than global, so a provider rate-limiting one does not slow another, and
an hourly Outlook alongside a five-minute Google is possible.

A schedule ticks every two minutes and **fans out**: it enqueues one job per
account whose own interval has elapsed and syncs nothing itself, so one slow
provider delays its own account and nobody else's, and a worker that dies
mid-run costs one account its turn rather than everybody's.

Pacing is by **attempt**, not by success. An account whose provider is down is
retried on its interval rather than on every tick — otherwise a permanently
failing account is hammered until the provider rate-limits the whole
installation.

**Sync now** is always available and ignores the interval.

## Using it

1. **Connections** → connect Google or Microsoft, granting contacts access.
2. **Contacts** → the synced-accounts panel appears once an account is
   connected. Choose import-only or two-way, then **Sync now**.
3. Each contact shows where it came from and which account.

## What has not been proven

Written down here rather than left for somebody to discover:

- **No real provider run.** Every test uses an injected `fetchImpl`. The
  request shapes match the documented People API and Graph delta APIs, but
  nothing in this repository has read a real address book.
  `scripts/test-contacts-runtime.sh` Part B does exactly that and exits **3
  (SKIPPED)** without credentials. Skipped is not passed.
- **Part A of that harness has never been executed either.** It is written to
  drive the whole path against real PostgreSQL and a stubbed provider on the
  project network; no host with Docker has run it. It reports itself as skipped
  rather than printing checks it has not made.
- **Two-way push is tested against a stub, not a provider.** The conditional
  write — Google's `etag` in the body, Graph's `If-Match` header — is asserted
  to be sent, and no provider has been observed rejecting a stale one.
- **Rate-limit behaviour is tested, not measured.** Retry and backoff honour
  `Retry-After`; no provider has actually rate-limited this code.

## Automatic enrollment and safety (Test List 7)

Enable **Read contacts** on the exact Google or Microsoft account in Connections.
The worker discovers that opt-in within two minutes and creates an import-only
origin. Provider OAuth consent alone does not enable background access. Existing
origins retain their mode, interval and explicit stop choice. Restart a stopped
origin from Contacts after reconnecting; restarting defaults to import-only.
Other current providers are storage/workflow integrations, not contact providers.

The Contacts panel refreshes status every 15 seconds. Sync now, interval and stop
controls remain available. Bounded runs preserve the page checkpoint and do not
publish a successful sync timestamp until the final page. Concurrent attempts
claim the origin before reading. Local edits preserve the previous agreement
fingerprint: later remote edits or deletes become conflicts, never silent local
data loss. Provider Retry-After seconds govern transient retries, capped at five
minutes. Only the exact origin connection's enabled grant and administrator
policy authorize reading or two-way writing.

A claim abandoned by a crashed worker is recovered after three hours, retaining
its page checkpoint. This exceeds the bounded default run's timeout and retry
budget. A new contact and its source link are inserted atomically so a crash
cannot leave an unlinked duplicate behind. Runtime acceptance for Test List 7
uses `scripts/acceptance/test-list-7-contact-runtime.mjs` against a disposable
PostgreSQL 16 database and the production postgres.js adapter. Its provider HTTP
responses are synthetic; this does not substitute for real Google/Microsoft
account acceptance. `test-list-7-contact-browser.mjs` exercises desktop/mobile
sync controls against explicitly synthetic API fixtures.
