# Clean-install acceptance

## Subscription/calendar/timezone correction — 2026-09-17

Evidence on the macOS development host:

- the final focused subscription, MCP, assistant, calendar, migration and worker suite passed **202/202 tests across 14 files**;
- TypeScript project references and the web application typecheck passed;
- the production web build passed;
- the secret scan passed across 653 files; and
- `git diff --check` passed.

The focused proof covers mode-0600 ephemeral subscription results, real-result
propagation through grounding/presentation/approval behavior, provider-primary
reconciliation, all-selected-calendar provisioning, recurrence instances,
missing/stale/failed coverage refusal, profile/workspace timezone precedence,
the exact 17/18 September 2026 Los Angeles boundary, DST civil-date arithmetic,
and one authoritative write default.

A full `npm test -- --maxWorkers=2` run reached **2,784 passing tests**. It
reported 20 failures: one stale MCP expectation was corrected and passed in the
final focused run; the other 19 are existing host prerequisites on this macOS
machine (one browser-installer test requires Docker, and 18 attachment/local
workspace tests require Linux `/proc/self/fd` semantics). They are not counted
as passes and this host result is not release evidence. Linux CI remains the
required full-suite gate.

No install reset, data wipe, tunnel change, gate deployment or release action
was performed by this work.

## Authoritative internal calendar sync

- Conversational calendar reads and approved writes use `calendar_events` and stable internal UUIDs; they make no provider request.
- `calendar_outbox` pushes create/update/delete asynchronously with a stable Google event id, ETag preconditions, retry backoff, and crash-after-create recovery.
- Google incremental pulls persist sync tokens, restart with a full reconciliation after HTTP 410, process cancellations/tombstones, preserve recurrence metadata, and refuse concurrent local/remote overwrites as conflicts.
- Google push notifications authenticate by channel/resource pair and enqueue one deduplicated origin sync; the periodic scheduler remains the missed-webhook safety net.
- Calendar origins preserve the exact connected account and provider calendar selected by the user. Reads and details refuse deselected, revoked, forged, and cross-user sources rather than substituting another calendar.
- Focused proof: `calendarSync.test.ts`, `dataTools.test.ts`, `worker.test.ts`, and `freshDbMigration.test.ts` pass against the real migrated PostgreSQL-compatible test database.

## HEIC/HEIF chat attachments (v0.1.30)

- A real HEIC fixture is detected by content and converted to JPEG in an
  isolated worker before persistence or model delivery.
- Uppercase `.HEIC`, generic MIME types, and HEIF-compatible brands are
  accepted; disguised or corrupt files are rejected without trusting the
  extension.
- Converted output is checked for a complete JPEG signature and the 20 MB
  post-conversion ceiling.
- Unit coverage exercises detection, conversion metadata, generic MIME input,
  disguised files, invalid converter output, and unchanged non-HEIC images.
- TypeScript, production build, dependency audit, secret scan, full Linux test
  suite, and multi-architecture release verification must pass before gate is
  upgraded.

A record of what has actually been run, on what, and when. **A profile with no
row in the results table has not been tested**, whatever the script's existence
might suggest.

## Test List 6 items 1–5 — 2026-09-15

Evidence on Bananana (Linux x86_64):

- 2,459 tests passed across 98 files;
- TypeScript type checking and both the root and production web builds passed;
- all 43 database migrations passed from a fresh database;
- focused setup, installer, authentication, and native-enrollment coverage passed
  138 tests after the final canonical-URL compatibility correction;
- the release Compose configuration parsed successfully;
- dependency audit reported zero vulnerabilities;
- secret scan passed across 549 files; and
- the completed diff received a security review with no open findings.

The covered changes are the masked/copyable/downloadable one-time Vault
recovery key, a larger responsive setup workspace, model verification on the
model configuration step, canonical password-reset links plus the offline
password-reset command, and the optional `/workspace` developer bind mount.
The developer mount was additionally reviewed for host-path traversal,
sensitive-directory exposure, Docker-socket exposure, and fail-open write
probes.

