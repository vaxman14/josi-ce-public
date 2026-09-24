# Native contact sync — server contract and implementation handoff

> **Status: SPECIFICATION AND SHARED CORE ONLY.**
>
> No mobile application is built in this repository, and none should be. This
> document is the contract the Josi mobile repository implements against, plus
> the parts of it that live server-side.
>
> What exists here today: the identity, normalisation and deduplication core in
> `packages/core/src/contactIdentity.ts`, with 25 tests. What does not exist:
> the sync endpoints, the tombstone store, and any device code. Sections marked
> **NOT BUILT** are specification, not description.

## Why this is a document rather than a feature

Launch blocker 9 asks for native iOS and Android contact synchronisation. Three
things follow from where that work belongs:

1. **The device half cannot live here.** It needs the platform contact APIs,
   the platform permission model, and an app-store release. Putting it in the
   server repository would produce code nobody can run.
2. **The dangerous half is not the device half.** Matching two records is what
   decides whether two colleagues who share a family phone line become one
   contact. That is a privacy failure a merge button cannot undo, and it is the
   same decision for Google, for Microsoft and for a phone — so it is built
   once, here, and every client uses it.
3. **Nothing about this can be verified without a device.** Grant, limited
   grant, denial, revocation and reinstall are all OS behaviours. They are
   listed as required evidence below and none of them is claimed.

## The model

A contact has one owner and one or more **origins**. An origin is a source and
an account together — `google/alice@example.test` and `google/bob@example.test`
are different origins, and so are two phones belonging to one person.

```
ExternalContact {
  source        'josi' | 'google' | 'microsoft' | 'device'
  sourceAccount which connected account or device
  sourceId      the provider's own stable id
  displayName
  emails[]
  phones[]
}
```

`sourceId` is the platform identifier, not something the client invents:
`resourceName` on Google People, `id` on Microsoft Graph, the platform contact
identifier on a device. It has to survive a rename, because a rename is not a
new person.

### Matching — the part that is already built

`matchContacts(a, b)` returns a confidence, a reason a person can read, and
whether a machine may act on it alone.

| Rule | Confidence | Auto-merge |
|---|---|---|
| Same source, same account, same id | `exact` | **yes** — the same row seen twice |
| Same email **and** same name | `strong` | no |
| Same email, different name | `strong` | no — `office@` is listed by everybody |
| Same phone **and** same name | `strong` | no |
| Same phone, nothing else | `weak` | no — this is the family phone |
| Same name only | `none` | no — there are a lot of people called James Smith |

**Exactly one rule may merge unattended, and it is the one that is not really a
match.** Everything else goes in front of a person. Clients must not add rules
of their own; a client that merges on its own evidence is a client that can
merge two people the server would have kept apart.

Duplicates are reported as **pairs, never as clusters**. Collapsing a chain of
pairs is transitive merging, which is how A-matches-B and B-matches-C ends up
merging two people who share nothing.

Normalisation is shared and deliberate: emails are case-folded but **not**
dot-stripped or plus-stripped (right for Gmail, wrong almost everywhere else);
phones become E.164 where the input carried enough to be sure, and the
installation's country code is applied only to a number that looks national —
never to one that already has a country code, which is how two people in two
countries collide. An unparseable value normalises to null, and null never
matches anything.

## The endpoints — NOT BUILT

Everything in this section is specification.

All of it is per-user. A device belongs to one account, and nothing here is
reachable with another user's session. The existing ownership spine governs it
exactly as it governs conversations.

### `POST /api/contacts/device/register` — NOT BUILT

Registers a device as an origin. Returns an opaque `originId` the client keeps.
Registering twice from the same device returns the same origin.

```jsonc
// request
{ "platform": "ios" | "android", "deviceName": "Alice's iPhone", "installId": "<stable per-install id>" }
// response
{ "originId": "...", "syncMode": "import_only", "lastSyncAt": null }
```

`installId` must be stable across app launches and **must change on
reinstall** — a reinstall is a new origin, because the platform contact
identifiers it will report are new.

### `POST /api/contacts/device/{originId}/sync` — NOT BUILT

The client sends what it has; the server decides what that means.

```jsonc
{
  "permission": "granted" | "limited" | "denied" | "revoked",
  "cursor": "<opaque, from the previous response>",
  "contacts": [ { "sourceId": "...", "displayName": "...", "emails": [], "phones": [] } ],
  "deleted": [ "<sourceId>" ],
  "complete": true
}
```

- `permission` is reported on every call, not just when it changes. A client
  that stops reporting is treated as `revoked` after the staleness window.
