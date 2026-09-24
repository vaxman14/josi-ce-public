# Decision traceability — canonical map → implementation

Source of truth: the product decisions captured in this document.

Every CE-relevant decision in that file appears here with its own row. IDs are
`M<line>` referring to the line in the canonical map, so any row can be checked
against the original wording. Nothing is collapsed into a generic TODO.

**Status values**
- `Done` — implemented and covered by a named test
- `Phase N` — accepted, scheduled, not yet built
- `Deferred` — deliberately out of 0.1, with a reason
- `Excluded` — a decision that resolves to "do not build this"
- `N/A` — the decision is not about CE

Status accuracy matters more than a full column of ticks. A row that says
`Phase 9` is a promise, not an achievement.

---

## A. Identity, licensing, branding

| ID | Decision | Status | Where |
|---|---|---|---|
| M7–M10 | **Superseded at launch (LB11).** Official Josi identity is now the **white `J` on navy**; the wordmark (white "Josi", tennis-ball dot on the `i`) is unchanged and is the approved master. *Historical:* M7–M10 originally specified an orange/gold shepherd on navy with the `J` as a facial blaze. The shepherd concept is retired. | Phase 0/6, revised LB11 | The wordmark is the master and is never regenerated. The mark is cut from it by `scripts/build-brand.sh` so the two letterforms cannot drift. Test: the mark is derived from the wordmark, and no asset is the retired shepherd. |
| M8 | **Superseded at launch (LB11).** Product line is "Your assistant, on your own server." *Historical:* was "Josi. Fetching what's next.", retired with the shepherd concept it punned on. | Phase 6, revised LB11 | `README` + the sign-in screen. |
| M26 | Branding is Josi throughout; not "powered by SoCal"; SOCAL RECEPTIONIST LLC is named creator/publisher; **CTF Designs must never be presented as creator**. | Phase 0 | `NOTICE`, `README`, app footer. Test: `scan-secrets.sh` also greps for `CTF Designs` appearing as creator. |
| M81 | License is **AGPL**; separate trademark terms. **Revised at launch (LB11): the "not replaceable by self-hosters" condition is withdrawn.** It purported to restrict what the AGPL grants — modification, which includes the branding assets — and AGPL §7 makes such a further restriction removable anyway. It also inverted trademark law, which asks a fork to *stop* using our mark rather than to keep it. What remains is the enforceable part: do not use the Josi name or marks to present a modified version as ours. | Phase 0, revised LB11 | `LICENSE` (AGPL-3.0), `TRADEMARK.md`, `NOTICE`, and `README` state the same licensing and trademark boundary. |
| M25 | One workspace per installation; multi-workspace requires contacting SOCAL RECEPTIONIST LLC for white-label or hosted. | Phase 1 | `workspace` singleton table; `README` states the boundary. |
| M95 | Release label **Josi CE 0.1 — Community Preview**. | Phase 0 | `package.json` version + `README` title. |

## B. Scope boundaries

| ID | Decision | Status | Where |
|---|---|---|---|
| M27 | No SoCal secrets, tenant data, or infrastructure credentials may ship. | Done | `.gitignore`, `scripts/scan-secrets.sh`. Test: fixture containing a SoCal number fails the scan. |
| M66 | Audio/video transcription and media indexing explicitly **out of scope** for the first release. | Excluded | Not built; `README` says so plainly. |
| M92 | CE includes **no support entitlement**; paid support pricing/package deliberately deferred. | Deferred | Reason: support is not going live and does not block CE. `README` states no SLA. |
| M93 | Initial commercial market is SMB only; do not design or market enterprise features. | Excluded | No enterprise/fleet/white-label surface exists in CE. |
| M94 | Publish CE while the hosted product is incomplete; treat feedback as product evidence, not obligation. | N/A | Release-strategy decision, no code. |
| M101 | Companion apps labelled **Coming soon**; no fake download/install actions before a real build exists. | Phase 6 | Apps page renders disabled entries. Test: no enabled download control present. |
| M123 | Future app discovery is email-first. Super admin allowlists an email; CE registers only an opaque email-to-instance route with the Josi directory; credentials authenticate directly against the discovered CE HTTPS endpoint; paired devices cache the endpoint and survive directory outages; device sessions are individually revocable; manual URL is Advanced only. | Deferred | Applies when companion apps ship. Security tests must prove the directory cannot observe passwords/content, duplicate local usernames across instances do not collide, unapproved emails cannot pair, endpoint responses are authenticated, and existing paired devices operate while the directory is unavailable. |
| M4 | Josi mobile releases built **locally only**; no Expo/EAS cloud builds or OTA. | N/A (0.1) | No app binaries in CE 0.1. Recorded so it binds when apps ship. |
| M13–M14 | Native workspace parity (all tenant pages on mobile). | Deferred | Applies to the companion apps, which are Coming soon in 0.1. |
| M117–M122 | Logo redesign paused; "pin it all until I get home". | Superseded | M7–M10 locked the identity on the same date; this prompt explicitly authorises CE work. |
| M24 | "Mapping only; do not create the repo until Roman explicitly authorises." | Superseded | This prompt is that authorisation. |