## v0.1.23 publication — 2026-09-15

Release source: public `main` commit
`78e4b5924969749fe56026e97c02f4e10982e151`, tagged `v0.1.23`.

Evidence on Bananana (Linux x86_64, Docker Engine 29.7.2, Buildx 0.29.1):

- TypeScript and production build passed;
- 2,446 tests passed across 97 files;
- dependency audit reported zero vulnerabilities;
- secret scan passed across 548 files;
- release and reverse-proxy Compose configurations parsed successfully;
- the application image built locally for `linux/amd64` and `linux/arm64`;
- the browser-installer image built locally for both architectures; and
- the public release workflow completed successfully.

Registry readback proved real `linux/amd64` and `linux/arm64` child manifests
for application and installer tags `0.1.23` and `latest` in both GHCR and
Docker Hub. Docker Hub uses the `romanvaxman` namespace. The numbered Docker
Hub indexes carry the exact same child digests as GHCR; stable `latest` aliases
were promoted from those existing indexes without rebuilding.

This document exists because M97 forbids capacity claims without measurements,
and because a script that has never been run is a plan.

## The script

```bash
bash scripts/acceptance/clean-install.sh                  # host defaults
bash scripts/acceptance/clean-install.sh --profile n150   # Intel N150 / 16 GB
bash scripts/acceptance/clean-install.sh --profile pi4    # Raspberry Pi 4 / 8 GB
bash scripts/acceptance/clean-install.sh --keep           # leave it running
```

It takes a Docker daemon with nothing of Josi's on it, builds the image, brings
the stack up, drives the setup wizard, signs in, and then checks the properties
that only exist on a real installation. It touches nothing outside its own
Compose project and tears itself down.

### What it checks

| Group | What |
|---|---|
| Prerequisites | Docker, Compose v2, python3, host memory against the profile |
| Clean start | Zero containers and zero volumes for this project before anything runs |
| Secrets | `install.sh` produces them; `master.key` is not world-readable |
| Build | The image builds; **size and build time recorded** |
| Edition | The image reports `ce`, **and `JOSI_EDITION=hosted` in the environment does not change it** |
| Boot | `/health` then `/ready`; **both durations recorded** |
| Profiles | OCR and ClamAV absent, and the ClamAV image never pulled |
| Setup gate | Every non-wizard route answers 503 before setup |
| Wizard | Nine steps and completion; **duration recorded** |
| Closure | The wizard 404s afterwards |
| **Credentials** | The stored provider key is **opened with the real master key inside the real container and compared to what was submitted** |
| Sign-in | The owner can sign in and the session resolves |
| PWA | Manifest, `no-store` on `sw.js`, `Service-Worker-Allowed`, all three icons, an offline shell with no script, `worker-src`/`manifest-src` in the CSP, and still no external origin |
| Telegram | The webhook is invisible with the channel off; there is no webhook inside `/api`; the admin surface loads with no token configured |
| Subscription | The running app reports `ce`; the Codex path is offered; the Claude path is not and cites the policy; no option says "coming soon" |
| Resources | Idle memory per container, **recorded** |
| Audit | Events were written, and no credential reached a payload |

The credential check is there for a specific reason. Phase 13 found that
`seal()` had been storing the string `[secret redacted]` instead of every
credential wrapped in `asSecret` — for the whole life of the project — and every
unit test passed because they all sealed plain strings. The only thing that
would have caught it is opening a real stored value on a real installation, so
that is now a step.

## The failure bundle

On any failed check, the script writes
`diagnostics/josi-acceptance-<profile>-<timestamp>.tar.gz` containing:

- `summary.txt` — the profile, which checks failed, and every measurement taken
- `host.txt` — kernel, architecture, CPU count, memory, disk, Docker versions
- `compose-ps.txt`, `compose-config.txt`, `docker-stats.txt`, `images.txt`
- `logs/<service>.log` — the last 400 lines of each service
- `ready.json`, `health.json`, `last-response.txt`
- `database-counts.txt` — **counts only**, and the edition the running image reports

