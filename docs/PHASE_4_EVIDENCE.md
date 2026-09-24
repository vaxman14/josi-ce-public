# Phase 4 evidence — LLM providers

Verified 2026-08-31. Every claim below is backed by recorded output or marked
unproven.

## Environment

| | |
|---|---|
| Static suite | macOS, Node 24, vitest 2.1.9, pglite |
| Runtime | dedicated LAN Docker host, Ubuntu 26.04, x86_64, Docker 29.1.3, Compose v5.5.0 |
| Compose project | `josi-ce-phase4` (isolated; the host's 25 unrelated containers untouched) |
| Host ports | 8392/8555 |

**No hosted provider was contacted at any point.** The unit suite injects
`fetchImpl`/`resolve`; the runtime test talks to a disposable stub container on
the app's own Docker network, standing in for a self-hosted runtime.

---

## What was built

| Component | File |
|---|---|
| Provider seam, capabilities, feature gates | `packages/llm/src/types.ts` |
| Endpoint guard (SSRF) | `packages/llm/src/ssrf.ts` |
| OpenAI / xAI / OpenAI-compatible adapter | `packages/llm/src/providers/openaiCompatible.ts` |
| Anthropic adapter | `packages/llm/src/providers/anthropic.ts` |
| Capability probe | `packages/llm/src/probe.ts` |
| Pricing, usage, caps | `packages/llm/src/metering.ts` |
| Registry — the one place a model may be called from | `packages/llm/src/registry.ts` |
| Schema | `packages/db/migrations/0003_llm.sql` |
| Admin + member API | `apps/api/src/http/llmRoutes.ts` |
| Suites | `packages/llm/test/{ssrf,providers,registry}.test.ts`, `apps/api/test/llm.test.ts` |
| Mutation harness | `scripts/mutate-phase4.sh` |
| Runtime verification | `scripts/test-llm-runtime.sh` |

---

## The design decision worth challenging: SSRF

The phase plan says *"block link-local/loopback/metadata ranges."* M84 says the
`openai_compatible` path exists to cover **Ollama, vLLM, LM Studio, LocalAI** —
all of which run on loopback or a private address. Applied literally, the
mitigation would leave the feature supporting nothing.

So the question is who can set the value. **Only the super admin**, in the wizard
or the admin surface. That is a person who already administers the host; they do
not need an SSRF bug to reach their own LAN. The classic threat — an untrusted
user makes the server fetch internal resources — is not present here.

What remains dangerous even from an admin-supplied URL, and is therefore blocked:

| Blocked | Why |
|---|---|
| `169.254.0.0/16`, `fe80::/10`, `fd00:ec2::/32` | Cloud metadata. A copied-from-a-forum URL should not be able to exfiltrate an IAM role. |
| `::ffff:169.254.169.254` | The same address behind a v4-mapped v6 literal. |
| `0.0.0.0/8`, multicast, reserved | Nothing serves an API there. |
| Any non-`http(s)` scheme | `file://`, `gopher://`. |
| Credentials in the URL | They end up in logs and error messages. |
| **Redirects** | A public URL that 302s to metadata defeats URL-only validation. `redirect: 'manual'`, never followed. |
| Mixed resolution | If *any* resolved address is blocked, the endpoint is refused — one good and one metadata answer is a rebinding attempt, not luck. |

Loopback and private ranges are **allowed**, and addresses are re-validated at
**request** time, not only at save time, so DNS that changes after configuration
does not get a free pass.

This is a deliberate departure from the plan's wording. It is recorded here
rather than applied quietly, and both directions are tested: metadata blocked
(4 cases), loopback/private allowed (6 cases).

---

## Test totals

```
$ npm test
Test Files  9 passed (9)
     Tests  221 passed (221)      # 156 prior + 65 new
```

Phase 1–3 test files unmodified:

```
$ git diff --quiet HEAD -- apps/api/test/authorization.test.ts   # unmodified
$ git diff --quiet HEAD -- apps/api/test/readiness.test.ts       # unmodified
$ git diff --quiet HEAD -- apps/api/test/packaging.test.ts       # unmodified
$ git diff --quiet HEAD -- apps/api/test/setup.test.ts           # unmodified
$ git diff --quiet HEAD -- packages/core/test/masterKey.test.ts  # unmodified
```

No existing test was weakened, relaxed or deleted.

---

## Mutation testing

`scripts/mutate-phase4.sh`. Each mutation must demonstrably alter the tree
(`assert_mutated`) before its result is believed.

| # | Mutation | Tests failed |
|---|---|---|
| M1 | Local-only stops refusing hosted providers | 3 |
| M2 | The cap warns but never stops | 4 |
| M3 | The cap is checked after the call instead of before | 1 |
| M4 | The fallback fires on any failure, including a bad key | 1 |
| M5 | An unprobed provider may be used (+ DB constraint dropped) | 2 |
| M6 | A null capability is read as present rather than unknown | 1 |
| M7 | An unprobed model is treated as fully capable | 1 |
| M8 | The probe trusts the request being accepted instead of parsing the reply | 1 |
| M9 | A tool call is inferred rather than observed | 3 |
| M10 | Cloud metadata stops being blocked | 7 |
| M11 | Redirects are followed | 1 |
| M12 | Only the first resolved address is checked | 1 |
| M13 | Addresses checked at save time only, not at request time | 2 |
| M14 | Estimated cost is labelled as reported | 1 |
| M15 | A self-hosted call is priced as if it cost money | 1 |
| M16 | The external acknowledgment is not required at call time | 1 |
| M17 | Saving a provider keeps the previous probe result | 15 |
| M18 | The admin config endpoint returns the sealed key | 11 |
| M21 | Ciphertext leaks under a field name the guard does not know | 1 |
| M19 | A member's status endpoint reports the whole installation's usage | 1 |
| M20 | Subscription options are offered as available | 1 |

All restored; 222/222 green.

### The finding that mattered: M18 initially passed

Adding `apiKeyCiphertext: stored.api_key_enc` to the admin DTO passed all 221
tests. The suite asserted the *plaintext* key was absent from every response —
and ciphertext is not the plaintext, so nothing objected.

That is a real leak. Serving a sealed value hands an attacker material to work
on offline, and Phase 3 had already set the standard (its runtime test greps the
review response for `v1.`). Two fixes:

1. `assertMetadataOnly`'s key list now covers `api_key_enc`, `apiKeyCiphertext`,
   `password_enc` and similar, and `providerDto` runs through it — so a careless
   `...stored` spread added later throws instead of serialising.
2. A test asserting no `v1.` ciphertext appears in any admin or member response.

**M21 exists because fixing it was not enough.** M18 is now caught by the guard's
key list, which leaves the *assertion* unproven. M21 leaks the same ciphertext
under `storedBlob` — a name the list has never heard of — so only the
response-shape assertion can catch it. It fails exactly 1 test, which is the one
that had been missing.

### A process failure worth recording

The first harness run was killed part-way because I edited a file it owns while
it was running. Its `restore()` never ran, and mutation M6 was left applied in
the working tree — a silently broken product one commit away from being real. It
was found by scanning for every mutation signature and reverting by hand.

`scripts/mutate-phase4.sh` now traps `INT`/`TERM` as well as `EXIT`, so an
interrupted run restores its sources instead of leaving them mutated.

---

## Runtime verification

```
$ JOSI_HTTP_PORT=8392 JOSI_HTTPS_PORT=8555 PROJECT=josi-ce-phase4 \
    bash scripts/test-llm-runtime.sh          # on a Linux test host, at 94963a5
```

A disposable stub container on the app's own Docker network plays a self-hosted
runtime — reachable as `fakemodel`, exactly as an `ollama` service would be. No
hosted provider was contacted.

```
== bringing the stack up                     PASS  compose up
== waiting for readiness                     PASS  /health responds
== starting a stub self-hosted runtime       PASS  stub started
== driving the wizard                        PASS  all steps accepted; setup completed
== signing in as the owner                   PASS

== a model is not usable until it has been probed
  PASS  the configured provider is inactive
  PASS  activated_at is null in PostgreSQL
  PASS  members are told Josi is not ready
  PASS  every feature is disabled with an honest reason

== probing against the stub runtime
  PASS  probe ran (200)
  PASS  chat / tool calling / structured output observed
  PASS  no feature is disabled
  PASS  capabilities persisted to PostgreSQL
  PASS  members are now told Josi is ready

== the probe recorded usage, and no prompt or reply with it
  PASS  usage recorded for each probe step (4 rows)
  PASS  self-hosted calls carry no provider charge
  PASS  recorded cost is 0
  PASS  llm_usage has nowhere to put a prompt or a reply

== cloud metadata is refused as an endpoint, in the real container
  PASS  metadata endpoint refused (400)
  PASS  IPv6 metadata endpoint refused (400)

== a self-hosted endpoint on the container network is allowed
  PASS  the stub runtime is accepted (200)
  PASS  reconfiguring cleared the previous probe

== Local-only mode refuses a hosted provider server-side
  PASS  Local-only turned on; recorded in PostgreSQL
  PASS  a hosted provider is refused (409)
  PASS  nothing hosted was written
  PASS  the refused key was not stored
  PASS  the self-hosted model can still be probed

== turning Local-only off, then storing a hosted key
  PASS  hosted fallback accepted once Local-only is off
  PASS  the key is sealed ciphertext in PostgreSQL
  PASS  the plaintext key is absent from the column
  PASS  the config endpoint returns neither key nor ciphertext
  PASS  a hosted provider without acknowledgment is refused (400)

== caps stop work at 100%, in the real database
  PASS  the cap reports blocked once the probe's own tokens exceeded it
  PASS  the probe itself is exempt from the cap
  PASS  a zero cap is refused rather than read as unlimited

== subscription options                      PASS  none available; reason stated honestly
== a member cannot administer the model      PASS  403; status names neither provider nor model
== no secret in any container log            PASS
== no hosted provider was contacted          PASS

47 passed, 0 failed
```

Host left as found: 25 containers before and after, zero `josi-ce-phase4`
containers, volumes or networks remaining.

### The first attempt failed, and that mattered twice

Run 1 died at `docker build` — `cannot find module @josi-ce/llm`. The new
workspace was never added to the Dockerfile's dependency layer, and npm creates
a workspace's `node_modules` symlink only when its `package.json` exists at
`npm ci` time.

**`npm run build` had passed locally the entire time**, against a tree where
`npm install` had already made that symlink. An incremental local build is not a
clean build. `apps/api/test/packaging.test.ts` now derives the workspace list
from `package.json` and asserts each is copied before `npm ci` — and immediately
found a second instance, `apps/worker`, which had not broken anything only
because nothing imports it.

The second lesson was about the harness. Run 1 reported **"6 passed, 47 failed"**
— and all 6 passes were worthless: *"no secret appears in any container log"* is
trivially true when there are no logs, and *"no hosted provider was contacted"*
is trivially true when nothing ran. The script now aborts at `compose up` and at
the health check. Same failure mode as Phase 2's Caddy test, in a new place.

---

## Proven / unproven

### Proven

| Requirement | Where |
|---|---|
| M84 — self-hosted via an OpenAI-compatible endpoint | Runtime: a stub runtime on the container network was configured, probed and used |
| M85 — primary + optional explicit fallback | Unit: not used when absent, not activated, or when the failure was a bad key; used on a retryable failure |
| M86 — probe chat, structured output, tool calling, context | Unit: 4 ordered steps, chat fatal; structured output judged by parsing the reply; **runtime**: capabilities persisted to PostgreSQL |
| M86 — unsupported capability disables dependent features | Unit: missing tool calling disables exactly calendar/email/document, each with a reason; **runtime**: `disabledFeatures: []` only after a passing probe |
| M87 — installation-wide + per-user caps, 50/80/100% | Unit: each threshold; worst-of-both governs; **runtime**: blocked in real PostgreSQL |
| M87 — hard stop at 100% | Unit: the call is refused before the provider is contacted (`calls === 0`) |
| M88 — reported vs labelled estimates | Unit: three sources never blended; no `totalCostUsd` field; DB constraint |
| M88 — self-hosted `$0 provider charge`, hardware excluded | Unit + **runtime**: `cost_source = none`, cost 0, note names the exclusion |
| M89 — external acknowledgment required | Unit: refused at save and at call time; **runtime**: 400 |
| M90 — Local-only enforced at the API layer | Unit: refused in `buildProvider`, including via the fallback path; **runtime**: 409, nothing written, key not stored |
| M83 — subscription options disabled with an honest reason | Unit + **runtime**: every option `available: false`; naming one as a provider is 400 |
| SSRF — metadata blocked, self-hosted allowed | Unit: 4 metadata cases incl. v4-mapped v6, 6 loopback/private allowed; **runtime**: 400 for v4 and v6 metadata, 200 for the container endpoint |
| SSRF — no redirects, request-time re-validation | Unit: `redirect: 'manual'` asserted, 3xx refused, DNS that changes after save is caught |
| Keys sealed, never returned | Unit + **runtime**: `v1.` ciphertext in PostgreSQL, plaintext absent, neither key nor ciphertext in any response |
| No prompt or reply is stored | Unit + **runtime**: `llm_usage` has no column that could hold one |
| A member sees capability, not configuration | Unit + **runtime**: 403 on admin routes; status names neither provider nor model; own usage only |
| No secret in logs | **Runtime**: all container logs grepped |
| Phase 1–3 tests unmodified and green | 223/223 |

### Unproven — deliberately out of Phase 4

| Claim | Why |
|---|---|
| Any hosted provider actually works | **No hosted provider was contacted, by design.** The adapters are asserted against recorded response shapes, not against OpenAI, Anthropic or xAI. First real contact is an operator's own key. |
| Real context-window sizes | The probe asks whether ~8000 tokens survives a round trip — a "will Josi function" check, not a measurement. `contextTokens` is that floor, not a discovered maximum. |
| Price accuracy | `llm_prices` ships empty and is operator-maintained. This is exactly why estimates are labelled and the note says the invoice is the real figure. |
| Fallback under genuine provider failure | Proven against stubbed 503/401, not against a real provider outage. |
| Cap behaviour across a month boundary | Unit-tested by back-dating rows; no clock was advanced in a running installation. |
| Assistant features that consume these capabilities | Phase 5. Phase 4 delivers the provider layer and the gates; nothing calls a model in anger yet. |
| The admin UI for any of this | Phase 6. Phase 4 is API only. |

Nothing above is claimed as tested.

---

## Design notes worth challenging

### The probe asks the model; it never reads the model's name

`gpt-4o-mini-with-tools` tells you what someone chose to call a build. Whether
*this* endpoint, behind *this* proxy, at *this* version, returns a tool call is a
different question, and the only honest way to answer it is to ask. Four ordered
steps — chat, structured output, tool calling, usable context — with chat fatal
(the rest are meaningless without it) and structured output judged **by parsing
the reply**, because plenty of endpoints accept `response_format` and then return
prose.

Null capability means *unknown*, and CE treats unknown as **off**. A provider
cannot be marked active without a passing probe — enforced by a database check
constraint, not only by application code.

### Cost is never a single number

`reported` (the provider told us), `estimated` (we multiplied tokens by a local
price list that goes stale silently), `none` (self-hosted — no provider charge,
and hardware and electricity are explicitly *not* counted). A database constraint
makes a self-hosted row with a non-zero cost unrepresentable, and the usage
summary has no `totalCostUsd` field to blend them into.

Where no price is known for a model, tokens are counted and the cost is left at
zero **with a note saying why** rather than silently under-counting against the
cap.

### The probe is metered but not capped

Probing a hosted provider is four real requests on a real invoice, so they appear
in the usage report. They are exempt from the cap: an operator who has hit their
limit still has to be able to test a replacement model.

### Fallback needs three things, not one

A fallback fires only when it exists, was explicitly activated, **and** the
primary failed retryably. A fallback that fires on 401 quietly moves a workspace
onto a second provider — and a second bill — because someone mistyped a
character.

### Subscription options are visible and disabled

Claude Pro / ChatGPT Plus / Copilot are named in the admin surface, each with
`available: false` and this reason:

> Consumer subscriptions are licensed for one person using an app, not for a
> server answering on their behalf. Josi will not drive one from here, so this
> needs an API key from the same provider instead.

Not "coming soon" — that would be a lie with a date on it. There is no
subscription auth code path in the tree to reach, and a request naming one as a
provider is refused with 400.

### Local-only is enforced where the client is built

Not at the route, and not in the UI. `buildProvider()` refuses, so a feature
added in Phase 5 that forgets to check gets a refusal anyway — including via the
fallback path, which is the obvious way an external provider would otherwise
sneak in.
