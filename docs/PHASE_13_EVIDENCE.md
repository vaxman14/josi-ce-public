# Phase 13 evidence — the first testable launch milestone

Scope delivered in this pass, in the order Roman resequenced it on 2026-09-01:

**13.0** edition capability boundary → **13.1** Telegram → **13.2** PWA →
**13.3** subscription authentication → doc repair → the amd64/N150 acceptance
script and its failure bundle.

L6 (release updates), L7 (document pipeline), L8 (real-provider harnesses) and
the arm64/Pi 4 profiles remain in the traceability matrix as subsequent work and
were deliberately not started.

---

## Numbers

| | Before (Phase 12) | After |
|---|---|---|
| Test files | 33 | 44 |
| Tests | 1088 | **1406** |
| Threat-model entries | 41 | 50 |
| Mutation scripts | 9 | 11 |

| Verification | Result |
|---|---|
| `npm run typecheck` (now includes `apps/web`) | clean |
| `npx vitest run` | 1406 passed, 0 failed |
| `scripts/mutate-phase13-edition.sh` | **13 of 13 caught** |
| `scripts/mutate-phase13-telegram.sh` | **48 of 48 caught** |
| `scripts/scan-secrets.sh` | clean |
| `apps/api/test/threatModel.test.ts` | every entry links to a control file that exists and a test that is in the suite |

The mutation figures are after fixes. **Four mutations did not fail the suite on
the first attempt**, and each is recorded below rather than quietly corrected —
that is the entire value of running them.

---

## What the mutations found

### M6 — an unlinked chat could have been answered as somebody else

The mutation made an unknown chat resolve to *whichever active link happened to
be first in the table*. Every test passed.

The reason is embarrassing and worth writing down: the test for "an unlinked
chat is refused" ran against a database with **no links at all**, so the
mutation had nothing to fall through to. Nothing anywhere covered a stranger
messaging the bot on an installation that had users.

That is the most serious bug this channel could have — a stranger answered as
somebody else, with their memory, their conversation, and their name on it.
Closed by `an unlinked chat is refused EVEN WHEN other people are linked`.

### M20 — a formatting bug that hung instead of failing

Flipping the odd/even test in `pullBackOffEscape` produced a cut of `0`, the
chunking loop pushed an empty chunk, `rest` never shrank, and the run **hung**.
A hang is the worst way for a defect to present: the harness reported nothing at
all and the script died silently.

The fix is not in the test. `chunkForTelegram` now asserts its own progress and
throws, because this loop runs on every outbound reply and a hang there is an
assistant that stops answering with no error anywhere.

### M40 — a dead bot could have been switched live

`setEnabled` refuses when there is no token, and refuses when the probe has not
passed. The test only exercised the first branch, so dropping the second changed
nothing observable.

The state is reachable: a token that worked is revoked in BotFather, the admin
presses Test, and the row keeps its token with `probe_ok = false`. Closed by a
test that stores a token, fails its probe, and then tries to enable.

### M45 — an access-control decision that lived in the mount order

Removing `requireSuperAdmin` from `adminTelegramRoutes` changed nothing, because
`/admin/telegram` was mounted **after** `/admin` — so a member was refused by
`adminRoutes`' guard and never reached the Telegram router at all. The RBAC
sweep passed for the wrong reason.

The protection was real, but it was mount order, and mount order is not where an
access-control decision should live. Two changes: the router is now mounted
before `/admin` with the other specific prefixes, as app.ts's own comment
already said the convention was; and a test drives the router **directly**, so
its guard stays proven whatever the mounting does next.

---

## Defects found in existing code, not in the new code

### `seal()` had never sealed a `Secret`. Since Phase 0.

`seal()` passed a replacer to `JSON.stringify` intending to unwrap the in-memory
`Secret` wrapper. The replacer never ran on one: `JSON.stringify` calls
`toJSON()` **before** it calls a replacer, so every `Secret` had already turned
itself into the string `[secret redacted]` — and that string is what got
encrypted.

Every credential entered through a route that wraps input in `asSecret` was
stored as the redaction marker:

- LLM provider API keys, from the setup wizard and from the admin screen
- OAuth client secrets
- SMTP passwords
- (and, had it shipped first, the Telegram bot token)