## C. Users, roles, authorisation

| ID | Decision | Status | Where |
|---|---|---|---|
| M96 | One workspace, **multiple users**, no artificial seat cap; real limits depend on hardware; document plainly. | Phase 1 | No seat check anywhere. `README` capacity section. |
| M97 | Capacity tiers must come from **real benchmarks**, not estimates; test Pi-class ARM64, old x86-64, modern mini-PC; document workload. | Deferred | Reason: no benchmark hardware run yet. **CE must publish no capacity numbers until then.** Enforced by review, not code. |
| M30 | Each user controls their own connected accounts. Owners may see connection **health** and revoke, but must not browse that user's email or calendar content. | Phase 7 | `requireOwnerOrShared()`; admin DTOs metadata-only. Test: admin connection view contains no message fields. |
| M31 | Connected accounts start **read-only**; write capabilities separately enabled; destructive stays approval-gated. Admin policy is **deny-only** — may disable, never grant what the user has not consented to. A capability works only when user grants **and** admin allows. | Phase 7 | `effectiveCapability = min(userGrant, adminPolicy)`. Test: truth table incl. admin-cannot-grant. |
| M33 | Per write action: **Always ask** / **Ask only for risky** / **Allow routine automatically**; default Always ask; admin may force stricter, never looser. | Phase 7 | Approval-level resolver. Test: admin loosening refused. |
| M47 | Storage access dual-gated: admin approves mapping capability **and** user consents; admin may tighten, not grant. | Phase 9 | Same resolver as M31. |
| M48 | Folder-mapping approval exposes only provider, folder name/path, requester, requested permissions — **no browsing/preview/search/read**. | **Done (Phase 9)** | There is no folder-mapping approval route at all, because there is no admin path into mapping. The admin sees capabilities, counts and policy; never a path. |
| M68 | Every mapped folder and its index is **private to the owning user**; workspace membership alone never grants access. | **Done (Phase 9)** | Mappings and search are owner-scoped; search takes the owner as an argument, not a filter. 404 for colleagues and the administrator alike. |
| M69 | Admin may disable sharing entirely and separately forbid workspace-wide "Share with everyone"; ordinary shares need no per-share admin approval. | **Done (Phase 9)** | Sharing can be switched off entirely, and workspace-wide sharing can be forbidden separately. No per-share admin approval, because approving a share means seeing what is shared. |
| M70 | Removing a user purges their private unshared mappings/derived data; shared ones require explicit transfer or purge — **never ownerless**. | **Done (Phase 9)** | Private mappings cascade with the user; shared ones are listed for a human to transfer or purge, with the instruction spelled out. |

## D. LLM

