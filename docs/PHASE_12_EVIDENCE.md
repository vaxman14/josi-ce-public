# Phase 12 — Identity, Memory and Constrained Behaviour: what is proven, and what is not

The plan states the risk in one sentence, and everything below follows from it:

> **reproducing OpenClaw's unrestricted instruction-file semantics would turn
> personalization into privilege escalation. CE deliberately reproduces the
> personal *experience*, not the authority model.**

## Evidence

| | |
|---|---|
| Tests | **1088 passed** across 33 files |
| Mutation testing | **30/30** (`mutate-phase12.sh`), **17/17** (`mutate-phase12-1.sh`), **9/9** (`mutate-phase12-2.sh`) |
| Runtime on a Linux test host | **68 checks** (persona) and **65 checks** (backup/restore), 0 failed |
| Secret scan | clean, 261 files |
| Host impact | 25 containers before, 25 after, no leftovers |

## How the boundary is actually held

**A profile never becomes instructions.** Markdown arrives as untrusted data and
is parsed into a bounded configuration — named fields, enumerated values, hard
length limits. Only that configuration reaches prompt assembly. There is no
passthrough field and no escape hatch, because an escape hatch is the feature
being refused.

**`AGENTS.md` has no free-text field at all.** Behaviour is where a sentence
would do the most damage, so that layer is entirely enums. A test asserts every
field is an enum with a closed value set, so adding prose there fails the suite.

**`SOUL.md` does accept prose**, because the plan requires a fully custom
personality. It lands in one field whose only effect is voice.

**And the load-bearing part is not the prompt at all.** Position in a prompt is a
weak signal; a determined instruction later can talk over an earlier one. What
makes the core authoritative is that approvals, ownership and tool permission are
enforced by **routes reading database rows**, entirely outside the assembled
string. A model wholly persuaded by a hostile personality still cannot delete a
file, because the route checks an approval row rather than the assistant's
willingness. `assemble.ts` says this in its header so a future reader does not
mistake the labelling for the control.

## The acceptance criterion, line by line

| The plan asks | Proven by |
|---|---|
| Two users get demonstrably different personalities and memories, no cross-user leakage | Runtime: two real sessions, each asserting the other's marker absent from profiles, prompts and memory |
| Import/export is an exact round trip | Runtime: exported from one person, imported by another, byte-identical profile |
| Restart, backup/restore and upgrade retain all profiles | The database is canonical; profiles survive container replacement. **Backup/restore of profiles is not separately exercised** — see below |
| Reset changes no conversations or unrelated memory | Unit: reset one layer, other layers and memories untouched |
| Deleted memory cannot be recalled | Runtime: recalled while present, gone after deletion, row absent from the table |
| A hostile profile attempting to disable approvals, expose a secret, access another user, invent a tool, or alter core policy has no effect | Five separate unit tests plus a runtime pass against the running server |

The hostile case is written as **five tests rather than one**, because "has no
effect" is five different claims. Each fails for the same structural reason:
there is no field to set.

## Proven

| Claim | How | Where |
|---|---|---|
| An unknown field never enters the configuration | Dropped and reported | unit, mutation M1, runtime |
| An unrecognised value is refused, not coerced to a near one | `humour: savage` sets nothing | unit, mutation M2 |
| The behaviour layer cannot gain free text | Every field asserted an enum | unit, mutation M3 |
| Nothing is silently ignored | Every drop carries an explanation | unit, mutation M4–M5 |
| Lines that read like orders are named to the person | Reported, not refused — it is their file | unit, mutation M6, runtime |
| Size limits hold, and an oversized file is refused rather than truncated | 413, not a silent trim | unit, mutation M7–M8, M28 |
| The core is first and never omitted | Section order asserted | unit, mutation M9 |
| The authority note is present and says what it must | Text asserted | unit, mutation M10–M11 |
| A user may tighten the installation policy, never loosen it | Monotonic ordering | unit, mutation M12, runtime |
| Overridden settings are named to the user | `narrowedByPolicy` | unit, mutation M13, runtime |
| Only relevant memories enter a turn | Pinned plus matched, never the whole store | unit, mutation M14 |
| Memory is owner-scoped in retrieval, edit and delete | 404 for a colleague and the administrator alike | unit, mutation M15–M16, runtime |
| Delete means delete | No `deleted_at` column exists, asserted | unit, mutation M17, runtime |
| A credential is refused, and not even kept as a suggestion | Patterns refused before storage | unit, mutation M18–M19, runtime |
| Revoking a source purges its memories and no others | Keyed on source id | unit, mutation M20 |
| Automatic memory is opt-in, in code and in the schema | `information_schema` default asserted | unit, mutation M21–M22 |
| Profile and memory content never reach the audit log | Asserted absent from events and container logs | unit, mutation M23–M24, runtime |
| An import cannot rewrite installation policy | Admin layer excluded from import | unit, mutation M25, runtime |
| Only an administrator writes installation policy | 403 for a member | unit, mutation M26, runtime |
| The owner comes from the session, never the body | Naming a colleague writes to the caller | wire, mutation M27 |
| The settings screen explains what each layer cannot do | Returned with every read | wire, mutation M29, runtime |
| Reset does not clear memories | Asserted alongside | unit, mutation M30 |

## Phase 12.1 — the two gaps, closed