Everything is passed through a redactor (sealed values, bot tokens, API keys,
`password`/`secret`/`token` assignments, connection strings, JWTs) and then the
whole archive is unpacked and run through `scripts/scan-secrets.sh`. If the
scanner flags it, the script says so loudly rather than letting it be sent.

No table is read. A bundle that could carry a row is a bundle nobody can send.

## Results

The script has now been run on real hardware. The rows below include the runs
that failed, because a table of only successes is a table that has been curated
— and in this case the failures are the most useful thing in it.

**Linux test host** — AMD Ryzen 7 8745H, 28 GiB, Ubuntu 26.04 LTS, Linux 7.0.0,
Docker 29.1.3, Compose 5.5.0, amd64.

| Profile | Arch | Host | Date | Result | Image MB | Build s | Boot→ready s | Idle MiB | Bundle |
|---|---|---|---|---|---|---|---|---|---|
| default | amd64 | Linux test host (Ryzen 7 8745H / 28 GiB) | 2026-09-02 | **19 passed, 36 failed** | 348 | 8 | never reached | — | `josi-acceptance-default-20260902T031033Z.tar.gz` |
| default | amd64 | Linux test host (Ryzen 7 8745H / 28 GiB) | 2026-09-02 | **50 passed, 0 failed, 5 skipped** | 348 | 7 | 9 | 92.9 | none — bundles are collected on failure |
| n150 | amd64 | Intel N150 / 16 GB | **this script: never run** | — | — | — | — | — | — |
| pi4 | arm64 | Raspberry Pi 4 / 8 GB | **never run** | — | — | — | — | — | — |

The `default` profile records the host it ran on, not a hardware claim. The
`n150` and `pi4` rows stay empty until the script runs on those boxes: "it
installs" and "it installs in ten minutes on the hardware CE targets" are
different claims and only one of them is proven here.

### Published-image and live isolation run — 4 September 2026

The public-alpha path was tested separately on an Apple Silicon Mac Mini with
Docker Desktop 29.7.2 and Buildx 0.36.1. The test began in an empty directory
and used only the published `josi-ce-installer:0.1.0` and
`josi-ce:0.1.0` images. Both OCI indexes were independently inspected and
contained `linux/amd64` and `linux/arm64` manifests plus SBOM/provenance
attestations.

The first published-image run found that restrictive checkout directory modes
were preserved into the image, preventing the non-root runtime user from
traversing `packages/db`. The second found that the generated browser URL named
port 8080 while only ports 80/443 were published. Both were fixed and the run
was restarted from a new database volume. The passing run proved:

- the one-shot installer generated mode-0600 secrets and then exited;
- migrations completed and PostgreSQL, web, worker and Caddy were healthy;
- `/health` and the web UI returned HTTP 200 at the generated URL;
- no installer container or Docker-socket mount remained in the running stack;
- `scripts/test-persona-runtime.sh`, pointed at that published installation,
  passed **69 checks with 0 failures** across three real HTTP sessions and real
  PostgreSQL rows. Alice and Bob could not read, delete, import or inject each
  other's profiles, memories, prompts or live turns, and neither a member nor
  the super administrator could cross the per-user memory boundary.

This run used a local OpenAI-compatible stub on the installation's Docker
network so the model boundary was exercised without sending data to a third
party. It proves request assembly and user isolation, not the behaviour of a
commercial model provider.

**A real first install HAS happened on the N150**, by hand rather than by this
script, and it is written up in `docs/FIRST_INSTALL_FINDINGS.md`. That run
confirmed the stack starts, all four containers report healthy, migrations exit
0, and `/health` and `/ready` both answer — and it produced six open findings,
including the scheme-qualified `JOSI_DOMAIN` defect this script's own site
address fix does not cover. The `n150` row above stays empty regardless: a
manual install and a scripted acceptance run measure different things, and
filling the row from the former would be exactly the curation this table exists
to prevent.

