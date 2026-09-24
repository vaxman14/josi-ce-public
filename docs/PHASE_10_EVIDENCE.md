# Phase 10 — Backup, Export, Updates, Diagnostics: what is proven, and what is not

The plan states this phase's risk in one line, and it turned out to be exactly
right:

> **a backup that cannot actually be restored → the restore test is the
> acceptance criterion, not the backup test.**

That is not a stylistic preference. **819 unit tests passed against a backup
feature that was completely non-functional on a real installation**, for three
independent reasons, none of which a unit test could see. The restore test found
all three.

## Evidence

| | |
|---|---|
| Tests | **827 passed** across 28 files |
| Mutation testing | **49 of 49 caught** (`scripts/mutate-phase10.sh`) |
| Runtime on a Linux test host | **61 checks, 0 failed** — real `pg_dump`, real wipe, real restore |
| Secret scan | clean, 232 files |
| Host impact | 25 containers before, 25 after, no leftovers |

## The acceptance criterion, measured

The runtime test does the real thing against real PostgreSQL:

It also drives `runUpdate` inside the container against the real database, so
rollback is verified against real constraints rather than injected fakes:
rolled back, `health_check_failed`, one backup taken **first**, the recorded
version still the old one — and an update whose backup fails does not apply
anything at all.

The restore sequence:

1. Seals a credential **through the application's own route**, so the ciphertext
   is genuine rather than something the test constructed.
2. Takes a real `pg_dump` through the real HTTP endpoint — **21,743 bytes**.
3. Reads the archive and proves three things about it:
   - the **plaintext** credential is **not** in it
   - the **sealed ciphertext is** in it
   - the **master key is not** in it
4. **Drops the schema.**
5. Restores, and confirms all 3 users return and the ciphertext is
   **byte-identical**.
6. Signs the administrator back in and reads a table that was dropped and came
   back.
7. **With the key**: the credential decrypts — the provider probe returns 200.
8. **Points the installation at a different master key**: the credential
   **cannot be used** — 409, and the ciphertext is untouched.
9. **Restores the original key**: it works again.

Steps 7 and 8 are the pair the plan asks for. The credential is not merely
reported as unavailable; it is demonstrably unusable and then demonstrably
usable again, with the same bytes in the database throughout.

## Three defects that made backup non-functional

Each was invisible to the unit suite, and each alone was fatal.

**1. There was no backup path in production.** `backupWriter` was injected for
tests and `undefined` in production, so the endpoint could only return 503. A
backup feature that passes its tests against a stub and returns 503 to real
users is a test suite with a UI. `pgWriter.ts` is the real implementation —
`pg_dump`, gzip, categorised errors, and `--single-transaction` on restore so a
failed restore leaves the database as it was rather than half-replaced.

**2. The backup directory was not writable.** Docker seeds a fresh named volume
from the image path it covers, ownership included. `/data/backups` did not exist
in the image, so the daemon created it `root:root` and the application runs as
`node`. Every backup would have failed with a permission error. The directories
are now created in the image, owned by the runtime user.

**3. `pg_dump` was too old to read the database.** Debian bookworm ships client
15; the compose file uses `postgres:16`; `pg_dump` refuses to dump a server newer
than itself. This is the worst of the three because it presents as a generic
failure — the database is reachable, the tool simply cannot read it — and it sent
the first diagnosis looking at permissions and connectivity. The image now
installs `postgresql-client-16`, and **a packaging test derives the required
major from the compose file**, so bumping the database image without bumping the
client fails the suite instead of silently breaking backups.

## A defect in the verification tool itself

`assert_mutated` — the guard that is supposed to catch a mutation that failed to
apply — **had never fired, across Phases 7 to 10.** It compared `$BACKUP/apps`
against `apps` with `diff -rq`, but the backup directory only ever held the few
files named in `FILES`. The comparison always found differences, so the guard
always reported "mutated", including when the mutation had changed nothing.

A guard that cannot fail is precisely the defect class this harness exists to
find, sitting inside the harness. It now compares the named files with `cmp`, and
proved itself within minutes: M37's mutation had stopped applying after an edit
to the line it targeted, which the old guard would have recorded as a clean pass.
In Phase 9 the same situation occurred with M97 and had to be diagnosed by hand.

## Proven