| ID | Decision | Status | Where |
|---|---|---|---|
| M82 | Launch families: OpenAI, Anthropic/Claude, xAI/Grok, self-hosted. | Phase 4 | Provider registry. |
| M84 | Self-hosted via generic **OpenAI-compatible** endpoint: base URL, optional key, model name (Ollama, vLLM, LM Studio, LocalAI). | **Done (Phase 4)** | One adapter serves openai/xai/openai_compatible. Endpoint guard allows loopback and LAN and blocks cloud metadata — a documented departure from the plan's wording, argued in `PHASE_4_EVIDENCE.md`. Runtime: a stub runtime on the container network was configured, probed and used. |
| M85 | One primary + one **optional, explicitly enabled** fallback; used only when primary unavailable/rate-limited; warns about cost and second provider. | **Done (Phase 4)** | Three conditions, all required: exists, activated, and the failure was retryable. Test: not used for a bad key (mutation M4 fails the suite). |
| M86 | Probe chat, structured output, tool calling, usable context before activation; unsupported → clear warnings and **disable dependent features**, never pretend. | **Done (Phase 4)** | Four ordered steps, chat fatal, structured output judged by parsing the reply. Null capability = unknown = off. A DB check constraint makes active-but-unprobed unrepresentable. Mutations M6-M9 all fail the suite. |
| M87 | Installation-wide monthly cost/token caps + optional per-user; warn at 50/80/100%; **hard stop** after 100% until raised. | **Done (Phase 4)** | Worst-of-workspace-and-user governs; checked before the call, so a blocked call never reaches a provider. The probe is exempt so a broken model can still be replaced. Runtime: blocked in real PostgreSQL. |
| M88 | Usage distinguishes exact provider-reported charges from **labelled estimates**; self-hosted reports tokens/latency with `$0 provider charge` and states hardware/electricity excluded. | **Done (Phase 4)** | Three sources — reported / estimated / none — never blended; there is no `totalCostUsd` field, and a DB constraint rejects a self-hosted row claiming a cost. Unknown price counts tokens and says so rather than under-counting. |
| M89 | Enabling an external provider requires an explicit acknowledgment that data leaves the server; CE must not imply self-hosting keeps everything local. | **Done (Phase 3)** | Wizard refuses an external provider without it; stored with a timestamp, and a DB check constraint makes an unacknowledged external row unrepresentable. Test: 6 falsy/coerced variants all rejected; mutation M7 fails the suite. |
| M90 | Hard **Local-only mode**: only self-hosted endpoints, no external fallback, blocks features that would send content externally, persistent visible badge. | **Done (Phase 4)** | Enforced in `buildProvider`, so the fallback path cannot smuggle a hosted provider in either. Runtime: 409, nothing written, key not stored. Badge is Phase 6. |
| M91 | No bundled model weights or inference runtime; connect to a separately managed service. | Phase 2 | Compose ships no model runtime. |
| M83 | Subscription-based OpenAI/Claude connection **only if** an officially supported path permits third-party self-hosted use. Never scrape sessions, reuse Claude Code/Codex credentials, or imply subscriptions include API usage. UI must distinguish API billing from subscription access and **auto-hide/disable when no compliant path exists**. | **Done (Phase 4)** | Three options listed, all `available: false`, with the reason stated rather than "coming soon". Naming one as a provider is refused with 400. No subscription auth code path exists to reach. |

## E. Mail