### What the first run found

The first run to actually boot the stack failed 36 of 55 checks on a single
line. The bundled proxy's site address was a bare hostname defaulting to
`localhost`, which is what turns Caddy's automatic HTTPS ON — so every
plain-HTTP request was answered with `308 Permanent Redirect` to `https://`
on a port that had been dropped. The documented LAN path did not work at all,
and no static test could see it because the line was syntactically perfect.

That is the entire argument for this script existing. Four further rounds were
needed before the run said anything trustworthy, and every one of those was a
defect in the harness rather than the product:

- the run configured itself into the same defect by exporting
  `JOSI_DOMAIN=localhost`, so it could not have caught it;
- it never fetched a CSRF token, so every POST was refused 403 and the whole
  wizard section reported failures that said nothing about the product;
- the sealed-credential probe passed `ENC=` where the shell read it as an
  argument rather than an assignment, so it reported a decryption error
  regardless of what was stored;
- the Phase 13.3 section gave `python3` two stdin redirections, so the JSON
  body was executed as the program. It had never run, and its verdicts were
  printed where the summary could not count them — a traceback sat inside a
  run reporting "0 failed".

### What the passing run does not prove

Five checks are reported **SKIPPED**, which is never counted as a pass:

| Skipped | Exact dependency |
|---|---|
| The wizard closes behind itself | A real model credential |
| The owner can sign in, session resolves | A real model credential |
| No webhook route inside `/api` | A real model credential |
| The Telegram admin surface | A real model credential |
| The subscription-auth options | A real model credential |

All five live past one gate: setup will not finish with a model that has never
been successfully called (LB4.4). That refusal is itself asserted as a pass, so
the gate is tested rather than merely encountered. Supply a working key and the
five run for real:

```bash
JOSI_ACCEPTANCE_LLM_KEY=sk-... bash scripts/acceptance/clean-install.sh
```

No such key has been supplied to this repository, and the five have never run.
Note that `docs/FIRST_INSTALL_FINDINGS.md` FI-003 reports the same gate firing
on a real install against a real OpenAI key, because the verification request
Josi sends is malformed. Until FI-003 is fixed, supplying a key here would very
likely reproduce FI-003 rather than turn these five green — so a future run
that still shows five skips is not necessarily a run that was configured
wrongly.

SMTP is skipped by the same principle: configuring mail means proving mail can
be sent, this host has no relay, and a fixture that passed would report a mail
system that does not exist. Sending is covered by
`scripts/test-mail-runtime.sh` against a real server.

### What will never be proven from this repository

Confirmed by Roman on 2 September 2026. These are not pending; nothing is
queued behind them, and no future run here will fill them in.

| Item | Exact dependency that will not be supplied |
|---|---|
| LB2.10 — subscription path returns a real model response | A ChatGPT account with an active subscription, and a person with a browser to approve the device code |
| LB5.8 — two real users connect real accounts | A Google Cloud project with the People API enabled, and a Microsoft Entra tenant with an app registration |
| LB8 Part B — sync against real providers | `JOSI_REAL_GOOGLE_*` and `JOSI_REAL_MS_*` credentials for real accounts |
| LB9.6 — native contact sync on real devices | A physical iOS device, a physical Android device, and the separate Josi mobile repository |

Each remains **BLOCKED**, which is a statement about evidence and not about the
code: the paths are built and unit-tested, and none of them has ever contacted a
provider. Nothing in this document should be read as claiming otherwise, and no
green count anywhere in this repository covers them.

## The Codex subscription path

`scripts/test-codex-runtime.sh` covers LB2 separately, because the property that
matters there is what happens across an update rather than at install time.
Measured on a Linux test host, **10 passed, 0 failed, 1 skipped**:

- the Dockerfile pins `0.152.0` and the running container reports
  `codex-cli 0.152.0` — the pin is real, not aspirational;
