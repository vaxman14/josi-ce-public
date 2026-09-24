# Phase 9 — Documents and Storage: what is proven, and what is not

The plan calls this the largest and highest-risk phase, and names why: extraction,
OCR and watching all touch untrusted bytes. That is true, but it is the second
risk. The first is simpler and worse.

**A document mapping is a standing grant to read a folder** that may hold
contracts, medical records, or a lawyer's privileged files. Getting the *grant*
wrong matters more than getting the parser wrong, because a bad parser crashes
and a bad grant quietly works. So Phase 9 was built in four cycles, and the first
one was entirely about the grant.

| Cycle | What it covers | Decisions |
|---|---|---|
| 9a | Allowlisted roots, the dual gate, read-only start, purge on unmap | M45–M50, M54, M68, M70–71 |
| 9b | Untrusted bytes: limits, encrypted files, bounded archives, ClamAV | M55–59, M64–65, M74 |
| 9c | Search: FTS by default, semantic opt-in, OCR queue, citations, pause | M51–53, M67, M71, M75 |
| 9d | History, sharing controls, sync, audit retention | M60–62, M69, M72–73, M76–79 |

## Evidence

| | |
|---|---|
| Tests | **734 passed** across 26 files |
| Mutation testing | **97 of 97 caught** (`scripts/mutate-phase9.sh`) |
| Runtime on a Linux test host | **94 checks, 0 failed** — real PostgreSQL, real symlinks |
| Secret scan | clean, 213 files |
| Host impact | 25 containers before, 25 after, no leftovers |

## The controls that carry the most weight

### Containment (M45)

Every filesystem access goes through `resolveWithin`. It normalises, checks
structurally against the root, resolves symlinks, and **checks again** — because
a check performed before symlink resolution is a check on the wrong string.

Tested against a real filesystem with real symlinks, not string handling:

- a link inside the folder pointing at `/etc`
- a link pointing at a sibling directory
- **`docs-private` vs `docs`** — the sibling whose name is a prefix of the mapped
  one, which is exactly where the common `startsWith` answer fails
- a not-yet-existing file under an escaping link, which is how a *write* escapes
- NUL bytes, `..` in every spelling, absolute paths, drive letters

The same rules are applied to paths that arrive from inside a ZIP, because an
archive is precisely where a path comes from somewhere untrusted.

### The dual gate is asymmetric (M47)

The administrator decides whether a person **may** map folders. The person
decides **which** folder. The administrator cannot do the second half — there is
no admin route that reaches `createMapping`, and the owner is always the session,
never the request body.

This is the control that matters most in the whole phase. An administrator who
could create a mapping on someone's behalf could read their files by filling in a
form — and because Josi indexes what it maps, those files would then sit in a
search index the same administrator runs.

### Every file is guilty until checked (M55, M57, M64, M65)

One ordered chain, cheapest and most certain first: quota → size → extension →
archive → encryption → malware.

The order is load-bearing in two places. **Encryption is checked before malware**,
because a scanner cannot see inside an encrypted file and a clean verdict on one
would mean nothing. **Quota is checked before size**, because "you are out of
space" is actionable and "that file is too big" sends someone to shrink a file
that was never going to fit.

Extensions come from the **last** dot: `report.pdf.exe` is an exe.

### Zip bombs are bounded on expansion (M65)

Not on the archive's own size — that is what makes a bomb a bomb. Entry count,
expanded bytes, recursion depth, and wall-clock time, and **the running total is
checked before an entry is accepted, not after**. Checking after exceeds the
bound by one entry every time, and one entry is all a bomb needs.

### A malware finding blocks and does not touch the source (M57)

The source hash is taken **before and after** the scan, so "we did not modify it"
is a measured fact rather than a claim about code that could later change. There
is also a test asserting `ingest.ts` contains no `unlink`, `rename`, `writeFile`,
`copyFile` or `truncate`.

This is deliberate and it is not timidity: antivirus false positives on ordinary
business documents are common, and a system that quarantines or deletes on a
false positive has destroyed data it was trusted with. **Blocking is reversible.
Deleting is not.**

A scanner that is enabled but **unreachable stops processing** rather than
continuing unscanned — an outage that silently disables scanning is worse than no
scanner, because the operator believes files are being checked.

### Full-text search by default; semantic is opt-in and refusable (M51)

FTS runs entirely inside PostgreSQL: no model, no network, nothing leaves the
host. Semantic search answers some questions better and requires sending the text
of somebody's documents to an embedding service.

