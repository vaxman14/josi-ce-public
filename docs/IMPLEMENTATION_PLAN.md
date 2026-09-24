# Josi CE 0.1 — Community Preview: implementation plan

Phases are ordered so that **isolation and secrets come before features**. Every
phase has acceptance criteria that are testable, not aspirational, and a stated
risk. A phase is not done until its tests pass and the diff has been scanned.

Traceability to the canonical map lives in `DECISION_TRACEABILITY.md`. Extraction
decisions live in `EXTRACTION_MAP.md`. Neither is summarised away here.

---

## Phase 0 — Repository, guardrails, documentation ✅

**Goal:** a private repo that physically cannot leak SoCal material.

- `.gitignore` covering `.env*`, `secrets/`, `master.key`, `data/`, `uploads/`,
  `backups/`, `diagnostics/`.
- `scripts/scan-secrets.sh` — blocks the four SoCal phone numbers, `heyjosi`,
  `socalreceptionist`, the two production IPs, the Supabase project ref, and
  generic key shapes (`sk-`, `AKIA`, PEM headers, JWTs).
- The three docs: extraction map, this plan, decision traceability.
- Legal and attribution files: `LICENSE` (AGPL-3.0), `TRADEMARK.md`, `NOTICE`.

**Acceptance:** `scripts/scan-secrets.sh` exits 0 on a clean tree and non-zero
when a SoCal string is introduced (tested with a deliberate fixture).
**Risk:** a false sense of safety from a scanner that is never run → wired into
a pre-commit hook *and* CI, not documentation.

---

## Phase 1 — Workspace + user model, auth, isolation

**Goal:** the security spine. Nothing else is built on sand.

- Migration `0001_workspace.sql`: `workspace` (singleton), `users`
  (`super_admin` | `member`, partial unique index on super admin), `sessions`,
  `auth_tokens`, `login_attempts`, `events`, `install_identity`, `setup_state`.
- Port `packages/auth` (argon2, opaque sessions, rate limiting) with
  `tenant_id` removed.
- `scopeWorkspace()` — the single decision point.
- `requireOwnerOrShared()` — the **new** axis: private-by-default resources.
- `requireSuperAdmin()` — policy only; a companion `assertNoContentAccess()`
  DTO helper for admin responses.
- CSRF (double-submit + `SameSite=Lax`), secure cookie flags, session rotation.

**Acceptance:**
- Over-the-wire tests: anonymous → 401 on every protected route; member cannot
  reach any `/api/admin/*`; **member A cannot read member B's private resource
  by guessed id**; super admin gets 403 on content endpoints, 200 on metadata.
- CSRF: a cross-origin POST without the token is refused.
- Exactly one super admin can exist (DB constraint proven by test).

**Risk:** per-user isolation is new — a missed check is a mail leak between
colleagues. Mitigated by one helper + a test per private resource type.

---

## Phase 2 — Packaging: Docker Compose, Caddy, health, multi-arch

**Goal:** `docker compose up` produces a working, HTTPS-terminated install.

- Services: `web` (API+SPA), `worker`, `postgres`, `caddy`.
- Profiles: `ocr`, `clamav` — **not started** unless enabled.
- Master key as a Docker **secret/file**, never an env var, never in the DB.
- `/health` (liveness) and `/ready` (DB + migrations + master key present).
- Multi-arch build: `linux/amd64`, `linux/arm64`.
- Bring-your-own-proxy mode documented, Caddy disabled by a profile.
- Non-root containers, read-only rootfs where possible, dropped capabilities.

**Acceptance (met — see `PHASE_2_EVIDENCE.md`):**
- Clean `up` from a **clean, uniquely named Compose project** on a Docker
  daemon. *Not* a literally empty daemon: the host that could have provided one
  no longer exists, and emptying the available host would mean removing 24
  unrelated running containers. The project is torn down to zero
  containers/volumes/networks and asserted before each run, so what is proven is
  that CE installs with nothing of its own pre-existing.
- `/ready` green after migrations, and each blocker (`database`, `migrations`,
  `master_key`) proven independently. The red-before-migrations case is asserted
  against a stub database in the unit suite rather than by racing the migrator
  at runtime.
- OCR/ClamAV absent from `docker ps` when disabled, **and** the ClamAV image
  never pulled.
- Multi-arch manifest published to a private registry and proven to resolve per
  platform on pull.
- Image sizes recorded as **total** footprint, not the unique-layer figure
  `docker image inspect` prints. No capacity claims (map 97).

**Risk:** ARM64 image bloat on low-end hosts → measured: 372 MB total, of which
~286 MB is the Node base. Heavy services stay opt-in. A future phase should
evaluate an Alpine base, which would cut roughly 200 MB but requires musl
prebuilds for `@node-rs/argon2`.

**Risk realised:** profile coupling. Caddy was profile-gated so BYO-proxy could
be selected, which meant naming *any* profile dropped it — so the documented
command for enabling OCR took HTTPS offline. Required services now carry no
`profiles` key, asserted by test.

---

## Phase 3 — Setup wizard

**Goal:** first-run experience, and the only path that creates the super admin.

Steps: host checks → owner account → domain/HTTPS → LLM → SMTP ×2 →
connectors (optional) → security/privacy → telemetry opt-in → review/finish.

- Wizard is reachable **only** while `setup_state.completed = false`; afterwards
  it 404s.
- Writes encrypted secrets through the master key.

**Acceptance (met — see `PHASE_3_EVIDENCE.md`):** a fresh DB serves the wizard
and refuses all other routes (503, `setupRequired: true`); after completion every
setup route is 404 and cannot recreate a super admin; a half-finished wizard
resumes at the first incomplete step across a process restart; telemetry is off
unless affirmatively ticked. 124 static tests, 37 runtime checks, 8 mutations all
caught.

**Scope note:** Phase 3 delivers the setup API and its state machine. The
wizard's screens are Phase 6, with the rest of the web app.

**Risk (realised and handled):** the wizard is an unauthenticated super-admin
factory. Single-use, state-machine gated, bound to the stored install identity.
The single-use guarantee was initially UNTESTED — pglite serialises queries, so
an HTTP-level concurrency test could not reach the SQL latch. Fixed by extracting
`sealSetupOnce()` for direct testing and by proving genuine concurrency against
real PostgreSQL at runtime.

---

## Phase 4 — LLM providers

**Goal:** OpenAI, Anthropic, xAI, and OpenAI-compatible self-hosted.

- Primary + optional explicit fallback (map 85).
- Capability probe: chat, structured output, tool calling, context length —
  results stored; dependent features disabled with a clear reason (map 86).
- Caps: installation-wide + per-user, warn at 50/80/100%, hard stop (map 87).
- Usage: exact provider charges vs **labelled estimates**; self-hosted reports
  `$0 provider charge` (map 88).
- Local-only mode: blocks external providers and fallback, persistent badge
  (map 90).
- External provider activation requires an explicit acknowledgement (map 89).
- **Subscription options:** built as a capability-gated choice that stays
  **hidden/disabled** because no compliant provider-supported path exists today.
  No session scraping, no Claude Code/Codex token reuse (map 83).

**Acceptance:** probe failures disable the right features; caps hard-stop at
100%; Local-only refuses an external provider at the API layer, not just the UI;
subscription option renders disabled with an honest explanation.
**Risk:** SSRF via the self-hosted base URL → allowlist scheme/port, block
link-local/loopback/metadata ranges, no redirects.

**Status: done.** 65 tests, 21/21 mutations caught, 47/47 runtime checks on a
real stack. See `PHASE_4_EVIDENCE.md`.

**Amended during the phase — SSRF.** "Block loopback" and M84's "cover Ollama,
vLLM, LM Studio" cannot both hold: those runtimes live on loopback and private
addresses. Only the super admin can set this value, and they already administer
the host, so the classic SSRF threat is absent. Cloud metadata is blocked on
every resolved address, redirects are never followed, and addresses are
re-validated at request time; loopback and LAN are allowed. Both directions are
tested.

---

## Phase 5 — Assistant core

**Goal:** Josi actually works. Port the engine's product.

- `packages/core`: tasks, events, locks, queue, authority, second factor,
  metering, metrics.
- `packages/agent`: owner agent + provider adapter over Phase 4.
- Migration `0002_assistant.sql`: tasks, threads, messages, contacts, holds,
  approvals, usage ledger.

**Acceptance:** the engine's task-state-machine and authority tests pass against
CE's schema; approval gates behave identically.
**Risk:** silent behaviour drift while removing `tenant_id` → port the engine's
tests alongside the code.

**Status: done.** 109 tests, 26/26 mutations caught, 50/50 runtime checks on a
real stack. Migration is `0004_assistant.sql` (0002 and 0003 were taken by the
wizard and the LLM layer). See `PHASE_5_EVIDENCE.md`.

**Amended during the phase — two departures, both argued rather than applied
quietly.**

1. **Isolation.** `EXTRACTION_MAP.md` had `contacts`, `tasks` and `threads`
   workspace-shared, carried over from the engine. They are **owner-scoped**
   instead: a CE workspace is several people sharing an installation, not one
   business speaking with one voice, and the canonical map makes content private
   unless its owner shares it. The risk line above was right — this is exactly
   where drift would have hidden.
2. **Second factor.** The engine's PIN word answers caller-ID spoofing, which CE
   does not have. What ships is step-up **re-authentication** against a held
   session, named accurately. A genuine second factor (TOTP) is not built.

The engine's `authority.ts` inbound-routing tests could **not** port: they
resolve a caller by phone number to decide owner-vs-receptionist, and CE has no
voice channel. The second-factor gate's discipline ported in full; its factor did
not.

---

## Phase 6 — Web app