| ID | Decision | Status | Where |
|---|---|---|---|
| M34 | Two super-admin SMTP profiles: **System mail** (welcome/verify/invite/reset/security) and **Josi communications** (user-authorised operational mail). Separate servers/identities, or a **copy-from-system** option adjusting only sender address/name. Ordinary users cannot configure installation SMTP. | **Capture done (Phase 3)**; delivery Phase 8 | `smtp_profiles`, one row per kind by unique index. Copy-from-system stores its own sender identity and NO credential, so the password exists once. Passwords sealed. `verified_at` stays null — nothing has been sent. |
| M35 | Operational mail uses the initiating user's identity in display/reply ("Roman via Josi") while sending through the central profile; replies route back to that user's conversation, **not** a shared inbox. | **Done (Phase 8)** | `operationalSender`. The person's own address is never the From — that would be a forgery SPF/DMARC rejects. Verified by reading the header off a real SMTP server. |
| M36 | Inbound via IMAP/provider API, super-admin allow/deny. The setting governs **availability**, not permission to read users' mail. | **Partly done (Phase 8)** | `inbound_enabled` gates `ingestInbound`; no admin route reads a thread. **No receiver exists yet** — something must call it. Phase 9. |
| M37 | Threads visible only to the initiating user by default; another user only after explicit share/assign; neither membership nor super-admin status grants content access. | **Done (Phase 8)** | **404, not 403** — 403 confirms the thread exists, which is the fact privacy protects. Share/unshare routes require `owner`, so write access cannot be passed onward. Read-only by default. |
| M38 | Admin may see delivery **metadata** — initiating user, recipient, timestamp, state, sanitized error category — never subjects, bodies, attachments, replies. | **Done (Phase 8)** | Enforced by shape, not discipline: `email_sends` has no subject or body column, so widening the SELECT cannot leak content. |
| M39 | Threads retained until the owner deletes them; admin may set a workspace maximum retention (e.g. 30d/1y/7y) with clear warning before automatic deletion. | **Done (Phase 8)** | `retentionNotice` warns before `runRetention` acts. Tested by back-dating rows, not by waiting. |
| M40 | User-deleted threads → recoverable trash **30 days** default; admin may shorten or make immediate. | **Done (Phase 8)** | `trash_days`, 0 = immediate. Delete marks `deleted_at`; restore works. |
| M41 | Josi mail must disclose AI authorship ("Sent by Josi, AI assistant for Roman"); wording customisable, **not removable**, must not imply human authorship. | **Done (Phase 8)** | Three independent guards: `applyDisclosure` throws, the API refuses (400), and a database check constraint holds — a policy row is editable by anything with database access. |
| M42 | Operational, not marketing: legitimate multi-person threads, group scheduling, CC and group addressing allowed; **no BCC blasting or list outreach**. | **Done (Phase 8)** | BCC refused outright (409); `max_recipients` capped at 50. |
| M43 | Adding a recipient to an existing thread **always** requires the initiator's approval, showing who the newcomer is and exactly how much history will be exposed. | **Done (Phase 8)** | `history_from`. The approval is decided **before** any preference is read, so no setting can skip it. Pinned to one exact message by `payload_hash`. |
| M44 | Sending **any** attachment always requires explicit approval with a preview of the exact file, recipients and message — even when routine sending is automatic. | **Partly done (Phase 8)** | The approval path is built and tested. **Attachments are metadata only** — nothing in 0.1 can supply bytes until Phase 9 maps a folder. |

## F. Storage, documents, indexing

