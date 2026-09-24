# Phase 8 — Operational Email: what is proven, and what is not

Phase 8 lets Josi send mail on a person's behalf through one installation
mailbox, and lets replies find their way back to that person. The whole phase is
shaped by a single failure mode named in the plan: **an unowned shared inbox
forming**. One central mailbox plus no ownership rule equals a pile of
correspondence belonging to everybody, and the first person to open the admin
screen is reading their colleagues' mail.

So there are exactly two outcomes for an inbound message — it resolves to a
thread, which always has an owner, or it is quarantined with a reason. There is
deliberately no third state and no "unassigned" bucket to drift into.

## Evidence

| | |
|---|---|
| Unit and integration tests | **522 passed** across 19 files |
| Mutation testing | **31 of 31 caught** (`scripts/mutate-phase8.sh`) |
| Runtime on a Linux test host | **62 checks, 0 failed** — real PostgreSQL, real SMTP |
| Secret scan | clean, 187 files |
| Host impact | 25 containers before, 25 after, no leftovers |

## What runtime verification actually did

A **real SMTP server** (`aiosmtpd`) runs on the project's own Docker network and
keeps every message it receives. That matters more than a stub would: it means
nodemailer's real EHLO/AUTH/DATA path runs, and the test can then **read the
bytes that would have gone out** rather than trusting what the application says
it sent.

**No mail leaves the host.** The sink accepts everything and writes it to a file
inside its own container. Nothing is addressed to a real domain, no credentials
exist, and the container is removed at the end.

What was read off the wire:

- `From:` is `Alice Smith via Josi <josi@example.test>` — her name, the
  installation's mailbox. **Her own address is not the sender.** Putting it there
  would be a forgery that SPF and DMARC would correctly reject (M35).
- `Reply-To:` carries the plus-addressed routing token, which is what makes a
  reply come back to this thread and this person.
- The AI disclosure is in the body (M41).
- `Auto-Submitted` and `X-Josi-Thread` are set — loop prevention.
- **No `Bcc` header.**

## Proven

| Claim | How | Where |
|---|---|---|
| Mail is sent under the person's name from the installation mailbox, never from their own address | Read off the wire from a real SMTP server | runtime |
| A reply routes back to one thread and one owner | Unguessable random token in Reply-To; `routingTokenFrom` returns null rather than guessing | unit, runtime |
| Every message discloses that Josi wrote it | `applyDisclosure` throws below 10 chars; a database check constraint too; blanking it via the API is refused (400) | unit, mutation M1–M3/M26, runtime |
| Rewording the disclosure is allowed | Admin policy PUT accepted, database still holds a real one | runtime |
| The same message is never sent twice | Partial unique index on `(thread_id, content_hash)`; a repeat send delivered nothing new | unit, mutation M12–M13, runtime |
| Adding a recipient needs the initiator's approval | 409 `needs_approval`, nothing delivered; goes through once approved | unit, mutation M9, runtime |
| An approval is pinned to one exact message | `payload_hash` compared against the canonical form; a different message is refused | unit, mutation M10–M11 |
| The approval states how much history a new recipient will see | `history_from`, surfaced in the approval text | unit, runtime |
| BCC is refused outright | 409 | unit, mutation M6, runtime |
| A colleague cannot reach another member's thread | 404, not 403, on GET and DELETE; absent from their list | unit, mutation M37, runtime |
| A share is the only way in, and the owner alone can grant it | Share/unshare routes require `owner`; the admin gets 404 trying to share her thread | unit, mutation M28, runtime |
| A share is read-only unless the owner says otherwise | A read-only share reads (200) and cannot send (404) | unit, mutation M29, runtime |
| Access does not compound | A colleague with **write** access is refused when sharing onward, and no share row appears | unit, mutation M28, runtime |
| Revoking works | After unshare the colleague is back to 404 | unit, mutation M30, runtime |
| The super admin sees delivery metadata and no content | `email_sends` has no subject or body column at all; the admin view joins only it and `users`; the admin gets 404 on the thread itself | unit, mutation M25, runtime |
| Deleting is recoverable | Trash window, row still present and marked deleted, restore works | unit, mutation M21–M22, runtime |
| Retention warns before it deletes | `retentionNotice` | unit, mutation M24 |
| Address strings cannot carry a second header | `assertSafeAddress` rejects CRLF and `<>,;` | unit, mutation M5 |
| The SMTP server's own words never reach the caller or the log | A 550 carrying a body fragment and a 535 carrying a password both surface as a category only | unit (`smtp.test.ts`), mutation M14 |
| No subject, body, or recipient reaches the audit log or any container log | Queried `events`; grepped every container log | runtime |
| Inbound resolves to an owner or is quarantined, with no third outcome | Return type has exactly two shapes | unit, mutation M15 |
| Quarantine keeps headers only | Table has `subject_length`/`body_length`, no content columns | unit, mutation M17 |
| Automated mail is not answered automatically | `looksAutomated` plus a per-thread budget of 5 in 10 minutes | unit, mutation M18–M19 |