**Goal:** the tenant workspace UI, mobile-first, official Josi branding.

- Dashboard, Talk, Tasks, Approvals, Conversations, Contacts, Business profile,
  Connections, Usage; admin section for policy.
- Companion apps page: **Coming soon**, no fake download actions (map 101).
- The future native-app bootstrap is email-first: the super admin allowlists an
  email under **Approved app users**; CE publishes only an opaque routing record
  to the Josi directory; the app discovers the CE endpoint by email and submits
  the user's password directly to that verified HTTPS endpoint. The directory
  never receives passwords, sessions, messages, connector data, or tenant
  content. CE returns a device-specific revocable session. Paired devices cache
  the verified endpoint and continue operating directly during directory
  outages. Local usernames are not discovery keys because they can collide
  across installations. Manual URL entry is an Advanced fallback. Removing an
  approval and revoking already paired devices are separate explicit controls.
- Branding mandatory and not replaceable (map 81).

**Acceptance:** Playwright at 320/375/390/430 — no horizontal overflow, controls
≥44px, keyboard navigable; no placeholder presented as working.
**Risk:** regressing the engine's iPhone Talk behaviour → port the WebKit
touch-send test with it.

**Status: done.** 43/43 browser checks in WebKit with touch emulation, 28/28
runtime checks, 339 unit tests. The setup wizard's screens, which Phase 3
deferred here, are included. See `PHASE_6_EVIDENCE.md`.

**Amended during the phase — CE fetches nothing from anywhere.** The engine
loads fonts from a CDN; a self-hosted product doing that tells a third party the
IP of everyone who opens it, breaks air-gapped, and contradicts the Local-only
badge. CE uses the system font stack, and `default-src 'self'` makes that
checkable rather than a promise.

**The browser found a defect four phases of green suites had not.** The admin
model page crashed because Phase 4 wrote a jsonb column with `JSON.stringify`
and a cast instead of the `json()` helper — silent under pglite, permanent under
postgres.js. Verified that the unit suite *cannot* catch it by re-introducing
the bug; a static check on the shape now can.

---

## Phase 7 — Connectors

**Goal:** Google + Microsoft, operator's own OAuth client, per-user auth.

- Operator client id/secret from the DB, encrypted (map 28).
- Per-user connection + tokens (map 29–30).
- **Incremental scopes**: read first, re-consent for write (map 32).
- Per-write-action approval level: Always ask / risky only / routine automatic;
  default Always ask; admin may tighten, never loosen (map 33).
- Admin sees connection health, can revoke, **cannot browse content** (map 30).
- Box/Dropbox: disabled "Coming soon" entries only.

**Acceptance:** admin endpoints return no message/event content; a user cannot
act on another user's connection; enabling send forces re-consent; admin
tightening overrides user preference but admin loosening is refused.
**Risk:** deny-only policy inverted by accident → an explicit
`effectiveCapability = min(userGrant, adminPolicy)` function with a truth-table
test.

**Status: done.** All four acceptance criteria proven over the wire and again at
runtime. 92 new tests (431 total), 24/24 mutations caught, 58/58 runtime checks.
See `PHASE_7_EVIDENCE.md`.

The named risk is answered by `effectiveCapability`, with the truth table asked
for plus a monotonicity test: from fully enabled, flipping any single input to
false makes the answer false. The policy table has an `allowed` column and no
`granted` column, so the shape itself cannot bestow.

**Two mutations were not caught first time**, and both are recorded rather than
quietly fixed: a callback that trusted `?user=` (latent — no test supplied one),
and the client secret's ciphertext being returned to the admin, which is the
same defect Phase 4's M18 exposed and which I failed to carry across.

---

## Phase 8 — Mail: SMTP profiles + operational email

**Goal:** two profiles, identity-preserving sending, optional reply ingestion.

- `System mail` and `Josi communications`, copy-from-system option with a
  distinct From identity (map 34).
- "Roman via Josi" display identity, replies route to the initiating user's
  conversation (map 35).
- Optional inbound (IMAP/API), super-admin gated capability that grants **no**
  content access (map 36).
- Threads private to initiator; sharing is explicit (map 37).
- Admin sees delivery metadata only (map 38).
- Retention + 30-day trash, admin-configurable (map 39–40).
- Mandatory AI disclosure, wording customisable, not removable (map 41).
- Operational-only: multi-recipient threads yes, BCC blasting no (map 42).
- New recipient on an existing thread → approval showing exactly what history is
  exposed (map 43).
- Attachments always require approval with a preview (map 44).
- Loop prevention.

**Acceptance:** admin metadata view asserted to contain no subject/body; adding
a recipient without approval is refused; attachment send without approval is
refused; a reply loop terminates.
**Risk:** an unowned shared inbox forming → every inbound message resolves to an
initiating user or is quarantined.

**Status: done.** 522 tests, 31 of 31 mutations caught, 60 runtime checks on
a Linux test host. Evidence: `docs/PHASE_8_EVIDENCE.md`.

Runtime ran a **real SMTP server** on the project network rather than a stub, so
nodemailer's actual EHLO/DATA path executed and the test could read the bytes
that would have gone out: the From identity, the Reply-To routing token, the
disclosure, the loop-prevention headers, and the absence of a Bcc. No mail left
the host.

**Three defects worth remembering.** A message *fingerprint* was passed where
`requestApproval` expected a *payload*, so it hashed the hash and no approval
could ever match — every attachment and new-recipient send would have been
impossible in production. The unit test missed it by building approval rows by
hand; the wire test caught it. Mutation M14 exposed that `smtpTransport`, the
function production uses, was called by no test at all, leaving its error
sanitising unprotected — the worst place for it, since a bounce quotes the
message that bounced. And **M37 was only half built**: the ownership spine had
honoured shares since Phase 1, but no HTTP route could create one, so "private
unless shared" held only because sharing was impossible.

---

## Phase 9 — Documents and storage security

The largest phase. Default deny throughout.

- Local: Docker bind mounts **plus** an application allowlist (map 45).
- Cloud: Drive/OneDrive, per-folder mapping, not account-wide (map 46).
- Read-only start; create/edit/move/delete separately granted; delete always
  approved (map 47).
- Dual gate: admin approves mapping capability **and** user consents (map 47).
- Admin approval sees metadata only (map 48).
- Indexing is a separate consent; recursive "and all subfolders" scope shown
  plainly and covering future children (map 49–50).
- Postgres FTS default; optional semantic indexing with an explicit
  data-leaves-server disclosure; forbidden in Local-only (map 51).
- OCR bundled, off by default, admin-only, throttled, hour-restricted (map 52–53).
- Purge on unmap/revoke: text, OCR output, FTS rows, embeddings (map 54).
- Admin limits: file size, extensions, total storage, per-user quota (map 55).
- ClamAV optional container; finding blocks processing, never modifies the
  source; admin-controlled definition updates; two scan modes (map 56–59).
- Document history: off / 1 / 2 versions; snapshots vs recovery copies; storage
  warning; quotas; purge (map 60–62).
- Encrypted/password-protected files skipped with a per-file reason (map 64).
- Archives excluded by default; bounded extraction if enabled (map 65).
- Citations with precise locators + Open source (map 67).
- Private by default; explicit sharing; admin may disable sharing (map 68–69).
- User removal purges private data; shared data must be transferred or purged
  (map 70).
- Revocation purges derived memory; sent messages are not rewritten (map 71).
- Audit trail, metadata only, retention 30d/90d/1y/forever, default 1y (map 72–73).
- Per-folder status + admin aggregate health (map 74).
- Global pause that preserves existing search (map 75).
- Local watch; cloud scheduled sync 5/15/30/60m; rate-limited Sync now; admin
  may disable manual sync (map 76–77).
- Token expiry pauses the mapping and notifies the user (map 78).
- Recycle bin 7/30/90d in recovery-copy mode (map 79).

**Acceptance:** unmapping purges every derived artefact (asserted per artefact
type); admin endpoints expose no filenames or content; archive extraction is
bounded (zip-bomb fixture); path traversal rejected; ClamAV finding blocks but
leaves the file byte-identical.
**Risk:** the highest-risk phase — extraction, OCR and watching all touch
untrusted bytes. Each gets an explicit threat-model entry and a hostile fixture.

**Status: security spine done and verified; the machinery that touches real
bytes is not built.** 734 tests, **97 of 97 mutations caught**, **94 runtime
checks on a Linux test host with 0 failures**. Evidence: `docs/PHASE_9_EVIDENCE.md`.

Built in four cycles, and the first was entirely about the GRANT rather than the
parser — because a bad parser crashes and a bad grant quietly works. Containment
is normalise → structural check → resolve symlinks → check again, tested against
real symlinks including the sibling-prefix case (`docs-private` vs `docs`) where
the common `startsWith` answer fails. The dual gate is asymmetric: there is no
admin route into `createMapping`, so an administrator cannot map a folder for
somebody else and then read it out of the index they also run.

**Not built: parsers, OCR, a deployed ClamAV, cloud sync, filesystem watching,
embeddings, recovery-copy writing, and the storage screens in the web UI.** The
controls are in place and proven before anything is wired to them, which is the
right order for this phase — but an installation running this code can map a
folder and search nothing, because nothing fills the index.

Runtime verification took five runs and found two product defects the unit suite
could not: `npm ci` failing on a clean host because the lockfile never learned
about the new workspace, and a compose file with no `/data` mount at all —
nowhere to bind a shared folder and nowhere for a recovery copy to live.

Phase 1's append-only trigger refused the M73 retention sweep — the guard working
as designed. Rather than a bypass flag, the trigger now permits deleting only
rows already past the configured window.

---

## Phase 10 — Backup, export, updates, diagnostics

