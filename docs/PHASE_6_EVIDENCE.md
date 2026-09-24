# Phase 6 evidence — web app

Verified 2026-08-31. Every claim below is backed by recorded output or marked
unproven.

## Environment

| | |
|---|---|
| Static suite | macOS, Node 24, vitest 2.1.9, pglite |
| Browser | WebKit (Playwright 1.49.1, pinned) with touch emulation |
| Runtime | dedicated LAN Docker host, Ubuntu 26.04, x86_64, Docker 29.1.3, Compose v5.5.0 |
| Compose project | `josi-ce-phase6` (isolated; the host's 25 unrelated containers untouched) |
| Host ports | 8396/8559 |

---

## What was built

| Component | File |
|---|---|
| Build config (Vite, Tailwind, no CDN) | `apps/web/{vite.config.ts,tailwind.config.js,index.html}` |
| API client (cookie + CSRF) | `apps/web/src/lib/api.ts` |
| Session context | `apps/web/src/lib/auth.tsx` |
| UI primitives (44px rule lives here) | `apps/web/src/components/ui/index.tsx` |
| App shell, mobile-first nav, Local-only badge | `apps/web/src/components/layout/Shell.tsx` |
| Talk — the iPhone composer | `apps/web/src/pages/Talk.tsx` |
| Member pages | `apps/web/src/pages/{Home,Tasks,Approvals,Conversations,Contacts,Connections,Usage,Settings,Apps,Login}.tsx` |
| Admin pages | `apps/web/src/pages/admin/{Overview,People,Model,Policy,Workspace}.tsx` |
| **First-run wizard** (deferred here by Phase 3) | `apps/web/src/pages/Setup.tsx` |
| Static serving + CSP | `apps/api/src/http/staticApp.ts` |
| Browser suite | `scripts/e2e-web.mjs` |
| Local harness (no Docker) | `scripts/e2e-local.mjs` |
| Runtime verification | `scripts/test-web-runtime.sh` |

Bundle: **217 kB** total (68 kB gzipped), three files, no external requests.

---

## The departure: CE fetches nothing from anywhere

The commercial engine's `index.html` loads Fira Sans and three other families
from `fonts.googleapis.com`. For a hosted product that is a fair trade. For CE
it is three separate problems:

1. It tells Google the IP address of everyone who opens a **self-hosted**
   installation — people who chose self-hosting to avoid exactly that.
2. It breaks outright on an air-gapped or egress-filtered host, which is a
   normal way to run this software.
3. It makes the **Local-only** badge a claim the page itself contradicts.

CE uses the system font stack. Nothing is downloaded, which also suits the
low-power hardware CE targets.

`default-src 'self'` is what makes this checkable rather than a promise:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self';
frame-ancestors 'none'; base-uri 'none'; object-src 'none'
```

`style-src` carries `'unsafe-inline'` because React sets a `style` attribute for
the visual-viewport height on Talk. That still forbids an **external
stylesheet**, which is the property this policy exists for. It is stated here
rather than left for a reader to notice.

Three independent checks, so this cannot rot:
* a unit test asserts the header value directive by directive;
* a unit test asserts `apps/web/index.html` and `index.css` contain no `http(s)://`;
* the browser suite records every request and fails if any origin but its own appears.

---

## The iPhone composer, ported with its reasoning

The engine's Talk send path was rewritten three times chasing a bug that turned
out to be an account with no workspace. What survived is the simplest thing that
works, and each piece is load-bearing:

| Detail | Why |
|---|---|
| Plain `<form onSubmit>` + `type="submit"` | Tap, Enter and click share one path. Bolted-on pointer/touch handlers produced double sends on iOS, and on one path none at all. |
| `text-base` on the textarea | Anything smaller and Safari zooms the page on focus, which reads as a layout bug. |
| `h-11 w-11` (44×44) | The iOS tap-target minimum, named in the acceptance criteria. |
| `pb-[max(…,env(safe-area-inset-bottom))]` + `viewport-fit=cover` | Otherwise the composer sits under the home indicator. |
| `--josi-visible-height` from `visualViewport` | Chrome's iOS wrapper reports `100dvh` as including its own toolbar. CSS viewport units alone do not fix this. |
| A send lock ref | A double tap must not send twice. |

The browser suite **taps** the button in WebKit with touch emulation rather than
clicking it, and asserts a reply came back — so the tap reached the network
rather than only painting the optimistic bubble.

---

## Test totals

```
$ npm test
Test Files  13 passed (13)
     Tests  339 passed (339)      # 332 prior + 7 new
```

The seven new ones cover the CSP header value directive by directive, the image
building the bundle rather than trusting a committed one, `WEB_DIR` being set,
the absence of any external URL in the page source, the brand files being real
PNGs, probe steps being returned as a list, and — the one that matters most —
that no source file pairs `JSON.stringify` with a `::jsonb` cast.

---

## Browser suite

`scripts/e2e-web.mjs`, run in Microsoft's Playwright image on the project's own
Docker network. **43 passed, 0 failed.**

```
== Talk: a real tap on a touch-capable WebKit
  PASS  the send button is at least 44x44  — 44x44
  PASS  a TAP delivers the message
  PASS  Josi answered the tapped message
  PASS  Enter still sends
  PASS  the composer sits inside the visible viewport  — bottom 747 of 844
  PASS  no horizontal scroll on Talk at 390px
  PASS  no leftover debugging surface

== Layout: nothing scrolls sideways on a phone
  PASS  no horizontal scroll on any page at 320px / 375px / 390px / 430px
  PASS  every member page rendered its heading
  PASS  no member page reported an error

== The app can call its own API and show the result
  PASS  a same-origin API call from the page succeeds  — status 201
  PASS  what it created is fetched back and rendered
  PASS  the home page renders data it fetched

== Every control a thumb can reach is at least 44px tall
  PASS  no control shorter than 44px at 320px

== The app is navigable from a keyboard
  PASS  Tab moves focus to a control
  PASS  every field has a label
  PASS  the page has main, labelled nav and one h1

== Nothing is fetched from a third party, and nothing pretends to work
  PASS  no request left this origin
  PASS  no CSP violation was reported
  PASS  the CSP header is served
  PASS  the companion apps page says Coming soon
  PASS  and offers no download or install action  — 0 action(s)
  PASS  connections says what is not available yet
  PASS  and offers no Connect button that does nothing
  PASS  no disabled control stands in for a feature

== A member cannot reach the admin section
  PASS  the member header offers no admin link
  PASS  a member asking for /admin ends up in /app
  PASS  the admin API refuses a member session  — status 403

== An administrator has both, and the admin pages behave
  PASS  the admin header offers the admin section
  PASS  no horizontal scroll on any admin page at 390px
  PASS  every admin page rendered its heading
  PASS  the model page rendered
  PASS  nothing on an admin page reported an error
  PASS  subscription options are shown as unavailable  — 3 marked
  PASS  and there is nothing to press

== The Josi identity is present
  PASS  the wordmark is on the sign-in screen, and it actually loaded
  PASS  the product line is shown
  PASS  the publisher is named
  PASS  the shepherd mark is in the header

43 passed, 0 failed
```

> **Historical record.** The output above is the run as it happened in Phase 6
> and is not edited. At that time the identity was the orange/gold shepherd on
> navy and the check was named for it. The shepherd concept was retired at
> launch (LB11): the mark is now the white `J` on navy, cut from the approved
> wordmark, and the check is named "the J mark is in the header". Nothing here
> is a current branding claim.

### It took five runs, and each failure was worth having

| Run | Failed on | What it was |
|---|---|---|
| 1 | `playwright` not importable | `npx playwright install` fetches the BROWSER, not the package. Pinned as a devDependency. |
| 2 | WebKit could not launch | Missing system libraries. Rather than `apt-get` on somebody's Docker host to run a test, the browser moved into Microsoft's own image on the project network. |
| 3 | `waitForFunction` refused; two tap targets | **The CSP was strict enough to break my own harness** — `waitForFunction` evaluates a string and needs `unsafe-eval`. The suite now uses locator waits. The header brand link (32px) and the approval links (16px) were **real bugs** and were fixed. |
| 4 | `main` was empty | Added an ErrorBoundary — a blank page is indistinguishable from a loading one — and console capture, because `pageerror` never fires once a boundary catches. |
| 5 | `probeSteps.map is not a function` | A **real production defect**, below. |

### The defect the browser found that no unit test could

The admin model page crashed. The cause was in **Phase 4**, not Phase 6: the
probe route wrote `probe_steps` with `JSON.stringify(...)` and a `::jsonb` cast
instead of the `json()` helper. `packages/core/src/db.ts` documents this exact
trap — postgres.js types a JS string as text, so the cast stores a jsonb **string
scalar** rather than an array, and reading it back yields a string.

The UI guarded with `?.length`. **A string has one.** So the guard passed and
`.map` threw.

Fixed at three depths: the route uses `json()`; `providerDto` normalises the
column to an array however it was stored; and the UI checks `Array.isArray`.

**On the test that should have caught it:** I wrote one asserting the response is
an array, then verified it by re-introducing the bug — **and it passed.** pglite
parses what postgres.js does not, so the unit suite structurally cannot catch
this class of defect, exactly as `db.ts` warns. What it *can* catch is the shape,
so `packaging.test.ts` now fails if any source file pairs `JSON.stringify` with a
`::jsonb` cast. That check was verified the same way: it fails when the bug is
put back.

This is the clearest argument in the project so far for runtime verification.
Four phases of green suites and 339 unit tests did not see it; a browser
did.

---

## Runtime verification

```
$ JOSI_HTTP_PORT=8396 JOSI_HTTPS_PORT=8559 PROJECT=josi-ce-phase6 \
    bash scripts/test-web-runtime.sh        # on a Linux test host, at ae11a8d
```

```
== the app is served from the API's own origin
  PASS  /login serves the app (200); it is the SPA shell
  PASS  the shell references no external origin

== a client route falls through to the shell, an API route does not
  PASS  /app/tasks serves the shell
  PASS  an unknown API route still answers JSON 404, and it is not HTML

== security headers are on every response
  PASS  content-security-policy / x-content-type-options / referrer-policy / x-frame-options
  PASS  CSP default-src is 'self'; CSP has no wildcard

== the brand assets are served and are the approved masters
  PASS  josi-mark.png and josi-wordmark.png are served
  PASS  the shepherd mark is byte-identical to the approved master

28 passed, 0 failed
```

> **Historical record**, unedited. `josi-mark.png` was the shepherd when this
> ran and its hash was pinned to that file. Since LB11 the wordmark is the only
> pinned master and the mark is derived from it by `scripts/build-brand.sh`, so
> the current harness pins two different hashes and names neither of them
> "shepherd".

Host left as found: 25 containers before and after; zero `josi-ce-phase6`
containers, volumes or networks remaining.

**One concession, stated rather than buried:** the browser reaches the app over
plain HTTP with `JOSI_COOKIE_SECURE=false`, because a `secure` cookie is dropped
on a non-TLS origin and every sign-in would fail for a reason unrelated to the
UI. HTTPS itself is covered by the Phase 2 proxy tests.

---

## Proven / unproven

### Proven

| Requirement | Where |
|---|---|
| Mobile-first at 320/375/390/430 — no horizontal overflow | **Browser**: every member page at all four widths, every admin page at 390 |
| Controls ≥44px | **Browser**: every rendered control on every page measured at 320px |
| Keyboard navigable | **Browser**: Tab reaches a control, every field labelled, one `main`/`h1` and labelled `nav` |
| The iPhone send path | **Browser**: a real TAP in touch-capable WebKit delivers, Josi answers, Enter still sends, composer inside the visible viewport |
| No placeholder presented as working | **Browser**: Coming soon with 0 actions; no dead Connect button; no disabled control standing in for a feature; subscriptions unavailable with the real reason |
| Nothing fetched from a third party | **Browser**: no request left the origin, no CSP violation + unit assertions on the header and the page source |
| Branding present and unreplaced | **Browser**: wordmark loads, product line and publisher shown, mark in header; **runtime**: SHA-256 byte-identical to the approved master |
| Role separation | **Browser**: no admin link for a member, redirect to /app, and **403 from the admin API** — the redirect is convenience, the 403 is the control |
| The app can call its own API | **Browser**: create → fetched back → rendered, on two pages |
| Served same-origin with security headers | **Runtime**: four headers on every response, CSP without a wildcard |
| The setup wizard | **Runtime**: drives all nine steps and completion through the UI's own endpoints |

### Unproven — deliberately out of Phase 6

| Claim | Why |
|---|---|
| HTTPS in the browser path | The suite runs over plain HTTP with secure cookies off, for the reason above. Caddy and TLS are Phase 2's. |
| The wizard's screens in a browser | The runtime script drives the wizard through the API. The React screens are built and typecheck, but no browser walked them — the suite starts from a configured installation. |
| Any real model behind Talk | A stub answers. Prompt quality is unmeasured. |
| Connections, companion apps | Not built. The pages say so and the suite asserts they offer nothing. |
| Chromium / Firefox / a real iPhone | WebKit with touch emulation is the closest unattended approximation to Safari. It is not a device. |
| Screen-reader behaviour | Landmarks, labels and focus order are asserted; no assistive technology was driven. |

Nothing above is claimed as tested.

---

## Design notes worth challenging

### Nothing pretends to work

The acceptance criterion is "no placeholder presented as working", and the
suite enforces it three ways:

* **Connections** has no Connect button. The OAuth flow is Phase 7; a control
  that looks pressable and does nothing is how the engine's tenants ended up
  staring at a `redirect_uri_mismatch`.
* **Companion apps** says Coming soon with no download or install action, and
  no date.
* **Subscription options** render as unavailable with the real reason — that a
  consumer subscription is licensed for a person using an app, not a server —
  rather than "coming soon".

The suite additionally asserts that **no disabled control** stands in for a
feature anywhere in the app: a greyed-out button is still a promise.

### The 44px rule lives in the components

Not at each call site. `Button` and `Input` carry `min-h-11` first in their
class list, so a caller passing a smaller height cannot win. The suite measures
every rendered control on every page at 320px and fails on anything under 44px
tall — which is a check on the rule, not on whoever remembered it.

### Routing is convenience, not security

`RequireAuth admin` redirects a member away from `/admin`, and the nav hides
those links. Neither is the control: the suite asserts that a member's session
gets **403 from `/api/admin/assistant`** regardless of what the router did. The
redirect exists so a member does not stare at a page of failed requests.

### The wizard does not choose its own step

Carried over from Phase 3: the page renders whatever `nextStep` the server
reports and submits to that named endpoint. Submitting out of order is refused
with 409 whatever the client does, so the wizard cannot be walked around by
editing a URL or a variable in a console.
