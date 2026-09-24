# Parental Controls

> **BETA — do not trust or rely on this feature for a child's safety.** It is
> experimental and may fail, be delayed or behave unexpectedly. It controls
> only Josi. It cannot control a device, other apps, websites, location or
> emergencies, and it does not replace active adult supervision or proven
> device-level parental controls. Verify important restrictions independently.

A paid module. It lets **one named adult** look after **one named child
account** on this installation: read their conversations with Josi, set the
hours Josi will answer, set a daily limit, and see how much it is being used.

It is off on every installation until somebody activates a licence, and it
grants nothing to anybody except through an explicit relationship between two
accounts.

---

## What it is not

Read this part first, because the most damaging thing a control like this can do
is be believed.

* **It is not a device control.** Josi cannot lock a phone, close another app,
  filter the web, block a game, or see anything that happens outside Josi. If
  the limit that matters is the phone, the control that matters is on the phone.
* **It is not screen time.** A minute is counted when the child **sends
  something to Josi**. Time spent reading a reply is not counted, because this
  server cannot see a screen being looked at. "45 minutes a day" means 45
  minutes in which a message was sent, and every screen says so.
* **It is not administrator oversight.** The person who administers this
  installation activates the licence and gains nothing by it. They cannot see
  who is looking after whom, cannot read a child's conversations, cannot change
  anybody's hours, and there is no route that would let them.
* **There is no device enforcement planned, promised or stubbed.** No screen in
  the product implies one is coming.

## The three things that grant anything

1. **A licence.** `module_entitlements` holds one row per paid module. Without
   it the routes answer 404, the schedule enforces nothing, and a managed child
   is an ordinary member.
2. **A relationship.** `parental_links` holds one live row per child. It is the
   only thing that grants a parent visibility, and it is checked at the moment
   of every read — ending it ends the visibility with nothing to delete.
3. **A password and a second factor, together.** Creating or ending a
   relationship is spent against a `parental_authority_grants` row, issued only
   for both proved in one request, bound to one session, good for five minutes,
   consumed once.

Nothing else grants anything. Role does not. Workspace membership does not.
Being the super admin does not.

## What each act costs

| Act | Cost |
| --- | --- |
| Read your own family's pages | a signed-in session |
| Change a daily limit or a timetable | the session, plus the password again (`change_settings` step-up) |
| Create a managed account, or end a relationship | the session, plus the password **and** a code from an authenticator, in one request |

The password-again on a limit change is not ceremony. The realistic attacker on
this feature is the child on the parent's unlocked laptop.

## What the parent sees

* Every conversation the child has had with Josi, in full, including messages
  that arrived over Telegram or another connected channel.
* Minutes used today, and a summary of the last fortnight by day.
* Their timetable and their limit, and controls to change both.

Opening a conversation is written to the audit log **and shown to the child**.

## What the child sees

A page of their own that says, in plain words:

* who is looking after this account;
* exactly what that person can see — conversations, minutes, hours, last use;
* exactly what they cannot — the password, anything outside Josi, the ability to
  sign in as them;
* every time the adult looked, with what they looked at and when;
* what today's limit is, how much is left, and when Josi answers next.

Supervision somebody can see is a different thing from monitoring, and the
product takes the difference seriously enough to build the page.

## Child Mode

An account is in Child Mode exactly while a live `parental_links` row names it
and the module is entitled. In that state:

* Josi answers only inside the agreed hours and inside the daily limit, on
  **every** channel — the check is the first thing `runAssistantTurn` does, and
  every channel goes through that one function;
* the account cannot look after anybody, and cannot obtain an authority grant;
* the account cannot change its own hours or limit;
* everything else is unchanged. Their conversations are still theirs, their
  connections are still theirs, and nothing of theirs is transferred to the
  adult. Child Mode is a limit on time and a disclosure about visibility, not a
  demotion.

Ending a relationship removes the timetable, the limit **and the record of when
the account was being used** — that record was collected to enforce a rule that
no longer exists and to answer a question nobody may now ask. The child's
conversations are their own and are never touched.

If the licence lapses or is revoked, the module goes inert **in both
directions**: the parent stops being able to see anything, and the child stops
being held to a timetable that nobody with authority can see or change.

## Accounts

A parent creates a managed account from their Family page; it is a new account
on this installation, always an ordinary `member`, linked to them, with a
one-time set-up link to open on the child's device.

**There is deliberately no route that links an account that already exists.**
"Make this account my managed child" applied to somebody who already has one is
surveillance with a friendly name, and the person on the other end of it would
never be asked. One adult may look after twelve accounts at most — a blast
radius, not a licensing limit.

## What is recorded

In the ordinary audit log, as metadata and never as content:

`entitlement.activated`, `entitlement.revoked`, `entitlement.refused`,
`parental.authority_granted`, `parental.authority_failed`,
`parental.link_created`, `parental.link_ended`, `parental.controls_updated`,
`parental.conversations_listed`, `parental.conversation_read`,
`parental.usage_viewed`.

Payloads carry ids, counts, factor names and the *names* of fields that
changed — never their values, never a licence token, never a word of a
conversation. A schedule is a fact about a household, so even the hours stay out
of the trail the installation's administrator reads.

## The licence

The supported Admin licence page accepts the installation licence format
`<payload>.<signature>`: a JSON payload naming the covered features, buyer,
optional installation id and optional expiry, with an Ed25519 signature over
the payload bytes. Existing module-specific `josi-lic.1.<payload>.<signature>`
licences remain accepted for backward compatibility. Both formats are verified
against the same publisher key stamped into the build
(`BUILD_LICENCE_PUBLIC_KEY`, written by `scripts/stamp-edition.mjs`, absent by
default).

A build with no stamped key verifies nothing and refuses every licence, which is
the truthful state for an artefact the publisher did not build. The admin page
says exactly that rather than letting somebody paste a key that will never work.

A licence that names an installation is re-checked against
`install_identity.install_id` on every read, so a database restored onto another
machine keeps the row and loses the entitlement.

## Where the code is

| Piece | File |
| --- | --- |
| Schema | `packages/db/migrations/0039_parental_controls.sql` |
| Licences | `packages/core/src/entitlements.ts` |
| Authority, timetable, minutes | `packages/core/src/parental.ts` |
| Routes (member and admin) | `apps/api/src/http/parentalRoutes.ts` |
| Enforcement on every channel | `packages/agent/src/assistantAgent.ts` |
| Family page | `apps/web/src/pages/Family.tsx` |
| Licence page | `apps/web/src/pages/admin/ParentalControls.tsx` |

Tests: `apps/api/test/parentalControls.test.ts` (over the wire),
`packages/core/test/parental.test.ts` (licences, timetable, decision),
`packages/agent/test/parentalTurn.test.ts` (every channel).