- Encrypted restorable backup ZIP: data + config + uploads + history copies;
  master-key strategy documented and deliberate (map 63, 100).
- Portable human-readable export ZIP, excluding history duplicates (map 63).
- Update: never automatic; check stable channel; one-click approve; pre-update
  backup; health check; **roll back on failure**.
- Diagnostics ZIP: inspectable, redacted, secret-scanned, explicit approval,
  ≤25 MB, 1h/24h/7d windows, never prompts/content/rows (map 102, 109, 112–113).
- Support gateway **contract only** — no Zammad credentials (map 115).
- Telemetry client, opt-in, anonymous (map 98).

**Acceptance:** backup → wipe → restore reproduces a working install *including*
encrypted credentials given the master key, and demonstrably fails without it;
a failed update rolls back automatically; a diagnostics bundle is asserted to
contain no message/document rows.
**Risk:** a backup that cannot actually be restored → the restore test is the
acceptance criterion, not the backup test.

**Status: done, with named shortfalls.** 827 tests, **49 of 49 mutations
caught**, **47 runtime checks on a Linux test host with 0 failures** — a real `pg_dump`, a
real schema drop, a real restore. Evidence: `docs/PHASE_10_EVIDENCE.md`.

The stated risk was exactly right. **819 unit tests passed against a backup
feature that was non-functional on a real installation for three independent
reasons**: production had no writer at all, the backup volume was root-owned
while the app runs as `node`, and `pg_dump` 15 refuses to dump a `postgres:16`
server. Each alone was fatal; none was visible to a unit test.

The mutation harness's own `assert_mutated` had never fired across Phases 7–10 —
it compared partial trees, so it always reported "mutated". Fixed, and it caught
a non-applying mutation within minutes.

**Not built:** no update has ever been applied (rollback is proven as logic, not
as a deployment); the portable export is a `pg_dump`, not the human-readable
export M63 describes; diagnostics collect no logs or container health because
the app has no Docker socket; restore does not verify an archive belongs to this
installation; and there is no backup retention or scheduling.

---

## Phase 11 — Hardening, threat model, release

- Threat model document covering setup, auth, connectors, mapped folders,
  archive extraction, OCR, ClamAV, backup/restore, update/rollback, diagnostics
  upload, LLM tool execution.
- Rate limiting, audit logging, upload/archive limits, SSRF defences,
  least-privilege containers.
- Full test sweep; image sizes and platforms recorded.
- `README` with fresh-install, upgrade, rollback, backup/restore steps.

**Acceptance:** every threat-model entry links to a control and a test or is
explicitly accepted with a reason.

---

## Phase 12 — Identity, memory, and constrained behaviour

**Product doctrine:** *OpenClaw's soul, Apple's product discipline.* Josi CE
must feel personal, continuous, and owned by the person using it without
becoming an open-ended agent framework. The compiled CE core remains the final
authority for security, privacy, ownership, approvals, tool permissions,
auditing, and supported capabilities. No administrator setting, user setting,
Markdown file, memory, or current request may weaken those invariants, create a
new capability, or grant access.

- Per-user `SOUL.md`: assistant name, identity, relationship, tone, humour,
  communication style, and personal boundaries. Supply useful presets and a
  live response preview, but allow a fully custom personality (map new).
- Per-user `USER.md`: the person's self-description, preferences, names,
  locale, working style, and other user-maintained context (map new).
- Two constrained `AGENTS.md` layers: an installation policy controlled by the
  administrator and a per-user workflow profile. These may tune only choices
  the core explicitly exposes (proactivity, formatting, research behaviour,
  escalation preferences, and supported-tool workflow); they are not raw
  system-prompt extensions (map new).
- Per-user `MEMORY.md`: curated durable facts, separate from conversation
  history and from document/email recall. Users can view, add, edit, pin,
  confirm, and truly delete memories (map new).
- Optional automatic memory *suggestions* from conversations. The user chooses
  manual approval or an explicitly enabled automatic mode. Never retain raw
  passwords, tokens, payment data, or connected-source content by default.
- Every memory records provenance, creation time, last confirmation, and
  confidence. Revoking or deleting a source purges every derived memory while
  leaving unrelated conversation history intact (map new; extends map 71).
- Import/export all four portable Markdown files. The database is canonical so
  container replacement and upgrades cannot erase them. Round trips preserve
  content and versions (map new).
- Imported Markdown is untrusted data parsed into bounded configuration, never
  concatenated into an unrestricted privileged prompt. Reject unsupported
  fields, enforce size limits, and make ignored instructions visible to the
  user rather than silently pretending they applied (map new).
- Prompt assembly order:
  `immutable CE core → admin policy → user workflow policy → Soul/User context
  → relevant retrieved memory → current request`. Only relevant memories enter
  a turn; the whole memory file is not repeatedly stuffed into context.
- Settings surfaces for Soul, About me, Working style, and Memory, including
  version history, reset, import, export, and a precise explanation of what each
  layer can and cannot change.
- First-run personalization is optional and skippable. Defaults preserve the
  current brief/direct personality and the assistant works before any profile
  is created.
- Backup, restore, export, retention, deletion, audit, and ownership isolation
  cover all four profile types.

**Acceptance:** two users on one installation receive demonstrably different
personalities, workflow preferences, and memories without cross-user leakage;
import/export is an exact round trip; restart, backup/restore, and upgrade retain
all profiles; reset changes no conversations or unrelated memory; deleted memory
cannot be recalled; a hostile profile attempting to disable approvals, expose a
secret, access another user, invent a tool, or alter core policy has no effect
and the invariant tests prove it.

**Risk:** reproducing OpenClaw's unrestricted instruction-file semantics would
turn personalization into privilege escalation. CE deliberately reproduces the
personal *experience*, not the authority model.

**Status: done.** Every item in the phase text above is implemented and verified.
1088 tests, **56 of 56 mutations caught** across three scripts, and **133 runtime
checks on a Linux test host** in two suites — 68 for personalization and 65 for backup and
restore — with 0 failures. Evidence: `docs/PHASE_12_EVIDENCE.md`.

The one thing still unmeasured is upgrade retention, for the same reason as
Phase 10: nothing downloads a release, so "upgrade retains all profiles" follows
from the database being canonical rather than from a measurement.

A profile never becomes instructions: Markdown is parsed into a bounded
configuration of named fields with enumerated values, and `AGENTS.md` has no
free-text field at all. The load-bearing part is not the prompt — approvals,
ownership and tool permission are enforced by routes reading database rows,
outside the assembled string entirely, so a model persuaded by a hostile
personality still cannot act.

**Phase 12.1 closed the two gaps this originally left open.** Personalization now
reaches every live turn — core, authority note, admin policy, narrowed user
preferences, soul, user and relevant memory as the system context, with the
request in one user message — and every completed exchange runs a bounded
extraction that honours the person's memory mode. 1069 tests, **17 of 17**
additional mutations, **68 runtime checks on a Linux test host with 0 failures**, including
two people receiving different personalities in real model calls.

**Phase 12.2 built the rest of the phase text:** optional and skippable first-run
personalization, five presets, a live response preview that really calls the
model and stores nothing, version history surfaced in Settings with per-version
restore, and profile backup/restore measured on a real `pg_dump` → wipe →
restore rather than inferred. 1088 tests, **9 of 9** further mutations, **65
additional runtime checks on a Linux test host**.

**Every item in the Phase 12 text is now implemented.** The one thing still
unmeasured is upgrade retention, for the same reason as Phase 10: no update has
ever been applied, so "upgrade retains all profiles" follows from the database
being canonical rather than from a measurement.

The runtime run found the Phase 6 jsonb defect recurring in a package written six
phases later, which the static guard added after Phase 6 could not see because it
knew only one of the bug's two shapes.

**Release position:** first post-0.1 product phase. Phase 11 closes and hardens
the current 0.1 scope; Phase 12 then adds personalization as a separately tested
feature rather than expanding the release boundary during hardening.

---

## Phase 13 — Launch gaps

**Why this phase exists.** Phases 0–12 built a product that installs, isolates,
assists and personalises. What they did not build is everything a person needs
in order to *reach* it from a phone, everything an operator needs in order to
*keep* it, and the parts of Phase 9 and Phase 10 that were honestly recorded as
unbuilt. This phase closes those, and it closes them with the same rule the
earlier phases used: a claim is not made until a test or a measurement supports
it, and a shortfall is named rather than rounded up.

Requirements are numbered **L1–L9** and each is decomposed into testable items
in the traceability matrix below. The matrix is the acceptance criteria; this
prose is the reasoning.

### 13.0 — Edition capability boundary (L4, built first)

Nothing else in this phase is safe to build until this exists, because L3 is a
capability that **must not be reachable** in a hosted or white-label build. A
feature flag read from the environment is not that: an environment variable is
whatever the process that started the container says it is.

So the edition is **stamped into the build**. `packages/core/src/editionBuild.ts`
holds a single generated constant, written by `scripts/stamp-edition.mjs` from a
Docker build argument, and it is the only source of the edition. The environment
may **narrow** the capability set and may never widen it, so a hosted image with
`JOSI_EDITION=ce` in its environment is still hosted. The capability set is
deep-frozen at module load.

Enforcement is server-side and layered, because a boundary with one check is a
boundary with one bug: the route is not mounted, the route guard refuses, the
provider factory refuses, and the registry refuses again at call time. A row
inserted directly into the database by someone with psql cannot make the feature
work.

### 13.1 — Telegram as a first-class channel (L1)

CE's answer to "I want Josi on my phone" has been *Coming soon* since Phase 6.
Telegram is the shortest honest path to a real one: no app-store review, no
push-notification infrastructure, no companion binary, and the operator's own
bot token means no Josi-operated relay ever sees a message.

