# Migrate from another assistant

Open **Settings → Data & Backup → Migrate from another assistant** while signed in.
Upload data you own. This transfers personal data and preferences, not a model's
identity, credentials, tools, permissions, installation policy or approval exemptions.

1. Choose a source, then upload one ZIP or individual Markdown/JSON/JSONL files.
2. Read the dry-run report. Nothing has been saved. Every proposed item is marked
   imported unchanged, transformed, duplicate, sensitive/refused, unsupported, or
   ignored, with a reason and source location. The first two labels describe a
   **proposed** result until commit.
3. Select categories or individual items. Nothing is selected by default. Edit or
   redact proposed memories. Duplicates default to keeping the existing fact; edit
   a duplicate into a distinct fact and review again if appropriate.
4. Review the exact selection, then import. A transaction saves all selected rows
   and the receipt together. If another import or edit introduced a conflict after
   review, no rows are saved; review again.
5. Download the receipt. Import history also provides receipts and complete batch
   rollback. Rollback removes only rows created by that batch, **including later
   edits and profile version history belonging to those imported rows**. It cannot
   restore source files and does not modify pre-existing Josi data.

Existing personal profiles are never replaced or merged. Identical profiles are
duplicates; differing profiles for an occupied layer are ignored with an explicit
conflict explanation. Their proposed content remains visible for manual copying
in Personalization. A profile can be imported when that layer does not yet exist.

## Supported formats and authoritative sources

Research checked 2026-09-18. Unversioned formats are reported as **unversioned**;
the wizard does not claim to detect a product release from a filename. Source
selection identifies the adapter, not the authenticity of an export.