- `CODEX_HOME=/data/codex`, mounted as a named volume, and writable from inside
  a read-only container;
- the container was genuinely replaced (`6dcda9a41a90` → `835a8f41c725`) and
  the replacement read back exactly the bytes the old one wrote. A device login
  that `docker compose pull && up -d` discards is a login the operator repeats
  on every update;
- `codex login status` on a fresh volume says "Not logged in" in words, rather
  than failing the way an absent CLI would.

**SKIPPED:** completing a real device login needs a person with a browser and a
ChatGPT subscription. The parsing of the CLI's output is covered against a
byte-for-byte capture of the pinned version in
`packages/llm/test/codexLogin.test.ts`.

## v0.1.26 publication — 2026-09-15

Release `v0.1.26` publishes the sixteen Test List 6 changes merged through
public `main` commit `5a719f69748d81db539bbb4f0cd89ff408155855`.

- Exact-source TypeScript, production build, Compose, shell/Python syntax,
  dependency audit and secret scan passed on Bananana.
- The complete suite passed: **2,601 tests across 103 files**.
- Bananana built both the application and one-shot installer for
  `linux/amd64` and `linux/arm64` before publication.
- GitHub Actions release run `35048754065` repeated the complete gate and
  published both numbered OCI indexes to GHCR, then mirrored the exact indexes
  to Docker Hub.
- Numbered `0.1.26` and stable `latest` aliases on both registries resolve to
  the same two architecture-child digests for both images. Provenance/SBOM
  attestations were excluded from architecture counting.
- GitHub release: https://github.com/vaxman14/josi-ce/releases/tag/v0.1.26

Application children:

- `linux/amd64`: `sha256:6aaf93c928bc007a8d0190718aa1da5fc50300780a95f1c9bdcf7a57f5b0cf78`
- `linux/arm64`: `sha256:558a5671402db6b32253aecfc99bb9f00c200b23fedece740c0139d7e621c8dd`

Installer children:

- `linux/amd64`: `sha256:78a3f8519ea559071e73d7174bf6aeef7807e735c8874543cb9a945935fe3608`
- `linux/arm64`: `sha256:4de1592d71456604a55cab0b6fee724219395e12ec0d521cdfd6c796386b18a1`

## Operator checklist for a hardware run

## Build-list 13 central Calendar source acceptance — 2026-09-14

Migration `0042` replaces the one-account-per-provider constraint with durable
provider-account identity for Google and Microsoft while retaining the existing
single Nextcloud contract. OAuth re-consent is bound to the selected connection
and refuses account substitution. Workspace → Calendar discovers all calendars
under every enabled account, preserves account/calendar names and colors,
allows each owner to independently include or exclude calendars, aggregates
selected events in day/week/month ranges, and supports owner-only inspection.
Account-scoped capability checks prevent one account's switch from authorizing
another account.

Evidence on this source worktree:

- 2,432 tests passed across 94 files, including HTTP selection isolation and
  secondary-calendar aggregation;
- TypeScript and production build passed;
- the complete migration chain was exercised by the integration suite;
- production dependency audit reported zero vulnerabilities;
- secret scan passed across 535 files; and
- Compose configuration and diff whitespace checks passed.

Published multi-architecture image verification remains a release-time gate;
this source change has not published a numbered release.

## Build-list 14 Master Vault source acceptance — 2026-09-14

Migration `0043` adds one installation control plane, independently random
per-user box keys, AEAD-encrypted items, and session-bound five-minute UI
unlocks. The administrator-created Vault key is wrapped separately by the
installation key and a one-time offline recovery key; only its hash and
fingerprint persist. Setup pauses until the recovery key is confirmed saved.
Users receive masked CRUD, integrity checking, box rotation and strict owner
isolation. Administrators see health, lock, recovery and blocked-job metadata,
but no endpoint enumerates or reveals another user's values. Guardian access
requires the existing password-plus-TOTP, single-use parental authority grant.