The security shape is the interesting part, and it is the reverse of the usual
bot tutorial. A Telegram `chat_id` is an **unauthenticated claim**. Anybody who
finds the bot can send it a message. So the default for an unknown chat is
refusal, linking is a deliberate act by an already-signed-in user, and the link
code is single-use, short-lived, high-entropy and stored only as a hash — the
same discipline Phase 1 applied to session tokens, for the same reason.

Routing is per-user and per-conversation: a linked chat resolves to exactly one
CE user and that user's own conversation, so the ownership spine from Phase 1
governs Telegram exactly as it governs the web app. Group chats are refused
outright, because a group has no single owner and an unowned inbox is the
failure mode Phase 8 named.

### 13.2 — A real installable PWA (L2)

The caching rules are the security work here, not the manifest. A service
worker is a persistent, origin-scoped cache that survives sign-out, so a
mistake in it is a data leak that outlives the session. CE's rule is absolute
and enforced by a single tested predicate: **the service worker caches build
assets and the app shell, and nothing else**. No `/api` response is ever
cached, read from cache, or served from cache — not even a 200, not even a
GET, not even while offline. Offline shows a shell that states it is offline
and can display nothing.

### 13.3 — Noncommercial subscription authentication (L3)

Phase 4 shipped this as "hidden and disabled because no compliant path exists".
That was correct in August 2026 and it is now half-correct, so half of it is
removed and the other half is kept with a citation rather than a shrug.

**Anthropic: still no supported path, and now explicitly prohibited.** Anthropic's
authentication and credential-use policy restricts Claude Free/Pro/Max OAuth to
Claude Code and Claude.ai, states that using those tokens in any other product,
tool or service — *including the Agent SDK* — is not permitted, and was enforced
against third-party harnesses on 4 April 2026. CE therefore keeps Anthropic
subscription authentication structurally unavailable, and the UI says why and
cites the policy instead of saying "coming soon".

**OpenAI: a supported path exists, and it is delegation, not impersonation.**
OpenAI documents `codex exec`, a non-interactive mode of the first-party Codex
CLI, and documents that the CLI may be signed in with a ChatGPT plan. CE does
not implement "Sign in with ChatGPT", does not touch `~/.codex/auth.json`, does
not parse, copy, store, forward or refresh any token, and does not speak to any
OpenAI endpoint on this path. It runs the operator's own unmodified Codex binary
as a subprocess under the operator's own login — which is what the operator
would otherwise type into their own terminal.

The limits are stated in the product, not only in the docs: it is
per-installation rather than per-user, it draws on the same rolling quota as the
operator's interactive Codex sessions, no provider cost is reported so every
figure is labelled an estimate, and OpenAI's terms confine it to individual
productivity rather than powering a commercial service. That last clause is
precisely why L4 exists and why this capability lives only in CE.

### 13.4 — Administrator-approved release updates (L6)

Phase 10 built the state machine and proved rollback as logic. What was missing
was everything that makes it safe against a *hostile* update rather than a
broken one: nothing verified that a release was authentic, nothing verified that
it was newer, and nothing measured whether the data survived.

Releases are now described by a signed manifest — Ed25519 over a canonical
serialisation, verified against a public key stamped into the build alongside
the edition, so the trust root is in the image rather than in the database an
attacker just reached. Downgrade is refused. The pre-update backup was already
mandatory and stays mandatory. The health gate now includes a **retention
measurement**: row counts for profiles, memories, conversations and documents
are taken before the update and compared after, and a drop rolls the update back
even though the container is healthy and the migration succeeded.

Applying is honest about where it happens. The app has no Docker socket, by
design and by Phase 10's threat model, so it cannot replace its own container.
It records an approved, verified update request; `scripts/josi-update.sh` on the
host performs the pull-by-digest, the replacement, the health poll and the
rollback. Nothing polls for updates and nothing applies one without an
administrator pressing a button.

### 13.5 — Completing the document pipeline (L7)

Phase 9 said it plainly: "an installation running this code can map a folder and
search nothing, because nothing fills the index." This builds the part that
fills it, and it deliberately supports a small set of formats completely rather
than a long list badly. Anything outside the set is `unsupported_type` with the
reason shown to the owner — the vocabulary Phase 9 already built for exactly
this.

### 13.6 — Real-integration harnesses (L8)

Every provider in CE is stubbed in tests, which is correct and which is also why
nobody has ever seen CE talk to Google. These harnesses do, when credentials are
supplied. When credentials are not supplied they exit `3` and print `SKIPPED`,
and `SKIPPED` is not `PASS` in any summary, any document, or any exit code.

### 13.7 — Clean-install acceptance (L9)

Scripts and operator checklists for amd64 and arm64 including the two low-resource
profiles. **Not yet run.** No hardware result is claimed in this repository until
the hardware has run it, per M97.

### 13.8 — Installer productisation (L10)

The current install is technically workable but exposes too much plumbing. The
normal path must resemble Nginx Proxy Manager: copy one ready Compose YAML (or
download it verbatim), change only the few values the operator actually owns,
and run `docker compose up -d`. The first-run web wizard handles application
configuration. Operators must not need to understand the repository layout,
build local images, manually create Docker networks or volumes, or assemble
secrets by hand.

- Publish versioned multi-architecture images so the normal install pulls a
  release rather than cloning source and building it locally.
- Provide one production Compose file with safe defaults, named volumes,
  health checks, migration ordering, Caddy, and generated installation secrets.
- Keep required edits minimal and explicit: public domain when HTTPS is wanted;
  documented LAN-only behaviour otherwise. Optional settings belong in an
  example environment file and are not prerequisites for first boot.
- Make the happy path short enough to copy as one block. Put source builds,
  custom networks, external PostgreSQL, reverse-proxy replacement, and other
  topology choices in an Advanced section.
- Detect incompatible Docker installations and permissions before pulling or
  building anything, including the Ubuntu Snap Docker/socket-group failure
  found during the N150 install.
- Fix installer/check output so permission modes are parsed portably and never
  print filesystem `stat` diagnostics as the mode.
- Measure the published-image path on clean amd64/N150 and arm64/Raspberry Pi 4
  hosts, including first boot, migrations, health/readiness, wizard access,
  restart persistence, and uninstall instructions that distinguish containers
  from user data.

A **dockerless/native installer** is a separate optional track, not a replacement
for Compose and not a launch claim until supported. Investigate a one-line
`curl ... | sh` bootstrap that installs a pinned release, PostgreSQL, a systemd
web service, worker service, reverse proxy/TLS, dedicated service account,
directories, permissions, upgrades, rollback, backup, and complete uninstall.
The bootstrap must download a versioned script, verify its checksum/signature,
support a download-then-inspect workflow, and fail before mutation on an
unsupported distribution. It may not silently curl and execute an unpinned
moving target. If the native path cannot match the container path's isolation,
upgrade safety, and test coverage, it remains experimental rather than becoming
a second half-supported installation architecture.

---

### Phase 13 traceability matrix

Status values are the same as `DECISION_TRACEABILITY.md`. `Blocked` means the
work is built but its evidence needs something this environment does not have,
and the blocker is named.

