# Phase 3 evidence — setup wizard

Verified 2026-08-31. Every claim below is backed by recorded output or marked
unproven.

## Environment

| | |
|---|---|
| Static suite | macOS, Node 24, vitest 2.1.9, pglite |
| Runtime | dedicated LAN Docker host, Ubuntu 26.04, x86_64, Docker 29.1.3, Compose v5.5.0 |
| Compose project | `josi-ce-phase3` (isolated; unrelated projects untouched) |
| Host ports | 8390/8553 |
| Source | `28ce1a0`, cloned from GitHub and checked out by hash |

---

## What was built

| Component | File |
|---|---|
| Sealing + redacting `Secret` wrapper | `packages/core/src/sealing.ts` |
| Configuration schema | `packages/db/migrations/0002_setup.sql` |
| Step state machine | `apps/api/src/setup/steps.ts` |
| Host checks | `apps/api/src/setup/hostChecks.ts` |
| Wizard routes + completion latch | `apps/api/src/setup/setupRoutes.ts` |
| Setup/application boundary | `apps/api/src/http/setupGate.ts` |
| Suite | `apps/api/test/setup.test.ts` |
| Mutation harness | `scripts/mutate-phase3.sh` |
| Runtime verification | `scripts/test-setup-runtime.sh` |

---

## Test totals

```
$ npm test
Test Files  5 passed (5)
     Tests  124 passed (124)      # 75 prior + 49 new
```

Phase 1 and Phase 2 test files are **byte-identical** to `7be3893`:

```
$ git diff --quiet 7be3893 -- apps/api/test/authorization.test.ts   # unmodified
$ git diff --quiet 7be3893 -- apps/api/test/readiness.test.ts       # unmodified
$ git diff --quiet 7be3893 -- apps/api/test/packaging.test.ts       # unmodified
$ git diff --quiet 7be3893 -- packages/core/test/masterKey.test.ts  # unmodified
```

`apps/api/test/fixtures.ts` — a helper, not a test — now marks setup complete
alongside creating the workspace, because Phase 1's suites exercise a
*configured* installation and the gate legitimately refuses everything else
before setup. No assertion was changed, removed or relaxed.

---

## Mutation testing

`scripts/mutate-phase3.sh`. Each mutation must demonstrably alter the tree
before its result is believed — added after M3 silently stopped applying and
reported a false "not caught".

| # | Mutation | Tests failed |
|---|---|---|
| M1 | Allow a non-setup route before completion | 2 |
| M2 | Return the wizard after completion | 3 |
| M3 | Remove `and completed = false` from the completion latch | 1 |
| M4 | Permit step skipping | 2 |
| M5 | Default telemetry on | 7 |
| M6 | Store a plaintext secret instead of sealing | 1 |
| M7 | Remove the external-provider acknowledgment requirement | 1 |
| M8 | Return a secret in the review summary | 1 |

All restored; 124/124 green.

---

## The finding that mattered: an untested single-use guarantee

M3 initially **passed**, meaning the single-use completion guard was not covered
at all.

Cause: **pglite serialises queries.** Measured rather than assumed —

```
select pg_sleep(0.05)  and  select 1  issued together
completion order: a,b        # the sleep finished first
```

So the HTTP-level "concurrent finishers" test never reached the SQL latch. The
route's earlier `if (state.completed) return 404` won every time, and the
`and completed = false` clause could be deleted with no test noticing.

Two fixes:

1. The latch is now `sealSetupOnce()`, an exported function exercised directly —
   call it four times, expect a row once and null thereafter. M3 now fails.
2. Genuine concurrency is proven at runtime against real PostgreSQL, where
   statements actually overlap (below).

---

## Runtime verification — 37/37

```
$ JOSI_HTTP_PORT=8390 JOSI_HTTPS_PORT=8553 PROJECT=josi-ce-phase3 \
    bash scripts/test-setup-runtime.sh
```