New model, OAuth application, connected-account, developer-service, SMTP and
backup credentials use the Vault after initialization. Old sealed values stay
readable for an upgrade but are never silently imported; re-entry or rotation
moves them to the Vault. Locking fails Vault-backed credential resolution
closed, clears UI unlocks, and records a metadata-only administrator alert.
Full backup rows include the encrypted Vault but neither recovery key.

Published multi-architecture image verification remains a release-time gate;
this source change has not published a numbered release.

## Build-list 7–12 source acceptance — 2026-09-14

Telegram is again reachable from Admin → Channels without replacing WhatsApp
or Slack. Backup destination selection is one controlled radio group, so its
highlight, keyboard state, and submitted destination cannot diverge. Full
backups can target a tested mounted NAS path under `/mnt` or `/data`; the server
requires a real read/write probe before using it. Every Developer Service is an
accessible disclosure that opens automatically when a connection needs
attention. Family and Parental Controls expose only a disabled Coming Soon
teaser with no active safety claims. Setup creates and populates the singleton
workspace before completion, migration `0040` backfills missing rows without
overwriting valid ones, and Admin offers an authenticated recovery action.

Evidence on this source worktree:

- 2,429 tests passed across 94 files;
- TypeScript and production build passed;
- the complete migration chain was exercised by the setup integration suite;
- production dependency audit reported zero vulnerabilities;
- secret scan passed across 533 files;
- Compose configuration and diff whitespace checks passed.

Published multi-architecture image verification remains a release-time gate;
this host's Docker installation does not provide Buildx.

## Parental Controls integration — 2026-09-13

The complete paid Parental Controls module was restored onto current public
main after the v0.1.5 source rebuild had removed its family routes, UI,
enforcement, and migration while leaving only the licence-management shell.
The integrated module provides managed-child account creation, explicit
parent/controller authority, password-plus-TOTP relationship changes,
conversation visibility, schedules, daily limits, usage summaries, Child Mode
disclosures, server-side turn enforcement, audit events, and unlink cleanup.
It explicitly does not claim device, browser, or third-party-app enforcement.

Evidence on Bananana (Linux, Node 26.8.1, Docker Engine 29.7.2):

- TypeScript and the production build passed;
- 2,415 tests passed across 93 files;
- the focused parental/licence suite passed 93 tests, including cross-family
  isolation and all-channel enforcement;
- the current two-part signed licence format activates the parental entitlement,
  so already-issued v0.1.16 licences remain valid;
- all 40 migrations applied to a fresh PostgreSQL 16 database, with Parental
  Controls assigned the non-colliding `0039_parental_controls.sql` migration;
- `npm audit --audit-level=high` reported zero vulnerabilities;
- the repository secret scan was clean across 527 files; and
- diff whitespace checks passed.

Published-image, clean-install, and authenticated browser evidence are recorded
separately after a versioned multi-architecture artifact exists. They are not
claimed by the source-level evidence above.

## Talk mockup fidelity — 2026-09-12

The mobile Talk redesign was verified at a 390×844 viewport against the
approved mockup, using the real authenticated browser harness and microphone
capture path. The compact Josi header, separate message timestamps, delivery
marks, centered Voice Box status, rounded composer, and icon navigation all
rendered in the browser. `scripts/test-voice-browser.mjs` passed microphone
capture, partial/final transcription, assistant response, speech interruption,
and media-track cleanup. The complete release gate passed 2,307 tests, the
production web build and TypeScript check, zero high-severity dependency audit
findings, and the 502-file secret scan.

Browser evidence was captured at `/tmp/josi-voice-browser-x1ukoD/talk.png` on
the test host; this path is ephemeral and records the environment rather than
shipping an acceptance artifact.

1. Start from a machine with Docker installed and **no Josi containers,
   volumes or images**. If it has been used before, `docker system prune -a` on
   a machine you are willing to prune.