| ID | Decision | Status | Where |
|---|---|---|---|
| M45 | Local access deny-by-default, limited to preapproved folders via named bind mounts/volumes; **no general host or home access**; setup maps each path to a label/purpose. | **Done (Phase 9)** | Two independent gates: the bind mount decides what the CONTAINER sees, `storage_roots` decides what the APPLICATION touches. `registerRoot` is not reachable over HTTP. Containment is structural, symlink-resolved, and re-checked after resolution. |
| M46 | Drive and OneDrive permitted; Box/Dropbox later. Not account-wide — each user maps individual folders. Prominent warning about proprietary/secret/privileged/regulated material and LLM processing. | **Partly done (Phase 9)** | Per-folder mappings bound to the owner's own connection; there is no map-my-whole-Drive. **No provider is contacted** — nothing lists, reads or syncs a remote folder yet. |
| M47 | Every mapped folder starts read-only; create/edit/move/delete separately granted; **delete always requires approval**. | Phase 9 | See §C M47. |
| M49 | Mapping ≠ indexing. Indexing is a separate choice with an LLM-processing warning. Both support **This folder and all subfolders**, shown plainly in user consent and admin approval. | **Done (Phase 9)** | `indexing_enabled` is separate from the mapping, needs its own capability, and revoking it purges. The consent text names the language model explicitly. |
| M50 | Recursive scope automatically covers **subfolders created later**; UI must state the continuing scope, not imply current children only. | **Done (Phase 9)** | `consentText` states that a recursive scope covers subfolders added **in future**; mutation-tested, because the wording is the control. |
| M51 | Postgres **full-text search by default**; semantic/vector optional; external embeddings must disclose that text leaves the server; **Local-only forbids it**. | **Partly done (Phase 9)** | FTS by default, entirely in PostgreSQL. Semantic gated by Local-only → admin switch → individual consent, in that order. **No embedding provider is wired.** |
| M52 | OCR bundled in the images, **disabled by default**, super-admin only; warn about CPU/memory/time especially on Pi-class hardware; users cannot override. | **Partly done (Phase 9)** | Off by default, super-admin only, no per-user override column exists. **Nothing calls Tesseract and OCR is not yet in the image.** |
| M53 | When enabled, eligible files processed by a **throttled background queue**; admin controls concurrency/resource limits and may restrict to configured hours. | **Partly done (Phase 9)** | Throttle, concurrency ceiling and hour window (including midnight-crossing) are built and tested. No worker consumes the queue yet. |
| M54 | Unmapping or revoking indexing **immediately deletes all derived data**: extracted text, OCR output, FTS entries, embeddings. | **Done (Phase 9)** | Purge counted per artefact type rather than left to a cascade, so a derived table added in a later phase cannot silently escape it. |
| M55 | Admin controls indexing limits with hardware-aware defaults: max file size, allowed extensions, total index storage, per-user quotas. | **Done (Phase 9)** | Size, extension, total bytes and file count. A per-user ceiling may only TIGHTEN the workspace maximum. |
| M56 | ClamAV optional, own container; hookup ships ready; admin chooses whether to deploy/enable rather than forcing RAM/CPU on low-end hosts. | **Partly done (Phase 9)** | The `Scanner` interface, scan modes and blocking behaviour are built and tested against stubs. **No ClamAV container ships in compose.** |
| M57 | A finding **blocks** indexing/opening/processing and alerts owner + admin. Josi must **not** move, quarantine, modify or delete the source. | **Done (Phase 9)** | Blocks, alerts both parties, and the source hash before/after proves it was untouched. There is a test asserting the module contains no write verbs. Blocking is reversible; deleting is not. |
| M58 | Automatic definition updates are a super-admin setting, not forced; UI shows enabled state, installed version, last success, failures. | **Partly done (Phase 9)** | `clamav_status` records version, last success and failures. **Nothing writes it** — no updater exists. |
| M59 | Two scan modes: **on access/indexing** (lower cost) or **every new/changed file**; both supported. | **Done (Phase 9)** | Both modes; an enabled-but-unreachable scanner STOPS processing rather than passing files through unscanned. |
| M60 | On change, index the newest version. History super-admin configurable: disabled / 1 / 2 previous versions; snapshots vs **downloadable recovery copies**; disclose storage+privacy impact; count toward quotas; purgeable; never retained after unmap/revoke. | **Done (Phase 9)** | Off by default, and defaulting to `snapshot` so enabling it without reading the wording does not start copying files. Trimmed on the way in, not on a sweep. |
| M61 | History/recovery needs no extra per-user consent beyond existing mapping/indexing consent; admin alone sets mode; policy must be plainly visible to affected users. | **Done (Phase 9)** | No extra per-user consent; the disclosure is generated from the settings so the wording cannot drift from the behaviour. |
| M62 | No application-level encryption for recovery copies; setup must say they inherit Docker volume/host storage security and recommend full-disk/volume encryption. | **Done (Phase 9)** | Says plainly that recovery copies are NOT encrypted by Josi and recommends full-disk encryption. The database refuses to store one outside `/data/versions`. |
| M63 | Full restorable backups **include** retained recovery copies; portable exports **exclude** them and carry only current portable data/files. | **Partly done (Phase 10)** | Full backups include recovery copies; portable exports exclude them, enforced by a database constraint. **The portable export is a pg_dump, not the human-readable form M63 describes** — a named shortfall. |
| M64 | Password-protected/encrypted documents skipped with a clear per-file notice; Josi never requests, retains or manages document passwords. | **Done (Phase 9)** | ZIP flag bit, OLE `EncryptedPackage`, PDF `/Encrypt`. Josi never requests a document password — there is no prompt anywhere to remove. |
| M65 | ZIP/RAR/7z excluded by default; admin may enable **bounded** extraction with limits on recursion, expanded size, file count, inner types, time, and path safety; encrypted archives still skipped. | **Done (Phase 9)** | Excluded by default. Bounded on EXPANSION: entries, expanded bytes, depth, wall-clock, entry-path traversal, encrypted entries. The size bound is checked before accepting an entry. |
| M67 | Answers grounded in documents cite file name/path plus the most precise locator (PDF page, sheet/cell, slide, heading), with **Open source** when the user still has access. | **Partly done (Phase 9)** | Locators are stored per segment and surfaced in citations; "Open source" is offered only while access remains. **No parser produces real locators yet.** |
| M71 | Revoking access purges source-derived long-term memory and tool/cache data; already-sent chat messages are **not** silently rewritten, but their citations become unavailable. | **Done (Phase 9)** | Citations resolve at display time. Revocation makes them unopenable; the message body is asserted unchanged. |
| M72 | Super-admin audit trail for mapping requests/approvals, permission and sharing changes, indexing/OCR actions, ClamAV findings, purges, recovery-copy downloads — **metadata only**, never text/content/previews. | **Done (Phase 9)** | Every storage audit entry carries counts, reasons and flags — never a filename or path. Asserted across all of them. |
| M73 | Audit retention configurable 30d/90d/1y/forever; default **1 year**; "forever" shows a storage-growth warning. | **Done (Phase 9)** | Default one year, with a growth warning on `forever`. Phase 1's append-only trigger now permits deleting ONLY rows past the window — no bypass flag. |
| M74 | Per-folder status: queued, processing, current, partially failed, paused; skipped-file reasons; progress; retry. Admin sees aggregate health/failure metadata without previews or extracted content. | **Done (Phase 9)** | Per-file skip reasons from a fixed vocabulary, each with a plain-language explanation. Parser error strings never reach the database, since parsers quote the document. |
| M75 | Global **Pause all document processing** stops new indexing/OCR/extraction/rescans without deleting built search data; existing search stays available. | **Done (Phase 9)** | Stops every kind of new work and deletes nothing; search is asserted still to answer while paused. |
| M76 | Local folders use filesystem watching; Drive/OneDrive use scheduled sync at admin-selected 5/15/30/60 minutes, respecting provider rate limits and hardware. | **Partly done (Phase 9)** | Cadence is a validated setting. **No scheduler and no filesystem watcher exist.** |
| M77 | Rate-limited **Sync now** per user for their own cloud mappings; admin may disable manual sync globally; manual sync respects quotas and cannot bypass the global pause. | **Done (Phase 9)** | Rate-limited per mapping, disableable, and unable to bypass the global pause — the pause is what the person is told about. |
| M78 | Expired/revoked provider access pauses the mapping and notifies the owner; admin sees connection-health metadata only — never names, previews or contents. | **Done (Phase 9)** | An expired token pauses and notifies; a rate limit does not. Pausing keeps the index, so a lapsed token does not cost someone their search. |
| M79 | Source deleted while mapping remains authorised: recovery-copy mode keeps the last copy in a Josi recycle bin for admin-selected 7/30/90 days; without it, derived data purges immediately. Unmapping/revocation still purges immediately regardless. | **Done (Phase 9)** | Recycle bin for a vanished source; immediate purge when permission is withdrawn. The two are deliberately different. |

