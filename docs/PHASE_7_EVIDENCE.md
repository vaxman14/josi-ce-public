# Phase 7 evidence — connectors

Verified 2026-08-31. Every claim below is backed by recorded output or marked
unproven.

## Environment

| | |
|---|---|
| Static suite | macOS, Node 24, vitest 2.1.9, pglite |
| Runtime | dedicated LAN Docker host, Ubuntu 26.04, x86_64, Docker 29.1.3, Compose v5.5.0 |
| Compose project | `josi-ce-phase7` (isolated; the host's 25 unrelated containers untouched) |
| Host ports | 8398/8561 |
| Source | `5c63f98`, cloned from GitHub and checked out by hash |

**No Google or Microsoft service was contacted.** The unit suite injects
`fetchImpl`; the runtime test talks to a stub on the project's own Docker
network, over TLS, with certificate verification on.

---

## What was built

| Component | File |
|---|---|
| The capability rule | `packages/connectors/src/capabilities.ts` |
| OAuth handshake (stored, single-use, session-bound) | `packages/connectors/src/oauthState.ts` |
| Google/Microsoft over fetch | `packages/connectors/src/providers.ts` |
| Connection store, tokens, health | `packages/connectors/src/connections.ts` |
| The operator's own OAuth application | `packages/connectors/src/oauthClients.ts` |
| Schema | `packages/db/migrations/0005_connectors.sql` |
| HTTP surface | `apps/api/src/http/connectorRoutes.ts` |
| Connections page | `apps/web/src/pages/Connections.tsx` |
| Admin connectors page | `apps/web/src/pages/admin/Connectors.tsx` |
| Suites | `packages/connectors/test/{capabilities,handshake}.test.ts`, `apps/api/test/connectors.test.ts` |
| Mutation harness | `scripts/mutate-phase7.sh` |
| Runtime verification | `scripts/test-connectors-runtime.sh` |

---

## The model: three facts, deliberately separate

Three things decide whether Josi may touch a connected account, and they are
stored separately because collapsing any two is how a connector ends up doing
more than anyone agreed to:

| | |
|---|---|
| **provider** | What Google or Microsoft actually GRANTED — read from the token response, never from what was requested |
| **user** | What the account's owner switched on. Their consent |
| **admin** | A ceiling that can only deny |

```ts
effectiveCapability = providerGranted && adminAllows && userEnabled
```

One expression, with no parameter named `role` anywhere in it, so there is
nowhere for a "but an administrator can…" to be added later. The policy table
has an `allowed` column and **no `granted` column** — the shape itself cannot
bestow.

The phase plan asked for a truth table. There is one enumerating all eight
combinations, plus three sharper assertions:

* an administrator can never grant what the user did not enable
* an administrator can never grant what the provider withheld
* **monotonicity** — from the fully-enabled state, flipping *any* single input to
  false makes the answer false. A stronger statement than enumeration alone.

`capabilityState` reports `needs_consent` ahead of `blocked_by_admin` when both
apply, on purpose: telling someone their administrator blocked something, when
the real problem is that they never finished connecting, sends them to the wrong
person.

---

## Incremental authorization (M32) is structural

Connecting asks for **read scopes only** — asserted in the unit suite and again
at runtime by reading the authorize URL. Enabling a write capability the
provider never granted is refused with `needs_consent` and sends the person back
through consent, rather than storing a wish that would make the page lie.

Two details that were easy to get wrong:

* **A second consent accumulates.** A provider answering with only the newly
  requested scope must not narrow a connection that already had more.
* **Google does not reissue a refresh token on re-auth.** Discarding ours would
  silently kill a working connection at the next access-token expiry, so the
  stored one is kept when the provider sends none.

---

## Test totals

```
$ npm test
Test Files  16 passed (16)
     Tests  431 passed (431)      # 339 prior + 92 new
```

Phase 1's connection tests pass **unchanged**. Replacing that router initially
broke them; those tests encode claims that are still true, so the new router
keeps their contract — `connections` in the list, `GET /:id` for the owner, 404
for everyone else — and adds the new structure alongside. A passing test that
had stopped covering anything would have been worse than a failing one.

---

## Mutation testing — 24/24

`scripts/mutate-phase7.sh`, run in foreground segments (`M_FROM`/`M_TO`).

| # | Mutation | Tests failed |
|---|---|---|
| M1 | An admin ALLOW grants what the user never enabled | 8 |
| M2 | The admin ceiling stops denying | 6 |
| M3 | A capability is credited without the provider granting it | 6 |
| M4 | Connecting asks for write scopes up front | 1 |
| M5 | Enabling skips the provider-granted check (M32) | 2 |
| M6 | Enabling ignores the admin ceiling | 2 |
| M7 | A new consent narrows the scopes already granted | 2 |
| M8 | A re-auth discards the stored refresh token | 1 |
| M9 | A connection is enabled the moment it is authorised | 6 |
| M10 | The handshake is replayable | 2 |
| M11 | A state can be redeemed from another session | 2 |
| M12 | A google state is redeemable at the microsoft callback | 1 |
| M13 | The state never expires | 1 |
| **M14** | **The callback trusts the query string for who is connecting** | **0 → 1** |
| M15 | The return path allows an open redirect | 1 |
| M16 | A member may act on another member's connection | 1 |
| M17 | The admin health view returns the account address | 1 |
| M18 | The client secret is stored in the clear | 23 |
| **M19** | **The client secret's ciphertext is returned to the admin** | **0 → 1** |
| M20 | Tokens are stored unsealed | 6 |
| M21 | The provider's error body is repeated to the caller | 1 |
| M22 | A rate limit demands a reconnect | 1 |
| M23 | A dead grant is treated as retryable | 2 |
| M24 | Disconnecting leaves the capability grants behind | 3 |

### The two that were not caught

**M14 — a latent hole.** Making the callback read `?user=` from the query string
left every test passing, because none of them supplied one. The vulnerability
was latent rather than absent, and "the callback believes the stored handshake,
not the query string" was a comment nothing checked. There is now a test
smuggling another member's id through five plausible parameter spellings.

**M19 — a repeat of a mistake I had already made and fixed.** Returning the
client secret's **ciphertext** passed, because the assertion looked for the
plaintext. This is exactly the defect Phase 4's M18 exposed. I added the
ciphertext guard for the LLM provider DTO and did not carry it to the connector
DTO. The test now rejects any `v1.` value and any secret-shaped field name, and
`clientStatuses` builds its result field by field with a note saying why a
spread would reintroduce it.

Both verified by re-applying the mutation: each now fails a test.

---

## Runtime verification — 58/58

```
$ JOSI_HTTP_PORT=8398 JOSI_HTTPS_PORT=8561 PROJECT=josi-ce-phase7 \
    bash scripts/test-connectors-runtime.sh        # on a Linux test host, at 5c63f98
```

```
== an admin registers the installation's own OAuth application
  PASS  application registered (200)
  PASS  the client secret is sealed ciphertext in PostgreSQL
  PASS  the plaintext secret is absent from the column
  PASS  the admin view returns neither secret nor ciphertext
  PASS  a member is refused (403)

== connecting asks for read scopes only — M32
  PASS  asks for read scope; asks for NO write scope
  PASS  no secret in the authorize URL; uses PKCE; a state was minted
  PASS  the PKCE verifier is sealed at rest

== the handshake, end to end over real TLS
  PASS  stub certificate generated; stub provider started on https/443
  PASS  oauth2.googleapis.com resolves to the stub
  PASS  the CA env var is set and the certificate is readable in the container
  PASS  callback completed the connection (302)
  PASS  the connection belongs to alice
  PASS  tokens sealed; no plaintext token in the column
  PASS  granted capability starts off; nothing is enabled by connecting
  PASS  a replay is refused

== enabling a write capability the provider did not grant — M32
  PASS  refused with 409, and says re-consent is needed

== the admin ceiling denies, and does not grant
  PASS  an admin allow did NOT switch it on
  PASS  alice switched it on herself
  PASS  an admin deny overrides her choice
  PASS  lifting the ceiling restores her own choice

== BOB cannot touch alice's connection
  PASS  GET / DELETE are 404 for a colleague
  PASS  cannot change her capabilities; her setting is untouched

== the SUPER ADMIN sees health, never content
  PASS  contains none of: her address, either token, the granted scopes
  PASS  it does say whose connection it is
  PASS  the admin cannot read her own connection view (404)

== no secret reaches the audit log or any container log
  PASS  none of the four secrets in events
  PASS  no secret in any container log

58 passed, 0 failed
```

Host left as found: 25 containers before and after; zero `josi-ce-phase7`
containers, volumes or networks remaining.

### It took four runs, and three of the failures were worth having

| Run | Failed on | What it was |
|---|---|---|
| 1 | 13 checks | The script pointed Google's hostnames at the stub by editing `/etc/hosts` inside the web container. **Phase 2 gave that container a read-only root filesystem** — the hardening was working. Twelve of the thirteen were cascade. |
| 1 | *a passing check* | `callback accepted (302)` **passed while the callback was redirecting to `?error=`**. A 302 alone proves nothing: the failure path redirects too, so the assertion was satisfied by exactly the outcome it existed to catch. Same shape as the Phase 2 Caddy test that passed with the service down. |
| 2 | 3 checks | `extra_hosts` in a compose override reported success and changed nothing; the container still resolved the real Google IPv6 address. Replaced with Docker **network aliases**, which the embedded resolver answers for every container on the network. |
| 3 | 2 checks | DNS resolved to the stub and it still failed `network`: the app calls **https://**, and the stub served plain HTTP on 8080, so the client connected to :443 and found nothing. |
| 4 | 1 check | My own duplicated step, replaying a consumed state. |

Two changes came out of this that are worth keeping:

* **A fail-fast** after the handshake. Thirteen failures hiding one cause make
  the cause harder to find, not easier.
* **The stub speaks TLS with verification left ON.** Setting
  `NODE_TLS_REJECT_UNAUTHORIZED=0` would have been quicker and would have meant
  testing a security feature with its checks switched off.

---

## Proven / unproven

### Proven

| Requirement | Where |
|---|---|
| M28 — the operator's own OAuth application, no baked credentials | Unit + **runtime**: sealed in real PostgreSQL, plaintext absent, admin view returns neither secret nor ciphertext |
| M29 — per-user connection with separate encrypted tokens | Unit + **runtime**: tokens sealed; a colleague gets 404 to read, to change and to delete |
| M30 — admin sees health, never content | Unit + **runtime**: the view carries the owner's username and no address, scopes or tokens; the admin gets 404 on the member's own view |
| M32 — read first, re-consent for write | Unit + **runtime**: authorize URL carries no write scope; enabling one is 409 `needs_consent` |
| M33 (connector half) — tighten only, never loosen | Unit truth table + monotonicity + **runtime**: allow does not switch on, deny overrides, lifting restores the user's own choice |
| The handshake is single-use and session-bound | Unit + **runtime**: replay refused; a state redeemed from another browser is refused |
| No token, code, or provider body is ever logged | Unit + **runtime**: four secrets absent from `events` and from all container logs |
| Provider failures become an actionable category | Unit: `invalid_grant` → revoked (reconnect), 429 → rate limited (do not) |
| The full handshake works over real TLS in a container | **Runtime** |

### Unproven — deliberately out of Phase 7

| Claim | Why |
|---|---|
| Any real Google or Microsoft account connects | **No provider was contacted, by design.** The adapters are asserted against recorded response shapes and a TLS stub. First real contact is an operator's own application and account. |
| Reading or writing calendar and mail | Phase 7 delivers authorization and the capability model. The tools that *use* a connection are Phase 8 and later; nothing yet calls Gmail or Graph. |
| Token refresh against a live provider | Proven against a stub, including that a missing refresh token is kept and a dead grant marks the connection for reconnection. Real expiry behaviour is unobserved. |
| Microsoft revocation | Microsoft has no per-application revoke endpoint. Disconnecting deletes our copy and says so plainly; the note is asserted, the provider-side effect is not. |
| Box, Dropbox, Drive, OneDrive | Not built. The page says so and offers nothing to press. |
| The Connections UI in a browser | The pages are built and typecheck, and the Phase 6 browser suite covers the "not set up" state. No browser walked a completed connection. |

Nothing above is claimed as tested.