## Not proven

**Nothing was verified against a real mail provider.** No message was delivered
to Gmail, Microsoft 365, or any real MX. Deliverability — whether these headers
actually survive a production spam filter, whether the plus-addressed Reply-To
survives every relay, whether "via Josi" trips any reputation system — is
**unverified**, and it is the largest open risk in this phase.

**SPF, DKIM, and DMARC are the operator's to configure.** The From/Reply-To
design is what makes correct alignment *possible*; it does not make it *true*.
An installation with no SPF record will send mail that lands in spam, and
nothing here detects that.

**TLS to the mail server is untested at runtime.** The sink speaks plaintext on
the project network. `smtp.ts` handles `starttls`/`tls`, and `classifySmtpError`
is unit-tested, but no real certificate negotiation happened.

**Inbound was exercised through the ingest function, not through a real MX.**
There is no mail receiver in CE 0.1 — no LMTP socket, no IMAP poller. Something
must call `ingestInbound`. Until Phase 9 supplies it, inbound is proven as a
function and unproven as a pipeline.

**Attachments are metadata only.** There is nowhere for an attachment to come
from in 0.1; the table exists so the approval preview can name a file before
Phase 9 can supply one. The approval path (M8/M44) is tested; actually attaching
bytes is not implemented.

**Loop prevention is proven against the cases it recognises.** The header
conventions catch well-behaved automata and the rate budget catches the rest
eventually. A hostile correspondent deliberately constructing a loop with no
recognisable headers would still get 5 replies per 10-minute window.

**Retention has not been observed over real time.** `runRetention` is tested by
back-dating rows, not by waiting 30 days.

## Four defects worth recording

**The double-hash.** The route passed a message *fingerprint* as an approval
payload, and `requestApproval` hashes whatever it is given — so the stored hash
was a hash-of-a-hash and could never match. Every attachment and new-recipient
send would have been impossible in production. The unit test missed it because
it built approval rows by hand with a pre-computed hash, bypassing the path
production uses; the wire test caught it. Both now go through `requestApproval`,
and one canonical form (`messagePayload`) feeds both the dedupe hash and the
approval payload so they cannot drift again.

**The untested transport.** Mutation M14 — "let the SMTP server's own words
reach the caller" — was not caught. Every test injected a stub transport, so
`smtpTransport`, the function production actually uses, was never called by
anything and its error sanitising was unprotected. That is the worst place for
it: **a bounce quotes the message that bounced**, so an SMTP error string can
carry a subject, a body, or a recipient list straight into an API response.
The transporter is now injectable, matching the `fetchImpl` pattern used in the
LLM and connector packages, so the test exercises the real function.

**M37 was half built.** The ownership spine has honoured `resource_shares`
since Phase 1 and every mail route asks it — but nothing reachable over HTTP
could ever *create* one. "Threads are visible only to the owner unless shared"
was therefore true in the least useful sense: sharing was impossible. Found by
reading the decision map against the code rather than by any test, because a
test for a feature that does not exist does not fail.

The half that was missing is now there, and it is deliberately stricter than
"can write": sharing requires **ownership**, so a colleague trusted to help with
a conversation cannot decide who else reads it. The `authz` guard gained an
`owner` level backed by core's own `canShare`, keeping one decision point.

**A fourth, in the test harness itself.** The first runtime run reported "the
sink never came up" while the sink was up and taking mail — the probe used `nc`,
which the hardened app image does not carry. A check that fails when the thing
works proves nothing; it now probes with node from inside the web container, so
what it establishes is that the app can reach the sink.