```
== before setup: only the wizard is reachable
  PASS  setup state is served
  PASS  refused /api/auth/me (503)
  PASS  refused /api/auth/csrf (503)
  PASS  refused /api/connections (503)
  PASS  refused /api/admin/users (503)
  PASS  refused /api/admin/workspace (503)

== driving the wizard
  PASS  step host_checks accepted        ... through all nine steps

== step ordering is enforced by the server
  PASS  replaying a completed step is refused (409)

== authority fields in the body changed nothing
  PASS  owner is super_admin despite body claiming member
  PASS  exactly one user exists

== secrets are ciphertext in real PostgreSQL
  PASS  LLM key stored as sealed ciphertext
  PASS  plaintext LLM key absent from the column
  PASS  SMTP password sealed
  PASS  copy-from-system stores no duplicate credential

  PASS  no secret in any container log
  PASS  telemetry is off (was omitted)
  PASS  review response is redacted

== CONCURRENT completion against real PostgreSQL
  PASS  exactly one completion won (codes: 200 404 404 404 404)
  PASS  still exactly one super admin

== after completion the wizard is gone
  PASS  /api/setup/state is 404
  PASS  /api/setup/host-checks is 404
  PASS  /api/setup/review is 404
  PASS  complete is 404
  PASS  the application is now reachable

== completion survives a restart and does not reopen
  PASS  wizard still gone after restart
  PASS  still one super admin after restart

37 passed, 0 failed
```

Phase 2's suite re-run at the same commit: **36 passed, 0 failed** — no
regression.

---

## Proven / unproven

### Proven

| Requirement | Where |
|---|---|
| 1. Fresh DB exposes setup, refuses protected routes | unit + runtime (5 routes, 503) |
| 2. Health/readiness exceptions are narrow | test asserts `SETUP_EXEMPT_PREFIXES === ['/setup']` |
| 3. Rejects skips, regressions, forged names, malformed input, client authority | unit: 7 tests incl. a body carrying role/id/completed/install_id |
| 4. Half-completed setup resumes after restart | unit: server restarted mid-wizard, resumes at `llm`, data intact |
| 5. Owner creation + completion safe under duplicates | unit (serialised) + **runtime (genuine concurrency)** |
| 6. Completion makes setup routes 404 | unit + runtime, all 5 routes |
| 7. Replays cannot create a second super admin | unit + runtime; DB index also proven to reject a direct insert |
| 8. Missing master key fails closed, stores no plaintext | unit: 503, zero rows, DB grepped for the value |
| 9. Secrets encrypted, absent from responses/logs/DB | unit + runtime (`v1.` ciphertext, log grep) |
| 10. External LLM blocked without acknowledgment | unit: 6 falsy/coerced variants all 400 |
| 11. SMTP copy-from-system: 2 profiles, 1 credential | unit + runtime (`password_enc` NULL on communications) |
| 12. Connectors optional; skip writes nothing | unit: 0 rows; half-credential refused |
| 13. Telemetry off unless literal `true` | unit: 8 falsy/coerced variants; DB constraint blocks enabling without consent |
| 14. Review/metadata contain no secret values | unit + runtime |
| 15. Phase 1/2 tests unmodified and green | `git diff --quiet` per file; 124/124 |

### Unproven — deliberately out of Phase 3

| Claim | Why |
|---|---|
| ACME certificate issuance | No challenge was performed. `certificate_verified_at` stays null and a test asserts it. |
| LLM provider reachability | No provider was called. Phase 4 owns the capability probe. |
| SMTP delivery | No message was sent. `verified_at` stays null. Phase 8 owns delivery. |
| OAuth account connection | No flow was started. Phase 7. |
| Telemetry transmission | Nothing is sent; a test asserts the module contains no outbound call. |
| Setup **UI** | Phase 3 delivers the API and state machine. The wizard's screens are Phase 6. |

Nothing above is claimed as tested.

---

## Design notes worth challenging

**503, not 404, for non-setup routes before completion.** Those routes exist and
will work shortly. A 404 would be a lie, and the response carries
`setupRequired: true` so a client can route to the wizard. An unconfigured
install already announces itself by serving a wizard.

**404, not 403, for setup routes after completion.** 403 would advertise that a
super-admin factory used to be there.

**The owner step issues no session.** A wizard that hands out an authenticated
session mid-flow is one more thing to race. The operator signs in normally once
setup completes.

**`local_file_access_enabled` is not settable from the wizard.** Local access
needs a Docker mount *and* an application allowlist (M45), so it cannot be
switched on from a web form.

**Host checks report no versions, paths or byte counts.** The page is
unauthenticated. A test greps the response for `/usr/`, `/var/`, semver strings
and long digit runs.