- `deleted` carries platform identifiers the client can no longer see. On
  `limited` permission the server **must ignore it entirely** — under limited
  access, "I cannot see it" and "it is gone" are indistinguishable, and
  treating one as the other deletes contacts the user still has.
- `complete: false` means more pages follow; the server holds the cursor open
  and applies nothing until the last page.

Response:

```jsonc
{
  "cursor": "...",
  "applied": { "created": 12, "updated": 3, "unchanged": 200 },
  "needsReview": [ { "left": {...}, "right": {...}, "reason": "...", "confidence": "weak" } ],
  "toDevice": [ ... ]   // only in two-way mode
}
```

`needsReview` is never applied by the client. It is surfaced to the user, who
decides, and the decision goes back through the merge endpoint.

### `POST /api/contacts/merge` — NOT BUILT

Takes two contact ids and a decision: `merge`, `keep_separate`, or `defer`.
`keep_separate` is recorded as a **tombstone against the pair**, so the same
suggestion never appears again. Without that, a rejected merge is re-proposed
on every sync and users learn to click through it.

### `DELETE /api/contacts/device/{originId}` — NOT BUILT

Stops sync. **Deletes nothing** — not on the server and not on the device.
Removing an origin removes the link, and the contacts that came through it stay
where they are, marked as no longer syncing. Disconnecting a source is not
consent to lose the data it brought.

## Permission states — NOT BUILT

The whole reason this cannot be verified without a device.

| State | Server behaviour |
|---|---|
| `granted` | Full sync. Deletions are honoured. |
| `limited` (iOS 18+) | Sync what is offered. **Deletions ignored** — see above. Shown to the user as limited, because a partial import that looks complete is worse than one that says it is partial. |
| `denied` | Nothing is sent, nothing is stored. Not an error state; the user said no. |
| `revoked` | Future sync stops. Nothing is deleted on either side. The origin is marked and the user is told. |
| signed out | The session ends; the origin persists until deleted. Signing back in resumes without re-importing, because `sourceId`s are stable. |

## What the mobile repository must implement

1. **Ask at the right moment.** OS permission is requested only after the user
   has pressed something that says what it is for. A permission prompt on first
   launch is how an app gets denied permanently.
2. **Selective import.** The user chooses what comes across before anything
   leaves the device — all, a chosen set, or a single contact.
3. **Two-way is a separate, later choice.** Import-only is the default and the
   only mode offered at first connect.
4. **Never merge locally.** Send everything; the server decides. `needsReview`
   is displayed, never auto-applied.
5. **Report permission on every sync**, including `denied` — silence is
   indistinguishable from a crashed app.
6. **New `installId` on reinstall.**
7. **Handle background restrictions** by treating sync as best-effort and never
   reporting "synced" from a run that did not complete.

## Required evidence before this may be called supported

Real devices, both platforms, every row:

| Case | iOS | Android |
|---|---|---|
| Permission granted, first import | — | — |
| Limited access granted (iOS 18+) | — | n/a |
| Permission denied at the prompt | — | — |
| Permission revoked in system settings after a sync | — | — |
| Contact updated on device, re-synced | — | — |
| Conflicting edit on both sides | — | — |
| Contact deleted on device | — | — |
| App reinstalled | — | — |
| Signed out and back in | — | — |

**Every row is empty, and every row must stay empty until a real device has
produced it.** No dash in this table may be filled in from a simulator: the
limited-access and revocation behaviours are exactly the ones simulators model
badly.

**BLOCKED, and not pending.** On 2 September 2026 Roman confirmed that mobile
hardware will not be provided for this work. LB9.6 therefore cannot be closed
here by anyone, and nothing is waiting on a queue: the table stays empty until
whoever owns the mobile repository runs these cases on real iOS and Android
devices. Treat "native contact sync" as **specified and unsupported** in every
document, release note and UI string until that happens.

**Exact dependency:** a physical iOS device and a physical Android device, plus
write access to the separate Josi mobile repository. Nothing in this repository
can substitute for either.

## Status against LB9

| ID | Promise | State |
|---|---|---|
| LB9.1 | Server contract exists | Specified here; endpoints **NOT BUILT** |
| LB9.2 | Cross-source dedup without collapsing unrelated people | **BUILT AND TESTED** — `contactIdentity.ts`, 25 tests |
| LB9.3 | Per-user isolation preserved | Spine exists (Phase 1); device origins **NOT BUILT** |
| LB9.4 | Permission states modelled | Specified here; **NOT BUILT** |
| LB9.5 | Handoff document | **This document** |
| LB9.6 | Real-device tests | **BLOCKED** — no mobile repository access and no physical device |