## G. Platform, packaging, operations

| ID | Decision | Status | Where |
|---|---|---|---|
| M80 | Database direction is **PostgreSQL only**. | Phase 1 | No other driver present. |
| M99 | Default distribution bundles **Caddy** for domain-based automatic HTTPS; advanced operators may disable it and bring their own proxy/TLS. | Phase 2 | `caddy` service + documented BYO mode. |
| M100 | Provider API keys, OAuth credentials, SMTP/Twilio secrets encrypted in Postgres with an installation **master key stored outside the database** as a Docker secret/file. Setup and backup docs must require backing up the key separately; DB backups alone cannot restore credentials. | **Done (Phase 10)** | Proven on real hardware: a restore WITH the key decrypts a real sealed credential (probe 200); pointed at a different key it is unusable (409) with the ciphertext untouched; the original key makes it work again. The key's bytes are absent from the archive. |
| M28 | Google/Microsoft connectors require the **operator's own** OAuth apps/client secrets and callback configuration. | **Done (Phase 7)** | `oauth_clients`, secret sealed with the master key. CE ships no client of its own: a shared baked credential would let the first person to extract it impersonate every installation. The admin surface returns the client id (public, it travels in the authorize URL) and never the secret. Mutations M18/M19 fail the suite. |
| M29 | One owner-configured OAuth application per provider; every user connects and authorises their **own** account with separate encrypted tokens. | **Done (Phase 7)** | `connections(owner_user_id, provider)`, tokens sealed per connection. Wire tests: another member's connection is 404 to read, to enable a capability on, and to disconnect. |
| M32 | **Incremental authorization**: initial connection requests read scopes only; enabling send/edit requires reauthorization for write scopes. | **Done (Phase 7)** | Connect asks for read scopes only; enabling a write capability the provider never granted is refused with `needs_consent` rather than stored as a wish. A second consent accumulates scopes instead of narrowing the first. Mutations M4/M5/M7 fail the suite. |
| M98 | Telemetry **opt-in only**, at initial setup; may cover version, enabled features, aggregate counts, performance, errors; **never** prompts, message/email/contact/calendar content, credentials, secrets or identifiable business data. Setup explains exactly what is sent; off unless affirmatively enabled. | **Done (Phase 10)** | Off by default; sends nothing while off even with an endpoint stored; payload built from an allowlist, free text refused, nested objects reduced to counts and flags. Disabling clears the endpoint. **No endpoint ships and none has been contacted.** |
| M111 | One locally generated random UUID per installation for support correlation and rate limiting; **not** derived from hardware fingerprints, serials or MAC addresses, and not tied to mandatory telemetry. | Phase 1 | `install_identity`. Test: value is random, not hardware-derived. |