| Source / format | Supported projection | Authority |
| --- | --- | --- |
| OpenClaw workspace Markdown | `SOUL.md` → bounded Soul fields; `USER.md` → bounded user fields / About Me; `AGENTS.md` → exact existing Josi enum keys and values only | [Workspace file map](https://docs.openclaw.ai/concepts/agent-workspace), [SOUL template](https://docs.openclaw.ai/reference/templates/SOUL), [USER template](https://docs.openclaw.ai/reference/templates/USER) |
| OpenClaw `MEMORY.md`, `memory/**/*.md` | Paragraphs / bullets become separate, editable proposed facts; headings are reported as ignored labels; no model-based extraction or summary | [Memory documentation](https://docs.openclaw.ai/concepts/memory) |
| OpenClaw Pi session JSONL **v3** | `type: session` header with version/id/timestamp/cwd, followed by identified/timestamped message events. Only visible user/assistant text, in file order, including branches | [OpenClaw v2026.3.8 session contract](https://github.com/openclaw/openclaw/blob/v2026.3.8/docs/reference/session-management-compaction.md), [Pi session serializer and v3 header](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/session-manager.ts) |
| OpenClaw `cron/jobs.json`, `HEARTBEAT.md`, `BOOT.md` | Preview/report only; no task/action/schedule is created. `jobs.json` is displayed as plain text for manual review without claiming a schema mapping | [Cron/automation documentation](https://docs.openclaw.ai/automation/cron-jobs) |
| Hermes `memories/MEMORY.md` | Exact `\n§\n` entry delimiter, stripped non-empty entries, including multiline entries and literal section signs within an entry | [Persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [MemoryStore serializer at c62bd9f](https://github.com/NousResearch/hermes-agent/blob/c62bd9f2078a946108f1c9d9b24bf118963277ef/tools/memory_tool_store.py) |
| Hermes `memories/USER.md` | User prose → bounded About Me, line breaks replaced by spaces; no inferred behaviour or authority fields | Same MemoryStore contract |
| Hermes flat session JSONL (or a single exported JSON object) | `export_session` / `hermes sessions export`: top-level session id/source/numeric started_at/messages; each message retains numeric row id, matching session_id, timestamp and role/content. Only visible user/assistant text is archived | [Sessions/export documentation](https://hermes-agent.nousresearch.com/docs/user-guide/sessions), [session serializer at c62bd9f](https://github.com/NousResearch/hermes-agent/blob/c62bd9f2078a946108f1c9d9b24bf118963277ef/hermes_state_portability.py), [CLI JSONL writer at c62bd9f](https://github.com/NousResearch/hermes-agent/blob/c62bd9f2078a946108f1c9d9b24bf118963277ef/hermes_cli/sessions_cmd.py) |
| Josi version-1 profile bundle | Existing personal Markdown fields plus MEMORY, with original memory content, pinning and provenance | `packages/persona/src/profiles.ts` |

For individual root `MEMORY.md` / `USER.md`, select the source explicitly unless
the bundle provides a recognizable workspace path or sibling OpenClaw profile
marker. Auto detection does not guess between identical unversioned filenames.
External free-text profiles may require shortening to fit Josi's 2,000-character
fields. Behaviour prose has no automatic mapping: only Josi's exact enum vocabulary
is accepted. Unknown fields, enum values, truncations and authority attempts are
reported. Profile field parsing never grants privileges.

**Unsupported:** SQLite databases (including current OpenClaw canonical state and
Hermes `state.db`), unknown/future versioned session schemas, Hermes lineage/trace/
HTML/QMD/Markdown session exports, tool/system/extension messages, hidden reasoning,
binary media, credentials, connection settings, plugins/skills, admin policy and
external automation activation. Use a supported portable export. Non-text message
blocks are excluded and reported rather than presented as an intact transcript.
Workspace files are reported with guidance to copy chosen files into a separately
mapped folder. The wizard neither reads source paths from JSON nor accesses a local
assistant installation or arbitrary directory.

## Memory export compatibility

`exportProfiles` still emits `version: 1` and the same `files.memory` Markdown view.
It now adds optional `memory_records` (`content`, `provenance`, `pinned`) to preserve
multiline content, literal Markdown delimiters, Unicode and provenance exactly.
Import validates that the structured records render to the supplied Markdown.
Old v1 single-line MEMORY exports remain readable. Ambiguous old multiline rows
are reported unsupported rather than silently split or reconstructed.

`importProfiles` uses the same scanner, duplicate checks and transactional batch
writer. Its HTTP response includes a receipt; it no longer drops MEMORY. Personal
imports cannot write `agents_admin`, even for a super administrator. Existing
profiles/facts remain intact. Original provenance is retained for round trips;
separate `source_provenance` records the import source, file, locator and hash.
Normalized deduplication trims edges, lowercases text and collapses whitespace;
pinning and differing provenance do not create another copy of the same fact.

## Architecture and security boundaries

`packages/persona/src/migration/` contains pure source adapters, the normalized
version-1 `MigrationManifest`, secret checks, bounded ZIP parsing, and storage
operations. `apps/api/src/http/migrationRoutes.ts` owns authentication-scoped,
ephemeral previews. `AssistantMigration.tsx` implements the wizard and historical
archive reader. The existing profile parser also rejects inherited object property
names, keeping AGENTS a closed enum vocabulary.

- The server derives the owner from the session and installation UUID from
  `install_identity`. CE has one workspace/database per installation, enforced by
  its existing singleton schema; no client-supplied tenant selector exists.
- Migration SQL verifies that owner is active and the installation matches.
  Imported rows reference `migration_batches` with a composite batch/owner FK.
  Reads/deletes use owner predicates; archives join the installation-scoped batch.
- Scan/review has no model calls, network calls, command execution or filesystem
  extraction. Raw uploaded bytes are never persisted. Sanitized manifests are
  stored briefly in owner/installation-scoped PostgreSQL rows so review and commit
  work across API replicas. The client cannot submit a manifest for commit.
  Revisions bind commit to the server's reviewed selection; row locks serialize
  review/commit, and the database owner lock plus final duplicate check protect commits.
- `Db.transaction` uses postgres.js `begin` (one reserved connection) and PGlite's
  transaction callback. There is no pooled `BEGIN`/`COMMIT` emulation. Batch rows,
  imported rows, provenance, receipt and content-free audit event commit together.
  An unsupported driver fails closed. Commit retries are idempotent by batch UUID;
  rolled-back batches cannot be recommitted under the same UUID.
- `migration_archives` is separate from active threads/messages and memory. There
  is no resume/write/tool route and no prompt retrieval path. Search/read are
  owner-scoped, paginated and read-only. Source roles are historical labels only.
- Likely passwords, tokens, cookies, sessions, API/provider credentials, private
  keys and payment data are refused before preview persistence and rescanned at
  commit, including edited memories. JSON strings are decoded before scanning;
  ignored metadata and filenames are checked too. A refused file's contents are
  omitted, and credential filenames are masked. Detection is deliberately
  conservative but cannot recognize every possible encoded or unlabeled secret;
  review/redact your export before uploading.
- React text nodes, textareas and `pre` render content. No imported HTML, Markdown
  renderer, automatic links or `dangerouslySetInnerHTML` are used. API replies are
  `no-store`. Migration errors never enter the generic error logger, whose database
  errors could expose failed row content. Audit payloads contain counts only.
- A batch rollback transaction deletes only batch-owned archives, memories and
  profiles; the profile FK cascades that profile's version history. The content-free
  receipt remains marked rolled back. Other batches and pre-existing rows are not
  updated or deleted. Standard installation backups still retain their own copies.

## Bounds and operational limitations

- Upload: one ZIP or 1–100 individual files, **8 MiB aggregate** enforced while
  streaming. Files/ZIP entries: **1 MiB** each, **200** ZIP entries, **16 MiB** expanded
  total, maximum **100:1** expansion ratio, **10,000** report items.
- ZIP32 stored/deflate only. Reject traversal, absolute/Windows paths, symlinks and
  special entries, duplicate paths, overlaps, local/central-header disagreement,
  invalid UTF-8 names, checksum/size mismatch, encryption, multipart ZIPs, ZIP64 and
  nested archives. Decompression also enforces actual output limits.
- Memory candidates: **2,000 characters**. Profile files: **20,000 bytes**, with the
  existing bounded fields. Memory duplicate review permits at most **10,000 existing
  memories**; other categories can be imported separately above that limit.
- At most two concurrent uploads per API process, one per owner. One unfinished
  preview per owner, up to 20 retained previews and 32 MiB of sanitized manifest
  data per installation. Raw uploaded buffers are released/cleared after scanning.
  Preview manifests live in PostgreSQL and are deleted after commit or discard, or
  after ten minutes by opportunistic cleanup. Expiry is checked before use.
  Committed data remains until deleted or rolled back; raw archives are never saved
  and encrypted archive retention is not offered by this feature.
- Preview rows and commit locks are shared through PostgreSQL, so multiple API
  replicas do not require request affinity. After commit, batch history is the
  authoritative receipt store, so an uncertain commit response can be retried on
  another replica without retaining a duplicate preview row.
- Full receipts are fetched individually; batch/archive lists return 20 records
  per page. No background migration, automatic external action or live source
  connection is created.

## Verification

All fixtures are synthetic. No OpenClaw/Hermes home directory or live gate is used.

```text
npm run typecheck
npm run build --workspace=@josi-ce/web
npx vitest run packages/persona/test apps/api/test/persona.test.ts apps/api/test/migration.test.ts packages/core/test/dbTransactions.test.ts --pool=forks
node scripts/test-migration-ui.mjs
npm test -- --pool=forks
bash scripts/scan-secrets.sh
git diff --check
```

The UI check starts an ephemeral localhost server with an in-memory PGlite database
and a temporary browser profile. It checks desktop/mobile upload, escaping, edits,
review-before-write, commit, receipt download and rollback. It uses installed
Playwright Chromium, falling back to installed Edge on Windows; it never opens an
existing browser session. `--pool=forks` avoids a Windows native-thread teardown
failure observed with the repository's default Vitest thread pool.