The first version of this document recorded two honest gaps: nothing consumed
the assembled prompt, and nothing ever called `suggestMemory`. Both are now
wired, tested and verified on real containers.

**Every live turn is personalized.** The agent assembles the system context as
immutable core → authority note → admin policy → narrowed user preferences →
soul → user → relevant memory, and the request stays in one user message.
Verified on a Linux test host: two people get different personalities in real model calls,
neither leaks into the other, the core and the authority note are present, and
`USERTURNS<<1>>` proves the request is not duplicated.

**Every completed exchange is learned from, narrowly.** Extraction reads only
the person's own message — never the reply, never tool output — matches explicit
first-person statements, refuses questions, transient requests, secrets and
sensitive categories, and caps at two per turn. All three memory modes verified
through real HTTP: manual raised one suggestion and stored nothing, off stored
nothing at all, automatic saved and still refused a credential.

**Authority is unchanged.** A hostile profile reaches the model as words in a
live turn while inventing no field and no tool, and its author is still not an
administrator.

## Not proven

**Backup and restore of profiles is not separately exercised.** Profiles live in
ordinary tables, so a Phase 10 `full` backup includes them, and the Phase 10
restore test proves rows return. But no test takes a backup, wipes, restores and
then asserts a *profile* came back.

**Upgrade retention is untested for the same reason as Phase 10:** no update has
ever been applied, so "upgrade retains all profiles" is an inference from the
database being canonical, not a measurement.

**There is no first-run personalization flow.** The plan asks for one that is
optional and skippable. `persona_settings.onboarding_skipped` exists and is
settable; no wizard uses it. Defaults do preserve the current brief personality,
and the assistant works with no profile at all, which is the part that mattered.

**No live response preview.** The plan asks for one alongside presets.
`/api/persona/preview` returns the assembled *context*, which is more honest
than a fake reply but is not what was asked for. **No presets ship.**

**Version history is retained but not surfaced.** `listVersions` and reset-to-
version work and are tested; the settings page shows the current version number
and offers no history list.

## Defects worth recording

**The Phase 6 jsonb defect, in a package written six phases later.** Profile data
was written to a jsonb column with `JSON.stringify`; postgres.js serialises the
value itself, so the column held a jsonb *string scalar* and `parsed->>'field'`
returned null. Under pglite it parses, so 1038 unit tests passed.

The static guard added after Phase 6 did not catch it, because that guard looks
for `JSON.stringify` paired with an explicit `::jsonb` cast — and writing a jsonb
**column** needs no cast. The guard knew one shape of the bug and the bug had
two. The same latent defect was sitting in telemetry's `last_payload`, where
Phase 10's test asserted the value was "truthy" — which a string scalar
satisfies. Both fixed with the `json()` helper; the guard now flags a
hand-serialised value anywhere in a query's parameter list, and it was verified
by reintroducing the defect rather than assuming.

**Phase 12.1: the mutation harness measured stale compiled output.** A consumer
importing `@josi-ce/persona` resolves to the package's built `dist`; the harness
edited source and never rebuilt. Nine mutations were recorded as "survived" when
they had never been applied to the code under test. Confirmed by applying one by
hand and rebuilding. `run()` now rebuilds first and `restore()` rebuilds after,
fixed across all ten mutation scripts. **Per-package mutations were sound —
those tests import `../src` directly — but cross-package mutations in earlier
phases were measured the same way, and that caveat belongs on the record.**

**Phase 12.1: two extractor defects, both letting through what the design
forbids.** `"She always works mornings"` was extracted, because the bare
`always`/`never` patterns had no first-person requirement — an observation about
a third party would have become a durable fact about the user. And transient
verbs matched bare stems only, so `booked` escaped `book`, then `reminders`
escaped `remind` and `sent` escaped `send`: three attempts at enumerating
English before switching to stem-plus-any-suffix. Over-matching refuses to learn
something; under-matching turns a request with a deadline into a permanent fact.

**Phase 12.1: memory retrieval ANDed every word of the request.** `"where should
I go sailing?"` became `go & sail` and matched nothing. Memory would have been
silently useless in production — retrieved by unit tests passing bare keywords,
and never by a real sentence.

**Phase 12.2: four assertions that could not observe their own mutations.** A
preset setting a forbidden field changed nothing, because `renderProfile` only
emits fields in the spec — real defence in depth, but it meant preset values
were never checked. The preview taking an owner from the request body was
invisible because no test sent one. A mutation labelled "omits the authority
note" actually removed the preview core, since the note is added regardless of
what core is passed. And version history could be read for another person by
naming them in the query string, while the test only checked that a colleague
with no history saw nothing — which passes either way.

**Phase 12.2: an assertion that passed on its own failed setup.** The profile
restore check compared the count before against after; a partial unique index
made the seed insert nothing, both counts were zero, and `all 0 personalization
profiles came back` passed. Written minutes after describing that exact pattern
elsewhere. It now requires a non-zero count and the seed step exits the run
rather than letting everything downstream compare zero to zero.

**Three claims that lived only in comments.** Mutation testing found that "the
behaviour layer has no free-text field", "manual memory is the default", and
"the owner comes from the session" were each asserted in prose and checked
nowhere. The code was right in all three cases; nothing would have noticed if it
stopped being. That pattern — a security property stated in a comment is not a
property — has now accounted for a majority of the mutation gaps in this
project.