Opening one returned `[secret redacted]`, which was then handed to the provider
as the credential. **Every one of those would have failed with a 401 on a real
installation.**

Thirteen phases of tests passed because every suite seals a plain string.

Fixed by unwrapping before serialisation, where `toJSON` cannot intercept, with
seventeen tests in `packages/core/test/sealing.test.ts` including one case per
production call site. The acceptance script now opens a real stored credential
inside a real container and compares it — the only check that would have caught
this.

Existing installations must re-enter their credentials; there is nothing to
recover, because the original values never reached the database. Recorded in
`docs/INSTALLATION.md` §17.17.

### A Telegram `200` carrying `ok:false` landed in `unknown`

Telegram sometimes answers HTTP 200 with `ok:false` and the real code inside the
envelope. Categorising on the transport status put all of those in `unknown`, so
a "bot was blocked by the user" rejection would have been retried three times
and reported as a mystery instead of revoking a dead chat. Found by a test
written to check the mapping, not by reading the docs.

### Two React `Button` variants that do not exist

`Personalization.tsx` used `variant="outline"` and `variant="default"`, neither
of which the component accepts, so those buttons rendered unstyled. Invisible
because `apps/web` was never part of `tsc -b`. There is now an `npm run
typecheck` that covers it, and it is clean.

---

## What was verified, and how

### The edition boundary (L4)

The three empty rows in the capability table — hosted, business, white-label —
are the load-bearing part. No hosted build exists to try, so the tests compute a
hosted profile and drive the real code with it:

- an unrecognised stamp falls to the **least** capable edition, not to CE
- nine environment spellings (`JOSI_EDITION=ce`, `JOSI_CAPABILITIES=…`,
  `JOSI_ENABLE_SUBSCRIPTION_AUTH=true`, …) all leave a hosted profile empty
- the profile is frozen; `push` and assignment throw and change nothing
- disabling a prerequisite disables what depends on it
- the stamp script and the module share one edition list, checked by test
- the Dockerfile stamps **before** it compiles, checked by test — stamping after
  would put the new constant in the source and the old one in the bundle

### Telegram (L1)

125 tests in `packages/channels/test` plus 38 over the wire. The ones that
matter:

- an inbound payload cannot choose an account: a linked chat reaches its own
  owner whatever `from.id` and `from.username` claim
- two people on one bot get two conversations and neither appears in the other
- a group chat is refused with no setting to change it
- a link code is single-use via a conditional `UPDATE`, and two simultaneous
  redemptions produce exactly one link
- every code failure returns one indistinguishable sentence; the real reason
  goes only to the audit log
- a redelivered `update_id` is dropped before anything expensive runs
- the webhook needs no CSRF exemption because it is not on the API router
- a wrong or missing secret header gets 404 and no update is claimed
- the admin surface returns no message text and not even a chat id
- no audit payload contains a message, and none contains the bot token
- a download refuses a **lying** `Content-Length` by counting bytes as they
  arrive, and cancels the stream

### The PWA (L2)

The tests evaluate the shipped `public/sw.js` in a sandbox and call its
`decide()` directly, so what is tested is the file that ships:

- eight API paths, a navigation to an API path, and a 200 GET are all
  network-only
- `/apidocs` is **not** mistaken for `/api` — the sibling-prefix bug Phase 9 hit
  with `docs-private` versus `docs`
- a query string, an `Authorization` header, a non-GET, and a cross-origin
  request are each uncacheable on their own
- `index.html` is not in the precache list and a navigation never serves a
  cached copy of the real page
- the install block calls no `skipWaiting`
- every declared icon exists, is a real PNG, and is the declared size — read out
  of the IHDR chunk rather than trusted from the filename
- the offline shell contains no `<script>` and no external URL
- `sw.js` is served `no-store` with `Service-Worker-Allowed: /`
- the CSP gained `worker-src` and `manifest-src` and still names no external
  origin

### Subscription authentication (L3)

- the command line is asserted to be exactly the documented non-interactive
  form, with `--sandbox read-only` and no flag that could let the model touch
  the machine
- the prompt goes on **stdin**, never in argv, and a test asserts it is absent
  from the argument vector
- `OPENAI_API_KEY` and five relatives are **deleted** from the child
  environment, along with `DATABASE_URL`, `PGPASSWORD` and `MASTER_KEY_FILE`