| M30 | Each user controls their own connected accounts; workspace owners may see connection health and revoke, but the admin panel must not let them browse that user's email or calendar content. | **Done (Phase 7)** | Admin view is username, provider, status, check time and a failure CATEGORY. Not the address, not the scopes, not a token. Mutation M17 — adding the account address to that query — fails the suite. |
| M33 (connector half) | Super-admin policy may tighten but never loosen; a capability works only when both the user grants it and the admin allows it. | **Done (Phase 7)** | `effectiveCapability` is the AND of provider-granted, admin-allows and user-enabled, with a full truth table and a monotonicity test. The policy table has an `allowed` column and no `granted` column — the shape itself cannot bestow. Mutations M1/M2/M6 fail the suite. |

## H. Support (contract only in 0.1)

| ID | Decision | Status | Where |
|---|---|---|---|
| M102 | Support page requires a problem description and a diagnostics ZIP; users inspect the bundle, consent explicitly, and pass a final secret scan. Bundles deleted 30 days after ticket closure; correspondence may remain. A ticket never grants remote access; screen-share/SSH arranged separately with temporary credentials. | **Done (Phase 10)** | Inspect → approve → scan, as three separate acts, with a database constraint refusing a submission that skipped any. **A ticket never grants remote access: there is no such mechanism in CE.** |
| M103 | Gateway verifies the submitter's email with a one-time link before accepting a ticket or upload. | Deferred (gateway) | CE defines the contract; the gateway is SoCal-side and not in this repo. |
| M104 | Ticket categories: Bug report, Feature request, Paid support request, Security/privacy report — routed and prioritised separately. | **Done (Phase 10)** | Four categories, each with its own acknowledgement text. |
| M105 | Diagnostics mandatory for bug reports and paid technical support; optional for feature requests; optional for security/privacy with a warning not to upload unrelated data. | **Done (Phase 10)** | Mandatory for bug reports and paid support, in code and as a database constraint. |
| M106 | Correspondence works by verified email without a Zammad account; a customer-portal account may be optional. | Deferred (gateway) | Gateway-side. |
| M107 | Submission requires acknowledging that bug reports/feature requests carry no guaranteed response or fix, and that a paid-support submission is only a request to be contacted. | **Done (Phase 10)** | Refused without it, and the refusal names the acknowledgement rather than surfacing a constraint error. |
| M108 | Public gateway uses Cloudflare Turnstile plus rate limits keyed by IP, verified email and installation ID. | Deferred (gateway) | Gateway-side; CE supplies the installation ID. |
| M109 | Bundles capped at **25 MB** compressed; exporter trims old logs and oversized/noisy files first. | **Done (Phase 10)** | 25 MB ceiling; oldest logs trimmed first and what was dropped is named, because silent truncation reads as "we included everything". |
| M110 | Gateway quarantines and safely unpacks bundles, scans for malware, rejects executables, symlinks, traversal and zip bombs before forwarding. | Deferred (gateway) | Gateway-side. |
| M112 | Exporter offers 1-hour, 24-hour and 7-day log windows, defaulting to **24 hours**; every bundle includes version, container health, resource summary and sanitized config status. | **Partly done (Phase 10)** | 1h/24h/7d, default 24h; version, resources and sanitized config status included. **Logs and container health are not collected** — the app has no Docker socket by design. |
| M113 | Bundles **always exclude** prompts, chats, email/calendar/contact/task content, uploaded documents and database rows; users cannot toggle these in. | **Done (Phase 10)** | Excluded by construction: the builder can only render a fixed section list, so a table added later cannot leak through a redactor nobody updated. Verified on a Linux test host that message and thread bodies are absent. |
| M114 | The support backend is operated separately from CE. | Excluded from CE | **No support-system credentials or host details ship in CE.** |
| M115 | CE must not embed support-system credentials; submission goes through a narrow operator-controlled gateway. | **Done (Phase 10)** | No gateway URL and no credential ship. With none configured the ticket stays draft and nothing is transmitted. |
| M116 | V2 may delegate bounded work to a curated catalogue of compiled specialist task workers. They are not general-purpose or user-authored agents: each has a fixed purpose, minimal task projection, allowlisted tools, durable state, approval/escalation rules, idempotent side effects and an explicit completion boundary. Initial families cover appointments, Meta, Google Ads, Yelp, read-only analytics, HR and bounded general administration, split more granularly wherever authority differs. Cross-specialist questions route through Josi as typed minimum-data requests; workers never share raw context, credentials or tools laterally. Workers are owned by one user and never pooled by department or workspace, even when users share a provider account; collaboration requires an explicit business object or authorised handoff. Token savings must be benchmarked, not assumed. | **Roadmap (Phase 14)** | `IMPLEMENTATION_PLAN.md` Phase 14 defines D1–D13. This must not delay the Phase 13 public-release gate. |

---

## Open items requiring a human

1. **Benchmarks before any capacity claim** (M97). No numbers ship until a Pi,
   an old x86-64 box and a modern mini-PC have been measured.
2. ~~**Provider terms re-check** for M83 before ever enabling a subscription
   option.~~ **Done, 1 September 2026 (Phase 13.3).** OpenAI documents
   `codex exec` as a non-interactive mode of its own CLI signed in with a
   ChatGPT plan, so delegating to the operator's own binary is a supported path
   and is now offered — CE only, behind a build-stamped capability, because the
   terms exclude powering a commercial service. Anthropic's policy restricts
   Claude Free/Pro/Max sign-in to Claude Code and Claude.ai, excludes every
   other product including the Agent SDK, and was enforced on 4 April 2026, so
   that path stays closed and the UI cites it. Sources and dates in
   `docs/SUBSCRIPTION_AUTH.md`. **Re-check before any release that changes this
   feature** — both positions are somebody else's policy and can move.
4. **Support gateway** is a separate SoCal-side project (M103, M106, M108, M110,
   M114, M115); CE ships only the client contract.