| ID | Promise | Acceptance criterion (testable) | Status |
|---|---|---|---|
| **L4.1** | Edition immutable at build | `editionBuild.ts` is generated from a build arg; `scripts/stamp-edition.mjs` writes it; the Dockerfile passes `JOSI_EDITION`. Test: default build is `ce`; a stamped `hosted` build reports `hosted`. | Done |
| **L4.2** | Environment cannot widen | Test: with a `hosted` build stamp, `JOSI_EDITION=ce`, `JOSI_CAPABILITIES=subscription_auth` and every spelling variant leave `subscription_auth` absent. | Done |
| **L4.3** | Enforced server-side, not hidden | Test: on a `hosted` build the subscription routes are absent (404) **and** the provider factory throws **and** `buildProvider` throws for a row inserted directly by SQL. | Done |
| **L4.4** | Capability set immutable at runtime | Test: the exported capability set is deep-frozen; assignment and `delete` do not change it. | Done |
| **L4.5** | Bypass + mutation tests | `scripts/mutate-phase13-edition.sh`: every mutation that widens the boundary is caught. | Written, unrun |
| **L1.1** | Admin bot-token setup + probe | Super admin sets a token; CE calls `getMe`; the bot username and id are stored; a bad token gives a clear refusal and stores nothing. Token is sealed with the master key; ciphertext never leaves the server. | Done |
| **L1.2** | Secure one-time linking | A signed-in user mints a code: ≥128 bits, hashed at rest, single-use, 15-minute TTL, bound to that user. Test: replay refused, expiry refused, another user's code refused, an unlinked chat is refused and told how to link. | Done |
| **L1.3** | Per-user/per-conversation routing | Test: two linked users messaging the same bot reach two different conversations; neither can see the other's; an update whose `chat_id` is not linked creates nothing. | Done |
| **L1.4** | Outbound replies | Test: a reply is sent to the originating chat only, with the AI disclosure Phase 8 mandates. | Done |
| **L1.5** | Formatting | Test: MarkdownV2 escaping is exact for every reserved character; a 10 000-character reply is split at ≤4096 without splitting an escape sequence. | Done |
| **L1.6** | Attachments with safe limits | Test: an over-size attachment is refused before download; a disallowed MIME/extension is refused; the download is byte-capped and a lying `Content-Length` cannot exceed it; a path-traversal filename cannot escape. | Done |
| **L1.7** | Retries and error handling | Test: 429 honours `retry_after` and retries; 5xx retries with backoff; 400/403 do not retry; the bot token never appears in an error, a log line or an audit payload. | Done |
| **L1.8** | Unlink and revoke | Test: a user unlinks their own chat; a super admin revokes any link; after either, messages from that chat are refused. Codes are invalidated too. | Done |
| **L1.9** | RBAC | Test: a member cannot reach any `/api/admin/telegram/*`; a member cannot unlink another member; the admin surface returns no message content (`assertMetadataOnly`). | Done |
| **L1.10** | Audit logs | Test: configure, probe, link, unlink, revoke and refusal all append events, and no event payload carries message text (`assertMetadataOnly` proves it). | Done |
| **L1.11** | Threat-model controls | `THREAT_MODEL.md` entries for webhook forgery, chat-id spoofing, link-code theft, attachment abuse, token exfiltration, group-chat capture, replay — each with a control and a test. The Phase 11 build check enforces the link. | Done |
| **L1.12** | Webhook authenticity | Test: a request with a wrong or missing `X-Telegram-Bot-Api-Secret-Token` is refused before the body is parsed for meaning; the secret is compared in constant time; a replayed `update_id` is dropped idempotently. | Done |
| **L1.13** | Unit/integration/runtime tests | Unit + over-the-wire suites: **done and passing** — 159 tests across 6 files (`packages/channels/test/{linking,inbound,format,api,attachments}.test.ts`, `apps/api/test/telegram.test.ts`). The runtime harness `scripts/test-telegram-runtime.sh` **does not exist**; it was listed here as written when no such file had been created. | Unit/wire done; runtime harness **not written** |
| **L1.14** | Mutation tests | `scripts/mutate-phase13-telegram.sh`, all mutations caught. | Written, unrun |
| **L1.15** | Docs | `docs/TELEGRAM.md` + INSTALLATION.md §17B.1 and §17.12–17.13: setup, linking, revoking, limits, troubleshooting. Webhook only — CE does not implement polling and does not claim to. | Done |
| **L2.1** | Manifest | `manifest.webmanifest` with name, short_name, start_url, scope, display standalone, theme/background colour, and icons. Test: served, correct content type, referenced from the shell, fields present. | Done |
| **L2.2** | Icons | 192/512 any + 512 maskable, generated from the approved brand mark, no regeneration of the artwork (M7–M10). Test: files exist, are PNG, are the declared sizes. | Done |
| **L2.3** | Service worker | Registered, scoped to `/`, served `no-store` so an update is never pinned. Test: registration succeeds in WebKit and Chromium. | Written, unrun |
| **L2.4** | Secure caching rules | One exported predicate decides what may be cached. Test: `/api/*` never cacheable in either direction, any request carrying a cookie or `Authorization` never cacheable, only same-origin GET build assets and the shell are. | Done |
| **L2.5** | Install UX | An install prompt that appears only when the browser offers one, is dismissible, and stays dismissed. Test: no fake button when `beforeinstallprompt` never fires. | Done |
| **L2.6** | Update UX | A waiting worker surfaces "A new version is ready"; the user chooses; `skipWaiting` runs only then. Test: no silent reload. | Done |
| **L2.7** | Offline shell/status | Offline renders the shell with an explicit offline state and no private data. Test: with the network cut, no API payload is rendered from cache. | Done |
| **L2.8** | CSP still holds | `manifest-src 'self'`, `worker-src 'self'` added; nothing external. Test: the existing CSP assertions still pass and the page loads with zero console errors. | Done |
| **L2.9** | Mobile/responsive verification | Playwright at 320/375/390/430 with the PWA surfaces present: no horizontal overflow, controls ≥44px. | Written, unrun |
| **L2.10** | Docs | `docs/PWA.md` + INSTALLATION.md: installing on iOS/Android/desktop, what is cached, what is not, how to force an update. | Done |
| **L3.1** | Research recorded, not assumed | `docs/SUBSCRIPTION_AUTH.md` cites the provider documents and dates for both providers. | Done |
| **L3.2** | OpenAI path is real and supported | Provider `openai_subscription` runs `codex exec` as a subprocess. Test: the command line is exactly the documented non-interactive form; the process environment carries no API key; no HTTP request is made by CE on this path. | Done |
| **L3.3** | Never scrape credentials | Test: no code path reads `~/.codex/auth.json`, any keychain, any browser profile or any cookie jar — asserted by a source-level guard test over the whole repository, not only the new file. | Done |
| **L3.4** | Never misrepresent a key as a subscription | Test: configuring `openai_subscription` refuses an `apiKey` field; the usage ledger records `subscription` as the charge basis and every currency figure on that path is labelled an estimate. | Done |
| **L3.5** | Anthropic honestly disabled | Test: `anthropic_subscription` is refused at the API with a message naming the policy; the UI renders it disabled with the citation; no code path attempts it. | Done |
| **L3.6** | CE-only, structurally | See L4.3. Additionally: test that the hosted build's OpenAPI-visible route table contains no subscription route. | Done |
| **L3.7** | Blanket rejection removed only where earned | Test: the Phase 4 "no compliant path" refusal still fires for Anthropic and no longer fires for OpenAI on a CE build. | Done |
| **L3.8** | Usable from a clean Docker install | The setup wizard offers ChatGPT subscription authentication on a CE build; the published image contains the pinned official Codex CLI; its login survives container replacement in a dedicated per-installation volume; the operator completes device login without exposing credentials to Josi; setup probes the CLI before accepting it; clean-install runtime proves a real model response without an API key. Claude subscription remains unavailable with the policy reason shown. | **Not built — launch blocker found by N150 setup** |
| **L6.1** | Signed release manifest | Ed25519 over canonical JSON, key stamped into the build. Test: a valid manifest verifies; a tampered field, a wrong key, a truncated signature and a missing signature all fail closed. | Deferred (13.4+) |
| **L6.2** | Versioned, no downgrade | Test: a manifest whose version is not strictly newer is refused, including equal versions and non-semver junk. | Deferred (13.4+) |
| **L6.3** | Mandatory backup | Already built; test retained and extended: an update cannot start if the backup step fails or if no backup writer is configured. | Deferred (13.4+) |
| **L6.4** | Health gate | Already built; retained. | Deferred (13.4+) |
| **L6.5** | Measured retention | Test: profiles/memories/conversations/documents counted before and after; a post-update drop rolls back even when the health check passes. | Deferred (13.4+) |
| **L6.6** | Rollback | Already built; extended so a rollback also restores the recorded release digest. | Deferred (13.4+) |
| **L6.7** | No automatic updates | Test: no setting, column or scheduler can trigger an update; the check is a read; the worker has no update job. | Deferred (13.4+) |
| **L6.8** | Host-side apply | `scripts/josi-update.sh`: pull by digest, verify digest, replace, poll health, roll back. Documented as host-side and why. | Deferred (13.4+) |
| **L6.9** | Docs | `docs/UPDATES.md` + INSTALLATION.md §16 rewritten against the real mechanism. | Deferred (13.4+) |
| **L7.1** | Scan | ClamAV wiring reaches a real scanner via the optional profile; with the profile off, `scanRequired` is false and nothing pretends otherwise. Test retained from Phase 9 plus a real-clamd path in the runtime script. | Deferred (13.4+) |
| **L7.2** | Parse | Supported: `txt`, `md`, `csv`, `tsv`, `json`, `html`, `docx`, `xlsx`, `pptx`. Test: a real file of each type yields text and a precise locator; every other extension yields `unsupported_type`. | Deferred (13.4+) |
| **L7.3** | Bounded archive extraction | `zip` only, when enabled: bounded by entry count, total bytes, compression ratio and depth. Test: a zip bomb is stopped, traversal entries are refused, symlink entries are refused. | Deferred (13.4+) |
| **L7.4** | OCR where applicable | The OCR service processes `pdf`, `png`, `jpg`, `tif` when the profile is enabled and the admin has turned it on, within the hour restriction and throttle Phase 9 built. Test: queued, throttled, hour-gated, and `from_ocr` recorded. **PDF text is obtained via OCR only** — CE ships no PDF text-layer parser and does not claim one. | Deferred (13.4+) |
| **L7.5** | Sync/index | Local folders are walked on a schedule and on demand; cloud mappings sync at 5/15/30/60m; the FTS index is filled and kept current; deletions remove rows. Test: end-to-end map → ingest → parse → index → search finds it; delete → search does not. | Deferred (13.4+) |
| **L7.6** | Purge | Phase 9's purge extended to cover the new artefacts. Test: unmap removes text, segments, FTS rows, embeddings, OCR output and version copies. | Deferred (13.4+) |
| **L7.7** | No unsupported claims | Test: the format list in the code, the UI and the docs is one list, and a format absent from it is refused. | Deferred (13.4+) |
| **L8.1** | Hosted LLM harness | `scripts/integration/llm.sh` against a real provider with a real key; `SKIPPED` (exit 3) without one. | Deferred (13.4+) |
| **L8.2** | Google OAuth harness | `scripts/integration/google-oauth.sh`; manual browser step documented; `SKIPPED` without client credentials. | Deferred (13.4+) |
| **L8.3** | Microsoft OAuth harness | `scripts/integration/microsoft-oauth.sh`; same shape. | Deferred (13.4+) |
| **L8.4** | SMTP/reply ingestion harness | `scripts/integration/smtp.sh` sends through a real relay and ingests a real reply; `SKIPPED` without credentials. | Deferred (13.4+) |
| **L8.5** | Never fake a pass | Test: the harness runner's summary reports `SKIPPED` distinctly, exits non-zero-but-not-1 for skips, and `docs/INTEGRATION_CHECKLISTS.md` records the last real run per harness as *never* until one happens. | Deferred (13.4+) |
| **L9.1** | amd64 clean install | `scripts/acceptance/clean-install.sh` — clean daemon assertion, build, up, migrate, wizard, sign-in, teardown, measurements. | Written, unrun |
| **L9.2** | arm64 clean install | Same script, `--platform linux/arm64`. | Deferred (13.4+) |
| **L9.3** | N150 / 16 GB profile | Resource-constrained variant: memory ceiling, no OCR/ClamAV, timings recorded. | Written, unrun |
| **L9.4** | Raspberry Pi 4 / 8 GB profile | Same, with the swap and I/O caveats stated. | Deferred (13.4+) |
| **L9.5** | No unearned hardware claims | `docs/ACCEPTANCE.md` records every profile as **not yet run** until it is. | Done |
| **L5.1** | INSTALLATION.md is true | The Phase 11/12 checklist line is corrected; every section reflects shipped behaviour. | Done |
| **L5.2** | New sections | Telegram, PWA, subscription auth, edition boundary, upgrade, architecture, security, troubleshooting, exact validation steps. | Done |
| **L5.3** | Architecture doc | `docs/ARCHITECTURE.md`: packages, request path, trust boundaries, data flows. | Deferred (13.4+) |
| **L5.4** | Validation steps | `docs/VALIDATION.md`: the exact commands an operator runs to prove an installation is correct, with expected output. | Deferred (13.4+) |

