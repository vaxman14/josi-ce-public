# Test List 7 remaining acceptance

Baseline: public main `189207ad7afbf9b3bf237d88e6fa1cb25d167dce` (v0.1.27).
Unchecked means unproven, even when source exists. Prior evidence is in
TEST_LIST_7_VERIFICATION.md; its external gaps remain open until reproduced.

- [ ] 1: masked labeled password, keyboard/error announcement, browser accessibility tree; supported-browser autofill and real password-manager acceptance without capturing values.
- [ ] 2: retain authenticated isolated maintenance launch, bounded lifetime and cleanup.
- [ ] 3: retain native integrations and explicit Custom API fallback, approvals and provider contract tests.
- [ ] 4: isolated public DNS/trusted TLS success and failed-health rollback; exact environment, Compose, proxy, database, OAuth and webhook state restoration. Identify unavailable provider credentials explicitly.
- [ ] 5: retain guarded dirty/save/readback/error and navigation states.
- [ ] 6: retain account consent, capability restriction and revocation tests.
- [x] 7: distinct List/Month/Week/Day, navigation/today, DST/timezone/all-day/recurrence/overlap tests; keyboard, responsive browser proofs and loading/empty/error handling.
- [x] 8: automatic initial and incremental Google/Microsoft contacts, exact account authorization, cursor expiry, idempotency, deletion/conflict/dedup semantics, concurrent scheduling/retry/revocation and visible status tests. Real provider-account acceptance remains separately identified below because no disposable provider credentials exist.
- [x] 9: exact account/calendar through query, detail, tools, receipts, reminders and actions; explicit-source failure and multi-account isolation tests.
- [x] 10: read-only authoritative runtime provider/storage status, capabilities, mapping/sync/count/cursor-presence/queue/remediation; receipt grounding, redaction and authorization tests.
- [x] 11: authorized configured-root browser with breadcrumbs/search/sort/metadata/safe preview and file operations, containment and secret protections, quotas, audit and browser/security tests.
- [x] 12: explicit workspace/coding-agent enablement; separate read/write authority, per-action approval, sandbox/resources/time/command/network boundaries, cancellation/recovery and adversarial tests.
- [x] 13: dedicated persistent storage in both Compose distributions, image ownership and upgrade provisioning; startup/readiness diagnostics, bounded validated uploads and atomic quotas, thread/owner read/model/delete isolation; cleanup preserves referenced files. Real persistence and failure proofs passed.

## Recovered verification, 2026-09-16

- 206 focused tests passed across calendar, contacts, provider status, Local Workspace, coding tools and chat attachments.
- Full Chromium desktop/mobile acceptance passed for Calendar, Contacts and Local Workspace.
- Real PostgreSQL 16 contact acceptance applied all 50 migrations and passed 12 runtime checks with synthetic provider HTTP fixtures.
- The isolated maintenance controller passed real LAN HTTPS health, authentication, pairing and replay checks.
- The coding helper passed execution, syntax-failure, host-isolation, unprivileged/read-only root, no-network, cancellation, output, memory and time-limit checks using a digest-pinned Node image.
- TypeScript, server/web builds, Python tests, Compose base+coding overlays, secret scan (605 files), dependency audit (zero vulnerabilities) and diff hygiene passed.
- Remaining external evidence only: a real Google Password Manager + macOS VoiceOver session for item 1; disposable public DNS/TLS plus real OAuth/Telegram provider credentials for item 4; disposable Google People/Microsoft Graph accounts for item 8. These credentials/accounts do not exist and live credentials were not touched.

## Required integration and publication gates

- [ ] Fresh database migration chain; upgrade from baseline database.
- [ ] Focused tests, complete suite, TypeScript, production web/server/docs build.
- [ ] Secret scan, dependency audit, Python checks, Compose validation, diff hygiene.
- [ ] Real clean install and runtime/browser acceptance; report credential skips individually.
- [ ] Inspect real amd64/arm64 app and installer artifacts.
- [ ] Reviewed source PR, all gates passing, merged exact public-main commit.
- [ ] Numbered release from merge commit; both registries and latest/numbered immutable digests and revision labels verified.
- [ ] Gate database/config backup; overlay-preserving upgrade including all helpers, migrations, direct/public route, sockets, logs and restart persistence.
- [ ] Durable workspace ledger committed/pushed with evidence, gaps, digests and deployment results.