2. Clone the repository at the exact tag being accepted. Note the commit.
3. `bash scripts/acceptance/clean-install.sh --profile n150`
4. Record every `TIME` line into the table above, with the date and the commit.
5. If anything failed, attach the bundle path and do **not** mark the profile
   as passing.
6. Tear down: the script does this itself unless `--keep` was given.

### On the N150 specifically

- 4 efficiency cores and no hyperthreading. The image build is the slow step and
  is dominated by `npm ci` and `tsc -b`; expect it to be several times a laptop.
- 16 GB is comfortable for the default stack. It is **not** comfortable with
  ClamAV enabled at the same time as OCR — the profile lowers both ceilings and
  that is a hint rather than a guarantee.
- Storage is usually NVMe on these boxes. If it is eMMC, the database will be
  the bottleneck and the boot timing will not resemble the table.

### On the Pi 4 specifically — not yet attempted

- arm64. The image is built for it, and Phase 2 proved the manifest resolves per
  platform, but nothing has been installed on one.
- 8 GB with slow USB or SD storage. Swap behaviour will dominate any timing, and
  a timing taken with swap thrashing is not a measurement of Josi.
- `@node-rs/argon2` ships an arm64 prebuild, so no compiler is needed. That is
  the assumption a real run has to confirm.

## Connector settings and account consent

- Zapier, n8n, and Make are native workflow providers, not labels applied to a
  Custom API connection. Zapier uses the official Streamable HTTP MCP endpoint
  (`mcp.zapier.com/api/v1/connect`) and connection-token Bearer authentication;
  the retired NLA/AI Actions endpoints are never used. n8n uses its public API
  key to discover active workflows, then requires an administrator to register
  that workflow's production `/webhook/…` path because n8n has no public
  run-workflow API. Make uses `Authorization: Token`, a selected team or
  organization ID, scenario discovery, and the official responsive scenario-run
  input envelope. Provider account/workspace identity and connection status are
  shown in administration; disconnect removes the stored credential and hides
  every exposed automation until a tested reconnect.
  Every execution is pinned to the exact discovered workflow and input, waits
  for its owner's approval, and appears in that owner's run history.
- Provider completion callbacks are authenticated with the integration-specific
  HMAC secret, a five-minute timestamp window, and a unique event id; forged,
  stale, replayed, and unknown-run callbacks are rejected. Credentials are
  tested before storage, structured inputs are validated and previewable, and
  every execution still needs fresh owner approval. Discovered automations are
  private until an administrator explicitly exposes each one to Josi. Pending
  approvals expire after 15 minutes and sanitized history is bounded to 30 days.
  Self-hosted n8n permits LAN endpoints only through a deliberate administrator
  switch; hosted endpoints are checked against private DNS/address ranges.
  Custom API remains the explicit fallback for services without a native integration.

- OAuth application forms are controlled forms. Save is disabled while pristine,
  invalid, or submitting; a successful server write/readback clears the dirty
  state and announces which provider application was saved without echoing its
  secret. Failures retain safe unsaved input and do not announce success.
- Dirty connector forms warn before browser navigation and before their provider
  disclosure is collapsed.
- Google, Microsoft, Dropbox, and Box request their complete currently supported
  scope bundle during initial account connection. Provider scopes and local Josi
  capability switches remain separate: every local capability starts off.
- A legacy partial grant exposes one account-level **Upgrade permissions /
  Reconnect** action. Missing-scope capabilities never render per-capability
  provider approval buttons.

## Test List 7 source validation on Bananana

The completion branch preserves the interrupted worktree and starts from
`origin/main` at `a025123`, incorporating the reconciled network and consent
commits `aaf0779` and `3ecd086`. No production branch, image publication, release,
or gate upgrade is part of this validation.

Reproducible additional checks:

- `python3 scripts/acceptance/test-list-7-maintenance.py`: real Docker supervisor
  with no network, private LAN HTTPS `/health`, rejected unauthenticated/wrong-code
  requests, one-time pairing and replay rejection.