**Resequenced 2026-09-01 by Roman.** The first testable launch milestone comes
before the rest of the phase: **13.0 → 13.1 → 13.2 → 13.3 → doc repair → the
amd64 N150 acceptance script and its failure bundle**, then stop. L6 (updates),
L7 (document pipeline), L8 (real-provider harnesses) and the arm64/Pi profiles
stay in this matrix as subsequent work and must not delay the first N150 build.
No acceptance criterion for the five immediate deliverables was weakened to
achieve that — the rows above are unchanged and their statuses are measured.

**Status vocabulary in the matrix.** `Done` means implemented with a named test
that passes. `Written, unrun` means the code and the harness exist and are
syntax-checked, but the evidence needs something this environment does not have
— a Docker daemon, a browser download, or target hardware — and the blocker is
listed below. `Deferred (13.4+)` is scheduled work that has deliberately not
started.

**Acceptance for Phase 13 as a whole:** every row above is `Done` with a named
test, or carries the exact blocker written down. No row may be marked `Done` on
the strength of an argument.

**Risk:** this phase adds two inbound network surfaces (a Telegram webhook and a
service worker) and one subprocess execution path, which is three new ways in.
Each gets a threat-model entry and a hostile test, and the subprocess path is
gated by a boundary that a hosted build cannot cross.

**Known blockers in this environment, stated rather than worked around:**

1. **No runtime pass is claimed for this phase.** The runtime, clean-container
   and clean-install scripts are written and syntax-checked, and none of them
   has been executed against a running stack. The reason is no longer that a
   Docker host is unavailable: a Linux test host **is** reachable and runs Docker 29.1.3
   with Compose 5.5.0 (checked 2026-09-01). What is missing is different for
   each row — L1.13's Telegram runtime harness has not been written at all, and
   L9.1's clean-install script has not been run. Neither gap is a missing
   daemon, and this entry previously said it was.
2. **No provider credentials.** L8's harnesses cannot be run against Google,
   Microsoft, a hosted LLM, or a real SMTP relay from here, and they are
   recorded as never run.
3. **No target hardware.** L9's N150 and Pi 4 profiles are unmeasured.

---

## Phase 14 — Delegated specialist task workers (v2 roadmap)

**Product intent.** Josi remains the single assistant the user speaks to. For a
bounded, multi-step job such as arranging an appointment, Josi may delegate the
work to a narrow specialist worker. This is not a user-created agent, plugin,
general-purpose sub-agent or second personality. It is a compiled workflow with
a fixed purpose, fixed tools, explicit authority, persistent state and a hard
completion boundary.

Phase 14 establishes a **curated specialist catalogue**, not one scheduling
worker and not an open agent builder. Initial specialist families are:

- **Appointments:** schedule, reschedule, confirm and cancel appointments;
  inspect only relevant free/busy data; account for location and travel time;
  contact the named party through approved channels.
- **Meta marketing:** Meta-specific campaign, audience, creative and reporting
  tools and context only.
- **Google Ads:** Google Ads-specific campaign, keyword, conversion and
  reporting tools and context only.
- **Yelp:** Yelp profile, lead, campaign and reporting tools and context only.
- **Analytics:** read-only cross-channel measurement, attribution, audience
  behaviour, preference and trend analysis. It cannot change a campaign.
- **HR:** curated employee/onboarding/policy workflows with a deliberately
  narrow data boundary and additional sensitivity controls.
- **General administration:** bounded recurring office workflows that do not
  belong to a more privileged specialist. This must not become a synonym for
  unrestricted agent.

Each catalogue entry is decomposed further where authority or context differs.
For example, Meta campaign mutation and Meta reporting need not be the same
worker merely because both use Meta. The smallest useful capability boundary is
preferred over a department-shaped agent carrying every tool in that
department.

For an appointment job, Josi turns the user's request into a structured job
containing the contact, date/time constraints, location and travel-time policy,
permitted channels, deadline, escalation rules and the exact actions already
approved. The worker receives only the minimum context needed for that job and
only scheduling capabilities. It may inspect the requester's relevant
free/busy data, contact the named party, negotiate within the recorded
constraints, place an approved hold or event, wait for replies and report the
outcome. It cannot read unrelated memory or conversations, browse documents,
alter configuration, install software, create capabilities or widen its own
authority.

**Specialist cooperation is mediated, never lateral.** A Meta worker may need
current audience behaviour from the Analytics worker, but it cannot open that
worker's context or call it directly. It returns a typed information request to
the owner Josi/orchestrator. Josi checks the user's authority and purpose,
dispatches a narrow read-only analytics job, then returns only the minimum
answer needed by the Meta job. Every hop is attributable and auditable. No
worker inherits another worker's tools, prompt, credentials or raw context.

**Workers are owned by one user, never pooled by a department or workspace.**
If a marketing department has five employees, it has five separately owned
worker sets. A worker job, state snapshot, temporary context, credential handle,
result, approval and audit subject are all bound to the initiating user. Even
where two employees can legitimately access the same Meta business account,
that shared provider permission does not create shared agent memory, working
state or conversation access. Collaboration occurs only through an explicit
business object or a user-authorised handoff, never because two people have the
same title, department, workspace or integration.

**Delivery order:** email + calendar first, Slack/Teams adapters second, and
telephone last. Telephone is a separate risk tier because realtime calling,
voicemail, disclosure/consent, interruption, retries and exactly-once booking
must all survive partial failure.

**Cost intent.** Delegation is expected to reduce model usage by using a short
fixed prompt, a compact structured state summary, a small tool catalogue and a
lower-cost capable model where policy permits. Waiting consumes no model
tokens. No saving is claimed until measured against the same scheduling task
performed by the owner agent; copying the owner's full prompt, history, memory
or tool catalogue into the worker is explicitly prohibited.

### Phase 14 acceptance boundary

| ID | Promise | Acceptance criterion |
|---|---|---|
| **D1** | Bounded delegation | Only compiled specialist kinds can be created; arbitrary prompts, tools and user-authored agents are refused. |
| **D2** | Least authority | A scheduling job receives only the named user's scheduling data and explicitly enabled channel tools; hostile attempts to access every other capability fail server-side. |
| **D3** | Durable execution | A job survives restart and may wait hours or days without an open model session; each transition records correlation and causation IDs. |
| **D4** | Safe side effects | Contact attempts and bookings are idempotent; retries cannot send duplicate messages, place duplicate calls or create duplicate events. |
| **D5** | Approval and escalation | The worker acts only inside recorded constraints. New recipients, material time/location changes, charges and other policy-defined actions return to the user for approval. |
| **D6** | Privacy | The worker receives a task-specific projection, not the owner's full conversation, profile or memory. Its temporary working context has a documented retention and purge rule. |
| **D7** | Observable control | The user can view status, cancel future actions, answer an escalation and see a plain-language final report. Cancellation cannot undo an external action already completed. |
| **D8** | Channel progression | Email/calendar ships first; Slack/Teams and phone cannot be marked supported until their real-provider harnesses pass. |
| **D9** | Measured economics | A repeatable benchmark reports owner-agent versus specialist-worker input/output tokens, model cost, turns and completion quality. No cheaper claim ships without it. |
| **D10** | Curated catalogue | Specialist kinds and versions are compiled and signed by Josi; administrators may enable, disable and configure supported workers but cannot author arbitrary prompts, tools or capabilities. |
| **D11** | Granular domains | Meta, Google Ads, Yelp, analytics, HR and general-admin workers receive separate schemas, tools, credentials and retention policies; sharing a department label never implies shared context. |
| **D12** | Mediated cooperation | One specialist can request a typed result from another only through Josi. Tests prove no direct worker-to-worker context, credential or tool access and prove that only the minimum result crosses the boundary. |
| **D13** | Per-user worker isolation | Every worker instance, job, state, context, result, approval and credential handle is owned by one user. Tests with five users in one department and a shared provider account prove that no user can discover, claim, resume, inspect or receive another user's worker data. |

**Release position:** post-launch v2. Phase 14 must not expand the current public
release gate or delay Phase 13 clean-install acceptance.

---

## Resequenced 2026-08-30: "smallest secure runnable install" first

Roman resequenced delivery to reach a working product sooner **without weakening
Phase 1**. Order is now:

> **Milestone A (runnable install):** Phase 1 → 2 → 3 → **5** → **6**
> **Then, in dependency order:** Phase 4 completion → 7 → 8 → 9 → 10 → 11