Three gates, in order: **Local-only** (installation-wide), then the administrator's
switch, then the individual's consent. Local-only comes first because no
individual's consent can override an installation-wide promise — a person cannot
agree to send data out of an installation whose operator has declared that nothing
does. Consent cannot even be *recorded* in Local-only.

Search is owner-scoped **by construction**: the owner is a required argument, not
a filter a caller might omit, and there is no request parameter that could widen
it. Asserted from both sides and with attempts to widen it over the wire.

### Citations survive revocation without rewriting history (M71)

Citations resolve at **display** time. Revoking access makes a citation unopenable
on a message sent months ago without editing a single word of what was said —
because silently rewriting someone's message history to match today's permissions
is its own kind of dishonesty. The citation still names the file; it just stops
offering to open it.

### History is off, and defaults to the harmless kind (M60–M62)

`history_mode` defaults to `disabled` and `history_kind` defaults to `snapshot`,
so an administrator who enables history without reading the wording gets records
that a version existed — not copies of everyone's files.

The disclosure is **generated from the settings**, so the wording cannot drift
from the behaviour. It says plainly, as M62 requires, that recovery copies are
**not encrypted by Josi** and are protected only by the server's disk.

The database refuses to store a recovery copy anywhere except `/data/versions/`,
so a bug in the caller cannot write a copy of someone's document into a folder
they share with colleagues.

### The recycle bin is for vanishing, not for revoking (M79)

When a source file disappears while the mapping is still authorised, a recovery
copy waits in the bin for the administrator's window. When permission is
**withdrawn**, everything goes immediately. Treating those the same would mean
revoking access left copies of the documents on the server for up to 90 days.

## What runtime verification actually did

A real folder tree with **real symlinks**, built inside the container: a link
pointing at Josi's own volume, a link pointing at `/etc`, and a sibling directory
whose name is a prefix of the mapped root. Then PostgreSQL's own generated
`tsvector` columns and `websearch_to_tsquery` — neither of which pglite is
guaranteed to agree with — and the append-only trigger, exercised against the
real database rather than a shim.

Nothing left the host: no provider, no scanner, no model.

**It took five runs, and each failure was worth having.**

1. **`npm ci` failed on a clean host.** `package-lock.json` had never learned
   about `packages/storage`. The Phase 4 packaging test asserted the Dockerfile
   `COPY` lines and said nothing about the lockfile — two independent things must
   be true for a clean build and only one was tested.
2. **The compose file had no `/data` mount at all** — nowhere to bind a shared
   folder, nowhere for a recovery copy to live. Phase 9 mapping was unusable as
   shipped, and 734 unit tests passed because none of them mount anything.
3. **`psql -tAc` prints the `INSERT 0 1` command tag** alongside the `RETURNING`
   value, so every id was two lines and every JSON body built from one was
   malformed. The body parser answered 400 — and four containment assertions read
   that 400 as the refusal they were testing for. They reported PASS while the
   server had never evaluated the path.
4. **The teardown deleted the file it needed to tear down with.** `COMPOSE` names
   the override with `-f`, and cleanup removed it before running `compose down`,
   so the stack stayed up between runs.
5. **Three assertions that could not explain themselves.** Two grepped for a
   substring and discarded the output; one compared a boolean against `f` when
   `boolean || text` renders `false`. A DELETE matching nothing raises nothing,
   so two of them would have passed had their fixture rows been missing — and one
   did.

## A conflict worth recording

**Phase 1's append-only trigger refused Phase 9's retention sweep.** M73 requires
audit entries to be deleted after a configurable window; Phase 1 made `events`
append-only with a trigger that refuses every UPDATE and DELETE. The guard was
working exactly as designed, and it surfaced the conflict.

The wrong fix would have been a bypass flag or a privileged role, because either
becomes a way to erase an audit trail. Instead the trigger now permits deleting
**only rows already older than the configured window**, and nothing else.
Everything current stays exactly as append-only as it was, and under `forever`
nothing qualifies, so nothing can be deleted at all. There are tests for each of
those three cases.

## Proven