- a **repository-wide** guard walks every source file and fails on any reference
  to a credential store — the Codex file, the Claude Code file, the gh file, a
  Chrome profile, the macOS keychain, the Linux keyring, `keytar`, a cookie
  database — and a self-test proves the guard would notice
- the provider makes no HTTP request of its own, asserted on the source
- a stored API key is refused by the route **and** by a database constraint
- usage records `subscription` and zero, and the summary note says "covered by
  your own ChatGPT plan" rather than "no provider charge"
- Local-only refuses it and the external acknowledgement is required, because
  the bytes still reach OpenAI
- the Anthropic entry cites the policy and the enforcement date and never says
  "coming soon"

---

## What was NOT verified, and why

Stated plainly rather than rounded up.

1. **No runtime or clean-install run.** The acceptance script and the runtime
   harnesses are written and syntax-checked; none has been executed.
   `docs/ACCEPTANCE.md` records every profile as **never run**.

   To be precise about whose limitation this is: a Linux test host is available
   (Roman confirmed 29.1.3 / Compose 5.5.0 on 2026-09-01), and the plan says so.
   It is simply not reachable *from the shell this phase was built in* — that
   shell has no `docker` binary at all (`command -v docker` finds nothing, no
   Docker context, no `DOCKER_HOST`, no `~/.docker`) and cannot resolve the
   name. So this is "not run here", not "cannot be run"; on a Linux test host these
   scripts are one command each.

2. **No browser checks.** `scripts/e2e-web.mjs` gained `testPwaAssets` and
   `testServiceWorker`, `/app/telegram` and `/admin/telegram` joined the
   responsive sweep, and an `E2E_ONLY` selector was added so one group can run
   alone. None of it ran.

   Playwright's browser builds for the pinned version (1.49.1 → webkit-2104,
   chromium-1148) would not install in this environment. Five attempts: the
   first was killed after an hour and left a stale `__dirlock` that failed the
   next two; after clearing it the **downloads complete in seconds and the
   extraction truncates** — chromium-1148 ended at 432 KB of a ~150 MB browser
   and would not launch, webkit-2104 at one 15 MB library. Other versions'
   builds (`webkit-2336`, `chromium-1223/1234`) are present and complete, so
   the cache itself is fine; it is this download-and-extract that fails here.

   `scripts/e2e-local.mjs` runs the whole suite against an in-process API with
   pglite and the real bundle — no Docker needed — so on a machine where the
   browsers install this is one command. It has not run. **L2.3 and L2.9 stay
   `Written, unrun`.** The partial browser directories created while trying were
   removed, so a later `npx playwright install` starts clean.

3. **No Telegram runtime harness.** L1.13 asks for one against a real stack with
   a fake Bot API on the project network. It has not been written. The
   over-the-wire suite covers the same routes through the real router with a
   stubbed provider; that is not the same thing and is not claimed to be.

4. **No provider credentials.** Nothing in this phase contacted OpenAI,
   Anthropic, Telegram, Google, Microsoft or an SMTP relay. Every provider is
   injected in every test.

5. **No target hardware.** The N150 and Pi 4 profiles are unmeasured.

---

## Files added

| Area | Files |
|---|---|
| Edition | `packages/core/src/edition.ts`, `buildStamp.ts`, `scripts/stamp-edition.mjs` |
| Telegram | `packages/channels/**`, `apps/api/src/http/telegramRoutes.ts`, `packages/db/migrations/0014_telegram.sql`, `apps/web/src/pages/Telegram.tsx`, `apps/web/src/pages/admin/Telegram.tsx` |
| PWA | `apps/web/public/{sw.js,manifest.webmanifest,offline.html,icons/*}`, `apps/web/src/lib/pwa.tsx` |
| Subscription | `packages/llm/src/providers/codexCli.ts`, `packages/db/migrations/0015_subscription_auth.sql` |
| Acceptance | `scripts/acceptance/clean-install.sh` |
| Mutation | `scripts/mutate-phase13-edition.sh`, `scripts/mutate-phase13-telegram.sh` |
| Docs | `docs/{TELEGRAM,PWA,SUBSCRIPTION_AUTH,ACCEPTANCE,PHASE_13_EVIDENCE}.md` |