Milestone A is done when a fresh Docker install can: boot, complete setup, create
multiple users, connect a supported LLM path, persist to PostgreSQL, and pass the
hostile authorization tests.

Phase 4 (LLM providers) is *partially* pulled into Milestone A — enough provider
support to satisfy "connect a supported LLM/API path" and the capability probe
that gates dependent features. Caps, fallback, usage attribution and Local-only
enforcement complete in Phase 4 proper, after Milestone A.

Phase 9 (documents/storage) explicitly waits until the core product is
operational, as instructed.

Nothing in Phase 1 is deferred or softened by this resequence. It remains the
first phase and the gate on everything else.

## Sequencing rationale

Phases 1–3 are the trust boundary: model, packaging, setup. Nothing later can
fix a leak introduced there. Phase 4 precedes 5 because the assistant cannot be
tested without a provider abstraction. Phase 9 is last among features because it
depends on connectors (7), mail-grade approvals (8), and the storage/quota
policy surface built in 3.

## Deliberately not built in 0.1

Voice/SMS receptionist (Twilio optional and unwired), audio/video transcription
(map 66), plugin sideloading/marketplace, paid support packaging (map 92),
enterprise/white-label/fleet/hosted billing, Box/Dropbox connectors (Coming soon
only), companion app binaries (Coming soon only).

---

## Launch blockers LB1–LB13 — the release gate

Thirteen blockers were raised against the product as it stood after Phase 13.
They are **not** a new feature phase: they are the gate the 0.1 release does not
pass without. The prose that raised them is preserved verbatim in
`LAUNCH_BLOCKER_FIX_PROMPT.txt`; the closure record lives in `LAUNCH_AUDIT.md`.

The rule from the earlier phases still applies and matters more here, because
these blockers exist precisely because it was broken: **a claim is not made
until a test or a measurement supports it.** A screen, a persisted setting, a
mock-only test or a sentence in a document does not close a row.

> **`LAUNCH_AUDIT.md` is the authoritative status record, not this matrix.**
>
> The rows below state what each promise MEANS and how it would be tested.
> Whether it has been met is recorded in one place, in `LAUNCH_AUDIT.md`, with
> the evidence named. Two places to look up a status is how one of them goes
> stale, and a stale status in a plan is the exact failure this whole set of
> blockers exists to correct — so the individual `Pending` markers below are
> the state at the time the rows were written and are not maintained.

Statuses in the matrix below mirror `LAUNCH_AUDIT.md`. `Blocked` means the code
path is built and the remaining evidence needs a named external dependency.

### LB1 — Appliance-simple Docker installation

| ID | Promise | Acceptance criterion (testable) | Status |
|---|---|---|---|
| **LB1.1** | Install without repository access | A published Compose file pulls versioned images. Test: the production Compose file contains no `build:` key for any required service, and every image reference is a pinned tag or digest. | Pending |
| **LB1.2** | Short copyable happy path | INSTALLATION.md and the docs site both carry a novice block of ≤5 commands that assumes no Node, no checkout, no SSH key. Test: the documented block is extracted by a script and every command it names exists. | Pending |
| **LB1.3** | Preflight exists and gates | `scripts/preflight.sh` checks architecture, OS, Docker Engine, Compose v2, daemon access, port conflicts, disk, memory, filesystem permissions and Snap/package conflicts, and refuses before anything is pulled. | Pending |
| **LB1.4** | Snap-Docker failure named exactly | Test: given a socket that is `root:root` with no `docker` group, preflight identifies the Snap case and prints the exact supported repair rather than a generic permission error. | Pending |
| **LB1.5** | Mode is a number | Test: the permission check returns `600`-shaped numeric output on GNU coreutils and BSD `stat`, and never filesystem-`stat` diagnostics. Regression: the GNU `stat -f` success path that produced `?p`. | Pending |
| **LB1.6** | Disk check does not cry wolf | Test: a healthy large disk (≥ the threshold, including TB-scale and non-integer `df` output) produces no warning; a genuinely small one does. | Pending |
| **LB1.7** | Download-then-inspect preserved | The documented path downloads the Compose file and the preflight script to disk for reading before execution. No step requires `curl … \| sh`. | Pending |
| **LB1.8** | Native installer not overclaimed | Any native/one-line installer is labelled experimental and is absent from the supported-installation documentation until it matches container isolation, rollback, upgrade, uninstall and test coverage. | Pending |
| **LB1.9** | Lifecycle documented and tested | Clean install, restart, container replacement, backup, update, rollback and uninstall each have a documented procedure and a check in the acceptance script. | Pending |
| **LB1.10** | Measured on clean amd64 | `scripts/acceptance/clean-install.sh --profile n150` run from published artifacts on a clean Ubuntu amd64 host, with the result recorded in `docs/ACCEPTANCE.md`. | Blocked — needs the N150 host and a Docker daemon |

### LB2 — Working ChatGPT subscription auth in clean Docker CE

| ID | Promise | Acceptance criterion (testable) | Status |
|---|---|---|---|
| **LB2.1** | Offered in the wizard on CE | Test: on a `ce` build the setup wizard's provider step offers ChatGPT subscription authentication; on a `hosted` build it is absent from the payload, not merely hidden by the client. | Pending |
| **LB2.2** | Pinned official CLI in the image | The Dockerfile installs a pinned version of the official Codex CLI. Test: the pin is an exact version, and the build fails rather than floating if it cannot be resolved. | Pending |
| **LB2.3** | Official device-login flow only | Test: the login path invokes the official CLI's device-login command and renders what the CLI reports. A repository-wide source guard proves no code reads any auth file, browser profile, cookie jar or keychain. | Pending |
| **LB2.4** | Login survives container replacement | The CLI home is a dedicated per-installation named volume with restrictive permissions. Test: recreate the container and the provider still answers without a second login. | Blocked — needs a Docker daemon |
| **LB2.5** | Probed with a real response | Test: the provider is not accepted as configured until a real minimal request returns a real model response. A CLI that is present but not signed in is refused with an actionable reason. | Pending |
| **LB2.6** | No API key on this path | Test: configuring the subscription provider refuses an API-key field, and the subprocess environment carries no API key. | Done (L3.4) — re-asserted |
| **LB2.7** | Claude unavailable, honestly | Test: Anthropic subscription auth is refused with the policy citation and no code path attempts it. | Done (L3.5) — re-asserted |
| **LB2.8** | CE-only at four layers | Test: on a `hosted` build the route is unmounted, the guard refuses, the provider factory refuses and the registry refuses at call time — including for a row inserted by direct SQL and for a modified client request. | Done (L4.3) — extended |
| **LB2.9** | Errors actionable, never leaking | Test: every failure mode maps to a categorized, actionable message; no credential, token or environment value appears in a message, log line or audit payload. | Pending |
| **LB2.10** | Proven on a clean install | A clean Docker CE installation completes device login and returns a real model response without an API key. | Blocked — needs a Docker daemon and ChatGPT credentials |

### LB3 — Real, account-aware model selection

| ID | Promise | Acceptance criterion (testable) | Status |
|---|---|---|---|
| **LB3.1** | No free-text model entry | Test: ordinary setup and admin flows expose no free-text model-name input. The only exception is the explicitly-marked advanced override for self-hosted endpoints where discovery is impossible. | Pending |
| **LB3.2** | No speculative IDs | Test: the shipped catalog contains no unverified identifier. Regression: `gpt-5.6-sol` and any other ID not returned by a provider's own listing interface. | Pending |
| **LB3.3** | Discovered from the connected account | After authentication, models are retrieved through the provider's supported listing interface for that account. Test: the offered set is the discovered set, not a constant. | Pending |
| **LB3.4** | Curated labels + exact IDs | Test: the ordinary view shows human-readable labels; the exact technical ID is present in an advanced/detail view with a copy control. | Pending |
| **LB3.5** | Refreshed on change | Test: changing credentials, subscription login, organization, project or provider access re-runs discovery and the stale set is not served. | Pending |
| **LB3.6** | Activation requires a real request | Test: a model cannot become Primary or Fallback until a real minimal request succeeds. A failed or unavailable model remains inactive. | Pending |
| **LB3.7** | Categorized errors | Test: authentication, authorization, unavailable model, rate limit, billing/quota, network, malformed request and provider outage are distinguished, with safe provider detail preserved and no secret leaked. | Pending |
| **LB3.8** | Revocation takes effect | Test: revoked access makes the model unavailable and prevents silent continued use. | Pending |
| **LB3.9** | Self-hosted discovery path | Test: an OpenAI-compatible endpoint is discovered where it supports listing; the manual override is reachable only when discovery is impossible and is labelled as unverified. | Pending |

### LB4 — Setup must test everything it configures

| ID | Promise | Acceptance criterion (testable) | Status |
|---|---|---|---|
| **LB4.1** | Model config makes a real request | Test: the provider step performs a real minimal request and records the outcome; persistence alone never marks it tested. | Pending |
| **LB4.2** | SMTP sends a real message | Test: SMTP configuration sends a real test message to an admin-chosen address, or is explicitly skipped and shown incomplete. | Pending |
| **LB4.3** | OAuth apps handshake | Test: Google and Microsoft application configuration performs a real save-and-handshake validation, not a field check. | Pending |
| **LB4.4** | Required failures block | Test: a failed required item prevents completion; an optional item may be skipped and remains visibly incomplete. | Pending |
| **LB4.5** | Test UX is real | Test: progress, timeout, retry where safe, exact failure text and a rerun control exist for each test. | Pending |
| **LB4.6** | Persistence is not connection | Test: no step reports success on the basis of validation or a database write. | Pending |

### LB5 — Complete Google and Microsoft onboarding

