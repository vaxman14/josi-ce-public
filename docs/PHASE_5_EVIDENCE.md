# Phase 5 evidence — assistant core

Verified 2026-08-31. Every claim below is backed by recorded output or marked
unproven.

## Environment

| | |
|---|---|
| Static suite | macOS, Node 24, vitest 2.1.9, pglite |
| Runtime | dedicated LAN Docker host, Ubuntu 26.04, x86_64, Docker 29.1.3, Compose v5.5.0 |
| Compose project | `josi-ce-phase5` (isolated; the host's 25 unrelated containers untouched) |
| Host ports | 8394/8557 |
| Source | `b510a6c`, cloned from GitHub and checked out by hash |

No hosted model provider was contacted. The unit suite injects `fetchImpl`; the
runtime test talks to a stub container on the app's own Docker network.

---

## What was built

| Component | File |
|---|---|
| Task state machine | `packages/core/src/tasks.ts` |
| Threads, messages, contacts | `packages/core/src/conversations.ts` |
| Approval levels + pinned approvals | `packages/core/src/approvals.ts` |
| Step-up re-authentication | `packages/core/src/stepUp.ts` |
| Locks and calendar holds | `packages/core/src/locks.ts` |
| Job queue and scheduler | `packages/core/src/queue.ts` |
| Interrupt / correction metrics | `packages/core/src/metrics.ts` |
| The assistant turn | `packages/agent/src/assistantAgent.ts` |
| Tool catalogue | `packages/agent/src/tools.ts` |
| Schema | `packages/db/migrations/0004_assistant.sql` |
| HTTP surface | `apps/api/src/http/assistantRoutes.ts` |
| Worker job handling | `apps/worker/src/jobs.ts` |
| Suites | `packages/core/test/assistant.test.ts`, `packages/agent/test/agent.test.ts`, `apps/api/test/{assistant,worker}.test.ts` |
| Mutation harness | `scripts/mutate-phase5.sh` |
| Runtime verification | `scripts/test-assistant-runtime.sh` |

---

## The decision worth challenging: who owns a conversation

`docs/EXTRACTION_MAP.md` said `contacts`, `tasks` and `threads` would be
**workspace-shared** in CE, carried over from the engine. **Phase 5 changed
that**, and the map now carries the old text struck through rather than quietly
edited.

The engine's reasoning holds *there*: a tenant is one business speaking with one
voice, and its staff share the business's contacts and conversations because they
are the business. A CE workspace is not that. It is several people who happen to
share an installation, and the canonical decision map says so in every
neighbouring feature:

> "Operational email threads and inbound replies are visible only to the user who
> initiated the conversation by default… neither workspace membership nor
> super-admin status automatically grants content access."

> "Every mapped local/cloud folder and its derived index are private to the owning
> user by default."

> "the admin panel must not let them browse that user's email or calendar content."

A member's conversation with Josi carries whatever they told it — the same
material those lines protect. Shipping it workspace-readable by default would
have made the one table nobody argued about the leak.

So all three are owner-scoped through the Phase 1 spine. `messages` deliberately
carry **no owner of their own**: they are reachable only through their thread, so
a share cannot be half-applied and there is no second place for "who may read
this" to drift.

---

## The other departure: the engine's second factor does not transfer

The engine gates destructive acts behind a spoken PIN word, and its reasoning is
sound: *"Caller ID is spoofable… caller ID gets you a conversation. It does not
get you a destructive act."*

**That threat does not exist in CE.** There is no phone line. A request arrives
with a session cookie issued after a password login, behind CSRF. Nobody is
spoofing an identity claim.

What is still true is the *shape* of the risk: a session is not the person. A
borrowed laptop, an open tab, a stolen cookie — all are someone else holding a
legitimately issued session. The answer to that is re-authentication, not a
second secret to remember and eventually write on a sticky note.

**So this is step-up RE-AUTH and it is named that.** It defends against a held
session. It does **not** defend against a stolen password — an attacker holding
the password clears this gate as easily as the owner — and calling it a "second
factor" would claim otherwise. A genuine second factor (TOTP) is **not built**.

Kept from the engine unchanged, because it is right regardless of factor:

| | |
|---|---|
| Fail closed | an action on the list is refused until the session re-authenticates |
| Session-scoped | verifying in one conversation does not unlock another |
| Cool-down, not a life sentence | the engine counted failures over all time and locked an owner out of their own assistant permanently, three typos in a lifetime |
| Every blocked attempt logged | including those stopped by the lockout, so the most suspicious case is not the one that leaves no trace |

One failure mode disappears with the change of factor: the engine's
`no_factor_configured` dead end cannot occur, because every CE account has a
password by construction.

---

## Test totals

```
$ npm test
Test Files  13 passed (13)
     Tests  332 passed (332)      # 223 prior + 109 new
```

No earlier test was modified, weakened or deleted.

---

## Mutation testing

`scripts/mutate-phase5.sh`. Each mutation must demonstrably alter the tree
(`assert_mutated`) before its result is believed.

| # | Mutation | Tests failed |
|---|---|---|
| M1 | The super admin can read anyone's private resource | 3 |
| M2 | A non-owner gets 403 instead of 404 | 4 |
| M3 | Tasks are workspace-wide instead of owner-scoped | 3 |
| M4 | Conversation text is copied into the audit log | 2 |
| M5 | Slot VALUES are written to the audit log | 1 |
| M6 | The admin ceiling can LOOSEN a user's approval level | 5 |
| M7 | A risky action obeys the routine setting | 1 |
| M8 | An approval is not bound to the action it described | 1 |
| M9 | Anyone may decide someone else's approval | 2 |
| M10 | An approval can be spent while still pending | 1 |
| M11 | Step-up stops gating destructive actions | 7 |
| M12 | A step-up unlock is account-wide, not session-scoped | 8 |
| M13 | The lockout never lifts (life sentence) | 1 |
| M14 | An expired unlock still counts | 1 |
| M15 | The agent acts on someone else's task | 2 |
| M16 | The agent skips the step-up gate | 1 |
| M17 | Tools are offered to a model never proven to call them | 1 |
| M18 | An unprobed model is used anyway | 1 |
| M19 | A turn runs as the caller, not the thread's owner | 1 |
| M20 | A read-only share may speak into the conversation | 1 |
| M21 | The admin assistant view returns member content | 1 |
| M22 | The correction rate is scored over all tasks | 1 |
| M23 | The state machine permits any transition | 2 |
| M24 | Resource locks are not exclusive | 1 |
| **M25** | **The audit-payload content guard is removed** | **0 → 3** |
| M26 | An unknown job kind is marked done | 1 |

All restored; 332/332 green.

### The finding that mattered: M25, a gap four phases old

Deleting `assertMetadataOnly(payload)` from `appendEvent` left **all 328 tests
passing**.

Every audit test in the repo — Phase 1's, Phase 3's, and the ones written this
phase — asserts that content *does not appear* in the log. All of them do so with
payloads that never carried a content-shaped key, so they pass identically
whether the guard exists or not. `events.ts` even says the function is "exported
so tests can assert the guard itself works", and nothing ever did. The next
careless `payload: { body: … }` would have shipped in silence.

Four tests were added, including one that separates *the guard exists* from
*`appendEvent` actually calls it* — which is precisely the distinction M25
exposed. Re-applying M25 now fails three of them.

### Two defects found in my own port

Both were caught by tests ported alongside the code, which is what the plan's
risk line asked for.

1. **The correction-rate denominator.** I gave `task.created` `actor: 'user'`
   (worth auditing), which made *every* task count as "reviewed" and silently
   turned the correction rate into corrections-over-all-tasks — the exact
   denominator `metrics.ts` exists to avoid. Creating a task is not reviewing it;
   the creation kind is now excluded, with the reason recorded in the query.
2. **The append-only trigger.** A test tried to back-date `events` rows to
   simulate a cool-down and was refused — the Phase 1 guard working. The test
   inserts aged history instead, which is also the more faithful simulation.

---

## Runtime verification — 50/50

```
$ JOSI_HTTP_PORT=8394 JOSI_HTTPS_PORT=8557 PROJECT=josi-ce-phase5 \
    bash scripts/test-assistant-runtime.sh        # on a Linux test host, at b510a6c
```

Real sessions, real router, real PostgreSQL — the isolation claim cannot be
proven in pglite, because the thing under test is what the HTTP layer does with
a cookie.

```
== driving the wizard                    PASS  all steps; setup completed
== activating the stub model             PASS  probed and active
== creating two ordinary members         PASS  alice, bob, both signed in

== alice has a private conversation with Josi
  PASS  thread created; Josi answered (200); a real reply came back
  PASS  what she said is stored in messages

== BOB cannot reach any of it — 404, never 403
  PASS  her thread / task / contact are each 404 for a colleague
  PASS  a colleague cannot speak into her thread
  PASS  his own thread and task lists are clean

== a 404 for something real looks exactly like a 404 for something invented
  PASS  indistinguishable (404)

== the SUPER ADMIN cannot read her content either
  PASS  her thread / task / contact are each 404 for the super admin
  PASS  admin view contains none of her conversation, contact or task text
  PASS  admin view reports counts

== step-up re-auth in the real stack
  PASS  a wrong password is refused (401)
  PASS  another member's password does not work
  PASS  her own password unlocks the session
  PASS  one unlock recorded in PostgreSQL; no password in the event log

== approval levels: the admin may tighten and may never loosen
  PASS  alice chose automatic; the admin tightened it
  PASS  her own choice is preserved underneath
  PASS  the admin CANNOT loosen her choice
  PASS  a member is refused the admin policy route (403)

== the conversation never reaches the audit log
  PASS  none of her content in events; the exchange itself is recorded

== the queue carries ids, not content    PASS
== the worker is processing jobs         PASS  container healthy
== no secret in any container log        PASS

50 passed, 0 failed
```

Host left as found: 25 containers before and after; zero `josi-ce-phase5`
containers, volumes or networks remaining.

---

## Proven / unproven

### Proven

| Requirement | Where |
|---|---|
| The engine's task state machine, edge for edge | Unit: the whole transition table asserted; illegal transitions refused |
| Approval gates behave identically | Unit + runtime: pinned payload hash, one decision, owner-only |
| M31–33 — user choice, admin ceiling, deny-only | Unit: full 3×3 truth table; **runtime**: admin tightened, could not loosen |
| Risky actions asked about regardless of setting | Unit: `add_recipient`, `send_attachment` ignore `automatic` |
| Content private to its owner | Unit + **runtime**: 404 for colleague AND super admin, indistinguishable from a nonexistent id |
| A share is explicit, and read ≠ write | Unit + wire: read share can follow, cannot speak |
| A shared turn runs as the thread's owner | Unit + mutation M19: a share is not a way to act under another name |
| Conversation text never enters the audit log | Unit + **runtime**: log grepped for the exact strings |
| Slot values and contact details never enter the log | Unit + mutation M5 |
| Job payloads carry ids, not content | Unit + **runtime** |
| Step-up: fail closed, session-scoped, expiring, cool-down | Unit (7 tests) + **runtime** (real passwords) |
| Tools offered only for a PROVEN capability | Unit + mutation M17 |
| An unprobed or capped model refuses honestly | Unit: no request is made at all |
| Work with no executor waits rather than failing | Unit + worker test: state stays `ready`, `fail_reason` null |
| Locks are exclusive installation-wide | Unit + mutation M24 |
| The worker fails an unknown job kind | Unit + mutation M26 |
| Interrupt/correction rates derived from the log | Unit: denominator is "reviewed", not "all" |

### Unproven — deliberately out of Phase 5

| Claim | Why |
|---|---|
| Josi can actually book, send or file anything | **No executors exist.** Phase 5 ships the state machine; the calendar is Phase 7 and mail is Phase 8. Tasks needing them reach `ready` and wait, and both the agent and worker say so. |
| Any real model drives the agent well | Every test scripts the model's replies. Prompt quality against a real model is unmeasured. |
| Recall / memory search | The seam exists (`RecallLookup`); nothing implements it. Absent = the agent says it cannot search. |
| A genuine second factor | Step-up is password re-auth. TOTP is not built; see above. |
| Concurrency of the queue under load | `claimJobs` uses `FOR UPDATE SKIP LOCKED` and is proven not to double-claim in pglite, which serialises. Real contention is unproven. |
| Retention, trash, deletion of conversations | Map lines 39–40. Not in this phase. |
| Any UI | Phase 6. |

Nothing above is claimed as tested.

---

## Design notes worth challenging

### A task that cannot be attempted waits; it does not fail

Phase 5 has no executors. A `send_message` task is perfectly formed and has
nothing able to carry it out, so it reaches `ready` and stops. Marking it
`failed` would read, to the person waiting on it, exactly like Josi tried and
could not — and the template's `requires_capability` is surfaced to the model, to
the API caller and to the worker so none of them can imply otherwise.

### The agent says "there is no task with that id" for a colleague's task

Same wording as a task that genuinely does not exist, for the same reason the
HTTP layer answers 404 rather than 403: a model told "that one is not yours" can
be steered into enumerating a colleague's ids.

### The audit log gets lengths, not words

The engine wrote the full text of every owner exchange into `events`. In CE that
would put private conversation into the one table the super admin is expected to
read. `thread.exchange` records the channel and the character counts; the words
stay in `messages`, behind the thread's ownership.