| Claim | How | Where |
|---|---|---|
| A path never leaves the mapped folder | Real symlinks, sibling prefixes, NUL bytes, traversal in every spelling | unit, wire |
| A root cannot be registered outside the bind-mount base | `registerRoot`, structural containment | unit |
| Mapping is refused until an administrator enables it | 403, nothing created | unit, wire |
| Local and cloud are separate grants, and the refusal leaks neither | Identical message | unit |
| An administrator cannot map a folder for someone else | No admin route; owner from session | wire |
| A mapping starts read-only, unindexed, non-recursive | Both the code path and the schema defaults | unit, wire |
| A read-only root cannot be made writable | Operator's ceiling is a ceiling | unit |
| Indexing is a separate consent, and revoking it purges immediately | Counted per artefact type | unit, wire |
| An administrator revoking `may_index` purges what was indexed | Purge count returned | wire |
| A colleague cannot see, change, unmap or share-on | 404 throughout; share needs `owner` | wire |
| The administrator's views contain no path or filename | Asserted absent from every admin response and the audit log | wire |
| Size, extension, quota and per-user ceilings are enforced, tightening only | Gate chain | unit |
| Encrypted documents are skipped, never opened, password never requested | ZIP flag bit, OLE, PDF `/Encrypt` | unit |
| Archives are excluded by default and bounded when enabled | Entry, size, depth, time, path, encrypted entry | unit |
| A zip bomb is stopped before the bound is exceeded | `bytesExpanded` never passes the ceiling | unit |
| A malware finding blocks and leaves the file byte-identical | Hash before/after; no write verbs in the module | unit |
| An unreachable scanner stops processing | Throws `ScanBlocked` | unit |
| Search never crosses owners | Asserted from both sides, and against widening parameters | unit, wire |
| Semantic search is refused in Local-only regardless of consent | Both `assert` and `record` paths | unit, wire |
| Citations become unopenable on revocation without rewriting messages | Message body asserted unchanged | unit |
| OCR is off, admin-only, throttled, hour-restricted, un-overridable | Including a midnight-crossing window; no per-user column exists | unit |
| The global pause stops new work and search still answers | Asserted directly | unit, wire |
| History is off by default and defaults to snapshots | Schema defaults | unit |
| Recovery copies cannot be written outside `/data/versions` | Database constraint | unit |
| Sync now is rate-limited and cannot bypass the pause | 429 with `Retry-After` | unit, wire |
| An expired token pauses; a rate limit does not | M78 | unit |
| Audit retention deletes only past the window; `forever` deletes nothing | Trigger-level | unit |

## Not proven

**No real file was ever parsed.** There is no PDF, DOCX or XLSX extractor in this
phase — `document_text` and `document_segments` are populated by tests, not by a
parser. The *gates* around extraction are built and tested; **extraction itself is
not implemented**. Every claim above about what happens to a file's text is a
claim about the pipeline, not about reading a real PDF.

**OCR is not implemented.** The queue, the throttle, the hour window and the
admin-only switch are real and tested. Nothing calls Tesseract. M52 says OCR is
"bundled in the images" — it is not yet in the Dockerfile.

**ClamAV is an interface, not a deployment.** `Scanner` is injected, and the
scan-mode logic, the blocking behaviour and the unreachable case are tested
against stubs. **No ClamAV container ships in the compose file**, no real
signature was ever matched, and `clamav_status` is never written by anything.
M58's definition-update reporting has a table and no updater.

**No cloud provider was contacted.** Drive and OneDrive mappings can be created
and are correctly bound to the owner's own connection, but nothing lists, reads
or syncs a remote folder. `sync_state` is written by the manual-sync route and by
failure recording; there is no scheduler. M76's 5/15/30/60-minute cadence is a
stored setting with nothing reading it.

**No filesystem watching.** M76's local watch does not exist.

**Semantic search has no embedding provider.** The consent, the disclosure, the
Local-only prohibition and the vector round-trip are tested. Nothing generates an
embedding, and `cosine` is never called against real vectors.

**Recovery copies are never written.** `document_versions` records where a copy
*would* live and the database refuses bad locations, but no bytes are copied and
`runRecycleBin` returns paths nobody unlinks.

**No shared folder is mounted by default, by design.** M45 is deny-by-default at
the mount layer too, so an operator must edit compose before Josi can see
anything. That is correct, and it means a fresh install has nothing to map until
they do.

**The web UI has no storage screens.** There is no way for a person to map a
folder, give consent, or see why a file was skipped except through the API.

## What this means in practice

Phase 9 delivers the **security spine** of documents and storage completely: the
grant, the isolation, the gates, the purge, the disclosures, and the search
scoping. What it does not deliver is the **machinery that touches real bytes** —
parsers, OCR, a deployed scanner, cloud sync, watching, and embedding.

That split is deliberate and worth stating plainly: the controls are in place and
proven before anything is wired to them, which is the right order for the phase
the plan calls highest-risk. But an installation running this code today can map
a folder and search nothing, because nothing fills the index.