| ID | Promise | Acceptance criterion (testable) | Status |
|---|---|---|---|
| **LB5.1** | Org app setup in admin onboarding | Test: the admin onboarding path offers organization OAuth application setup and does not claim it is unavailable in this release. | Pending |
| **LB5.2** | Two levels kept distinct | Test: organization application registration and per-user account connection are separate surfaces with separate copy and separate state. | Pending |
| **LB5.3** | Guided registration | Google Cloud and Microsoft Entra instructions with exact scopes, the exact callback, validation and safe secret storage. Test: the rendered callback equals the one the server will accept. | Pending |
| **LB5.4** | Callbacks from the HTTPS app URL | Test: the callback is generated from the configured HTTPS application URL; a private HTTP address is never presented as production OAuth-ready. | Pending |
| **LB5.5** | LAN-only handled honestly | Test: a LAN-only installation is told the domain/HTTPS requirement and the supported alternatives instead of being given an unusable callback. | Pending |
| **LB5.6** | User connection lifecycle | Test: Connect, status, scope display, re-consent, revoke, disconnect and failure recovery each exist and are exercised. | Pending |
| **LB5.7** | Least privilege | Test: default scopes are read-only; write scopes require explicit explanation and consent. | Pending |
| **LB5.8** | Two users, no leakage | From a clean setup an admin registers and tests each application, then two different users connect accounts with no cross-user token or data exposure. | Blocked — needs a Google Cloud project and an Entra tenant |

### LB6 — A real final review screen

| ID | Promise | Acceptance criterion (testable) | Status |
|---|---|---|---|
| **LB6.1** | Complete summary | Test: every setup choice appears on the review screen. | Pending |
| **LB6.2** | Five honest states | Test: each item is exactly one of CONFIGURED AND TESTED, CONFIGURED BUT FAILED, SKIPPED, UNAVAILABLE, REQUIRED. | Pending |
| **LB6.3** | Safe metadata only | Test: no secret, token or credential appears in the review payload. | Pending |
| **LB6.4** | Direct actions | Test: each item offers test, edit or return-to-step. | Pending |
| **LB6.5** | Required failure blocks | Test: completion is refused server-side while a required item has failed. | Pending |
| **LB6.6** | No contradictions | Test: the screen cannot render "everything is configured" alongside "nothing has been tested". | Pending |

### LB7 — Correct post-setup admin flow

| ID | Promise | Acceptance criterion (testable) | Status |
|---|---|---|---|
| **LB7.1** | First account is super admin | Already enforced by Phase 1; re-asserted. | Done — re-asserted |
| **LB7.2** | Routed to the checklist | Test: after setup the super admin lands on an Admin Launch Checklist, not the ordinary dashboard. | Pending |
| **LB7.3** | Checklist coverage | Test: it covers model/provider, connectors, SMTP, users/invitations, approval policy, backups and master-key backup verification, security, diagnostics, updates, and every skipped or failed setup item. | Pending |
| **LB7.4** | Progress and dismissal | Test: progress is shown; optional work can be deliberately dismissed; material risks keep reminding. | Pending |
| **LB7.5** | Dashboard offered after | Test: "Go to user dashboard" appears only after the checklist has been seen. | Pending |
| **LB7.6** | Ordinary routing afterwards | Test: after first-run handling, role-aware login routing takes members to the normal dashboard. | Pending |

### LB8 — Google and Microsoft contact synchronization

| ID | Promise | Acceptance criterion (testable) | Status |
|---|---|---|---|
| **LB8.1** | Both providers | Google People and Microsoft Graph contacts are supported by the existing connector spine. | Pending |
| **LB8.2** | Two modes | Test: import-only and two-way modes behave differently and are chosen explicitly. | Pending |
| **LB8.3** | Matching | Test: stable provider IDs plus normalized email and phone matching; normalization is tested against international formats. | Pending |
| **LB8.4** | Deterministic dedup and merge | Test: deduplication is deterministic, a merge preview is produced before writing, and the conflict policy is applied consistently. | Pending |
| **LB8.5** | Deletion safety | Test: tombstones prevent resurrection; no path deletes a provider contact implicitly. | Pending |
| **LB8.6** | Scale and resilience | Test: pagination, incremental sync tokens/deltas, retry with backoff, rate-limit handling and reconnect recovery. | Pending |
| **LB8.7** | Visible provenance | Test: source account, source provider, sync mode, last sync, status and conflict state are shown on contacts. | Pending |
| **LB8.8** | Per-user isolation | Test: contacts are private to the syncing user; organization sharing requires an explicit action and policy. | Pending |
| **LB8.9** | Disconnect is not deletion | Test: disconnecting or revoking stops sync without silently deleting local or provider contacts. | Pending |
| **LB8.10** | Scope discipline | Test: least-privilege scopes by default; write sync forces re-consent. | Pending |
| **LB8.11** | Two users, real providers | Two users sync separate Google/Microsoft contact sets with no leakage; create, update, conflict, duplicate, delete, revoke and reconnect are exercised against real providers. | Blocked — needs a Google Cloud project and an Entra tenant |

### LB9 — Native iOS and Android contact synchronization

Per the instruction governing this work, **no mobile application is created in
this repository.** LB9 delivers the server contract and a precise handoff; the
device work belongs to the separate Josi mobile repository.

| ID | Promise | Acceptance criterion (testable) | Status |
|---|---|---|---|
| **LB9.1** | Server contract exists | Device contact sync endpoints, authentication, dedup semantics, permission-state reporting and conflict rules are specified and implemented server-side. | Pending |
| **LB9.2** | Cross-source dedup | Test: device, Google, Microsoft and Josi-native records deduplicate without collapsing unrelated people. | Pending |
| **LB9.3** | Per-user isolation preserved | Test: device-sourced contacts are private to the user; organization sharing needs a separate explicit choice. | Pending |
| **LB9.4** | Permission states modelled | Test: granted, limited, denied, revoked and signed-out states are representable and a revoked state stops future sync without deleting either side. | Pending |
| **LB9.5** | Handoff document | A precise implementation handoff for the mobile repository: endpoints, payloads, OS permission sequencing, selective import, limited-access handling, reinstall and sign-out behaviour. | Pending |
| **LB9.6** | Real-device tests | Grant, limited grant, denial, revoke, import, update, conflict and sign-out on real iOS and Android devices. | Blocked — no mobile repository access and no physical device |

### LB10 — Harden approval policy by default

| ID | Promise | Acceptance criterion (testable) | Status |
|---|---|---|---|
| **LB10.1** | No-ceiling default removed | Test: "no ceiling" is not the factory default, and an installation with no policy rows fails closed rather than open. | Pending |
| **LB10.2** | Ordinary actions gated | Test: sending email and creating or changing calendar events and tasks require approval on a fresh installation. | Pending |
| **LB10.3** | High-impact actions strictest | Test: deleting, cancelling, inviting external people, publishing, spending money, signing or accepting terms and changing access receive the strictest defaults. | Pending |
| **LB10.4** | Ceiling direction preserved | Test: users may only tighten; no user or client path exceeds the admin ceiling. | Done (M33) — re-asserted under new defaults |
| **LB10.5** | Relaxation is deliberate | Test: relaxing policy requires explicit confirmation and records who changed what and when, in the audit log. | Pending |
| **LB10.6** | Explained where it applies | Test: the defaults are explained during setup and on the policy page. | Pending |
| **LB10.7** | Safe migration | Test: an existing installation migrates without silently broadening or unexpectedly narrowing policy, and the admin is shown the migration result. | Pending |
| **LB10.8** | Server-side ceiling is the ceiling | Test: client-side tampering, direct API calls and worker/job paths cannot bypass it. | Pending |

### LB11 — Fix workspace and branding

| ID | Promise | Acceptance criterion (testable) | Status |
|---|---|---|---|
| **LB11.1** | Shepherd retired | Test: a repository-wide search finds no live shepherd branding claim. Historical records may retain it only where they are labelled as history. | Pending |
| **LB11.2** | J identity applied | The approved white `J` on navy is applied to the web UI, PWA icons, docs site, installation UI, metadata, favicon and distributable assets. | Pending |
| **LB11.3** | Licensing stated coherently | The "not replaceable" claim is replaced by a correct separation of AGPL copyright/licence rights from trademark rights. | Pending |
| **LB11.4** | Trademark policy published | A policy permitting compliant unmodified distribution, requiring forks to avoid confusion, and not purporting to restrict AGPL rights. | Done |
| **LB11.5** | Workspace page renders | Test: loaded, empty, timeout, API failure and unauthorized states each render something honest, with retry on failure. No endless Loading. | Pending |
| **LB11.6** | Surfaces agree | Test: UI and documentation agree on identity and licensing. | Pending |

### LB12 — Hide plumbing without hiding truth

| ID | Promise | Acceptance criterion (testable) | Status |
|---|---|---|---|
| **LB12.1** | Goals, not internals | Test: ordinary setup presents goals, guided choices, tests and outcomes. | Pending |
| **LB12.2** | Plumbing behind advanced | Test: client IDs, callback URLs, scopes, model IDs, container names, database concepts and secret-handling jargon appear only in a labelled advanced section, with copy controls, unless the admin must act on them. | Pending |
| **LB12.3** | Documentation keeps the detail | The full technical explanation remains in the installation and administration documentation. | Pending |
| **LB12.4** | Nothing necessary removed | Test: warnings, consent, security choices and failure detail survive the simplification. | Pending |

### LB13 — Banana

| ID | Promise | Acceptance criterion (testable) | Status |
|---|---|---|---|
| **LB13.1** | Banana preserved | The word `banana` is preserved in the tracked launch-audit document as an explicit test that user-requested checklist items are not silently dropped. It has no runtime product behaviour. | Done — `LAUNCH_AUDIT.md` |