- `node scripts/acceptance/test-list-7-browser.mjs`: rendered desktop/mobile
  password semantics, accessible label, keyboard submission, disabled empty
  action, error feedback, and 200% zoom.
- `node scripts/acceptance/test-list-7-save-browser.mjs`: rendered workflow save
  states, delayed response, failure/retry, and confirmed readback.
- `node scripts/acceptance/test-list-7-oauth-save-browser.mjs`: failed OAuth saved-state
  readback retains edits, retry confirms persistence, and another open provider
  section keeps its unsaved input.
- `python3 -m unittest discover -s services/installer -p test_network_rollback.py`:
  54 previous-mode/target-mode/failure combinations plus explicit failed-recovery reporting.
- `scripts/acceptance/test-list-7-public-address.mjs`: run inside the isolated web
  container after a fresh PostgreSQL migration; verifies domain/domain-port,
  proxy, LAN transitions and exact metadata restoration.
- `python3 scripts/acceptance/test-list-7-network-runtime.py`: only the isolated
  `josi-list7-validation` Compose project; proves actual Caddy/runtime application,
  failed public health, restored files/metadata/timestamp, and old-origin health.

The browser tests use synthetic authentication/provider responses; separate API
and real-controller tests exercise password verification and controller startup.
They do not claim a live 1Password vault, physical screen reader, or second-device
LAN session. Public-domain ACME issuance and external OAuth allowlist/Telegram
registration require operator-owned public DNS and provider accounts. Those are
separate external acceptance checks, not proof supplied by a local mock.

The dated results and explicit external acceptance gaps are recorded in
[TEST_LIST_7_VERIFICATION.md](TEST_LIST_7_VERIFICATION.md).

## Tool-backed reply presentation boundary — 2026-09-17

- Every tool-backed assistant reply crosses one shared deterministic presentation
  boundary after grounding/fabrication guards and before web or external-channel
  delivery. Internal receipts, account metadata, timestamps, authorization
  evidence, and identifiers remain available to backend actions and audit paths
  but are removed from visible prose.
- The public talk response contains only the presented reply or refusal; raw
  action results never cross that HTTP boundary. Human-facing provider/source
  names and useful answer content remain available.
- The boundary covers accumulated results from multiple calls and retries,
  successful and failed tools, and is independent of channel delivery shape.

## Calendar follow-up continuity — 2026-09-17

- Calendar query, event-detail, and calendar-draft receipts are retained in the
  owner-scoped outbound message metadata and restored only into the model's
  private history on the next turn. The receipt context is not rendered in the
  visible conversation.
- A follow-up such as “Push the EDD call by 30 minutes” keeps EDD as the edit
  target, preserves its verified event and source calendar, and does not move a
  separately proposed LexisNexis event instead.
- Verified on Bananana with 54 focused tests, TypeScript/build, the complete
  2,763-test suite, dependency audit, secret scan, Compose validation, and
  diff hygiene.

## Transactional conversational action state — 2026-09-17

- Consequential email/calendar drafts are durable owner/thread/domain/operation
  records linked to one task, one exact payload hash, and one approval. Partial
  fields merge only into that namespace; unrelated history is not action state.
- A prepared action is bound to the assistant turn that displayed its exact
  preview. Plain “yes” or “no” is deterministic only when that turn contains
  exactly one prepared action. Duplicate approvals, denial, expiry, and retry
  cannot enqueue a second execution.
- Calendar creation resolves “the main one” only from a single provider-marked
  primary source. Event edits require an explicit verified event id, so an old
  LexisNexis receipt cannot turn a new EDD call into a replacement.
- Worker execution compare-and-sets `ready` to `attempting`, revalidates the
  pinned approval payload, and records domain-specific success/failure state.
  Email status questions therefore cannot report calendar state.
- Provider status remains metadata evidence and explicitly does not claim a
  live mailbox probe. Live reachability is established only by the actual
  read/send path.