| Claim | How | Where |
|---|---|---|
| A restore with the key recovers credentials | A real sealed credential opens; the provider probe returns 200 | unit, runtime |
| A restore without the key demonstrably does not | 409; wrong key throws; ciphertext intact; the outcome says so | unit, runtime |
| The master key is never in a backup | Column constrained false; the key's bytes are absent from the archive | unit, mutation M4, runtime |
| The plaintext credential is never in a backup | Grepped the real archive | runtime |
| A full backup includes recovery copies; a portable export never does | Constraint and contents table | unit, mutation M7–M8 |
| A backup lives inside Josi's own volume | Path constraint; traversal refused | unit, mutation M9 |
| A filename cannot carry separators or traversal | Stripped, dot-runs collapsed, residual `..` refused | unit, mutation M12 |
| Updates are never automatic | No column exists that could enable one | unit, mutation M22, runtime |
| An update backs up FIRST and stops if that fails | Call ordering asserted | unit, mutation M14–M15 |
| A failed health check rolls back and keeps the old version | State and recorded version | unit, mutation M16–M17 |
| A failed rollback is reported as its own category | Not softened; says it needs a person | unit, mutation M18 |
| Diagnostics contain no content | Fixed section list; message and thread bodies absent | unit, mutation M23, runtime |
| Secrets are redacted, and the assembled bundle scanned again | Per-section plus a final pass | unit, mutation M24–M25 |
| A bundle cannot be approved before it is read | 409; database constraint too | unit, mutation M27–M28, runtime |
| Bundles are capped at 25 MB, trimming oldest logs and naming what went | Byte ceiling; newest retained | unit, mutation M29–M31 |
| Telemetry is off, and sends nothing while off even with an endpoint stored | Sender never called | unit, mutation M32, runtime |
| Telemetry carries only allowlisted fields, and no free text | Injected keys dropped; sentences refused | unit, mutation M33–M35 |
| Disabling telemetry clears the endpoint | Whatever the caller passed | unit, mutation M37 |
| A bug report cannot be submitted without diagnostics | Code and database constraint | unit, mutation M38/M44 |
| Nothing is transmitted with no gateway configured | Ticket stays draft | unit, mutation M42, runtime |
| A restore needs an explicit confirmation | A bare POST does nothing | unit, mutation M49 |
| No path, description or content reaches the audit log | Asserted absent | unit, mutation M13/M43 |

## Not proven

**No update has ever been applied.** The rollback path is now verified against a
real database rather than only against injected fakes — the runtime test drives
`runUpdate` inside the container and confirms the state machine, the recorded
version, and the refusal to proceed without a backup. But **nothing has
downloaded an image, run a migration, or replaced a container.** There is no
update channel and `fetchLatestVersion` is unset in production, so
`checkForUpdate` finds nothing. "A failed update rolls back automatically" is
proven for every failure the code models; it is not proven against a real
release, because there is no release to try.

**The portable export is not human-readable.** M63 calls for a "portable
human-readable export"; what exists is a `pg_dump` with derived tables excluded.
It is portable and it excludes recovery copies, but it is SQL, not documents and
CSVs somebody could open. **This is a genuine shortfall against the decision.**

**Diagnostics collect no logs or container health.** The bundle builder handles
both — with redaction, trimming and the size cap tested — but the route passes
empty arrays, because reading container state needs a Docker socket the app
deliberately does not have. The bundle currently carries version, resource
summary, config status and counts.

The *absence of content* is verified rather than assumed: the runtime test seeds
a conversation with distinctive text, builds a bundle, and confirms the text is
absent **and that the bundle is non-empty** — an empty bundle would satisfy the
first check while proving nothing.

**The support gateway is a contract with nothing behind it.** M115 by design: no
URL ships, no credential exists, and with none configured nothing is
transmitted. Verified by the ticket staying in `draft`.

**Telemetry has never reached an endpoint.** The sender is injected; no real
transmission has occurred, and no endpoint ships.

**Restore does not verify the archive came from this installation.** The
`wrong_installation` error category exists and nothing sets it. Restoring another
installation's backup would apply it.

**Backup retention and scheduling do not exist.** Backups are taken on request
and never expire. Nothing prunes `/data/backups`.

## Assertions that were passing for the wrong reason

Recorded because the pattern is now the most common defect in this project, and
four more instances appeared in this phase alone.

- **Four runtime assertions passed on empty strings.** "The plaintext credential
  is NOT in the backup" passed because `gzip` could not read a backup that was
  never written — an unreadable archive also lacks the plaintext. "The ciphertext
  came back byte-identical" compared two empty strings. Both now require the
  value to be present before comparing, and the script exits rather than
  reporting green for everything downstream.
- **`/api/admin/llm/providers` is not a route**, so "the app reads its restored
  tables" was exercising the 404 handler.
- **Four mutations survived because a second control masked the first.**
  Telemetry's `enabled` check was masked by having no endpoint stored; the
  acknowledgement check by the database constraint that refuses the same update;
  the endpoint-clearing by a test that omitted the argument. The restore
  confirmation had no wire test at all.
- **Filename sanitising was masked by the leading-dot check** — every fixture
  began with a dot. Writing one that did not *failed on unmutated code*:
  stripping separators from `nightly/../../etc/passwd.zip` leaves a dot run that
  trips the traversal constraint, so a bad filename produced a database error
  rather than a clean refusal.

The reliable smell: **when every fixture in a loop shares a shape, the loop is
probably exercising one guard rather than the one it is named after.**
