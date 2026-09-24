# Test List 7 — contacts and provider status evidence

2026-09-16, Bananana, worktree `josi-ce-list7-finish`, released baseline
`189207ad7afbf9b3bf237d88e6fa1cb25d167dce`. Synthetic fixture accounts only.

## Acceptance checklist

- [x] Existing Google People/Microsoft Graph sync engine retained; no fake native providers.
- [x] Enabled exact-account contact read automatically creates import-only origin.
- [x] Explicit stops survive scheduler enrollment; UI offers least-privilege restart.
- [x] Incremental cursors/tombstones and bounded-page continuation retained.
- [x] Local-only agreement fingerprints survive repeated reads; remote updates/deletes conflict with local edits or notes.
- [x] Source record and local contact creation are atomic; replay does not duplicate.
- [x] Concurrent origin claim; abandoned claims recover after three hours with checkpoint.
- [x] Provider Retry-After propagated to bounded backoff; errors contain categories only.
- [x] Desktop/mobile status, interval, sync, stop, restart, errors and containment.
- [x] Grounded read-only status tool with owner filtering, explicit capabilities, mapping/index/queue counts, native/workflow/Custom API metadata, receipt/audit and cursor redaction.
- [x] Obsidian explicitly unprobed pending separately authorized vault discovery.
- [x] Current status receipt required for detected affirmative runtime-status claims.
- [ ] Real Google People and Microsoft Graph account acceptance (credentials unavailable).

## Reproducible commands and results

`npx vitest run apps/api/test/contactSync.test.ts`: **17/17 passed** outside
sandbox (localhost test server binding is blocked inside sandbox).

`npx vitest run packages/agent/test/providerStatus.test.ts packages/agent/test/dataClaimGuard.test.ts`:
**27/27 passed**. Owner isolation, secret omission, audit receipts, empty state,
missing/stale receipt rejection and existing grounding guards.

`node scripts/acceptance/test-list-7-contact-runtime.mjs`: **12 checks passed**
on fresh real PostgreSQL 16 through production postgres.js, **50 migrations
applied** at execution. Dedicated `josi-list7-contact-runtime` container bound
only to `127.0.0.1:55497`; no live/gate state touched. Container removed afterward.
The script refuses a nonempty database. Provider HTTP responses are injected
synthetic fixtures. Evidence `/tmp/josi-list7-evidence/contact-runtime.json`.

`node scripts/acceptance/test-list-7-contact-browser.mjs`: Chromium rendered UI,
**7 checks each** at 1440×1000 and 390×844. Synthetic API interception covers
source identity, Sync now, interval, stop, import-only restart, status-loading
failure and responsive containment. Evidence
`/tmp/josi-list7-evidence/contact-browser.json`.

## External acceptance gap

No actual Google or Microsoft account was contacted. Needed: a disposable Google
OAuth application with People API enabled and an authorized test account refresh
token granting contacts.readonly; and a Microsoft OAuth application and authorized
test account refresh token granting Contacts.Read. Existing harness names:
`JOSI_REAL_GOOGLE_CLIENT_ID`, `JOSI_REAL_GOOGLE_CLIENT_SECRET`,
`JOSI_REAL_GOOGLE_REFRESH_TOKEN`, `JOSI_REAL_MS_CLIENT_ID`,
`JOSI_REAL_MS_CLIENT_SECRET`, `JOSI_REAL_MS_REFRESH_TOKEN`.
Then connect only those disposable accounts, enable read contacts, observe first
and incremental worker sync, edit/delete synthetic test contacts at provider,
revoke/reconnect, and record the real provider result without contact contents or
credentials. Two-way provider conditional writes require separately consented
Contacts.ReadWrite / Google contacts scopes. This is **not passed** by mocks.

The legacy `scripts/test-contacts-runtime.sh` tears down a Compose project and
removes `secrets`; do not run it in an existing deployment/worktree. Use a fresh
isolated fixture directory or the new nonempty-database-refusing harness.

Final focused contact regression suite:
`npx vitest run packages/connectors/test/contactSync.test.ts` — **49/49 passed**,
including automatic enrollment, exact-account permissions, bounded continuation,
local-edit fingerprint preservation, abandoned claim recovery, remote tombstones
with local edits and JSONB notes, and provider Retry-After. Connector/agent
TypeScript builds and `git diff --check` passed.
