#!/usr/bin/env bash
# Phase 9 mutation testing.
#
# Foreground segments, as Phase 7 established: backgrounded runs on this machine
# get killed part-way, and two harnesses racing on the same files produce
# meaningless results.
#
#   M_FROM=1 M_TO=6 bash scripts/mutate-phase9.sh
set -uo pipefail
cd "$(dirname "$0")/.."

FILES=(
  packages/storage/src/paths.ts
  packages/storage/src/mappings.ts
  packages/storage/src/gates.ts
  packages/storage/src/ingest.ts
  packages/storage/src/search.ts
  packages/storage/src/queue.ts
  packages/storage/src/versions.ts
  apps/api/src/http/storageRoutes.ts
  apps/api/src/http/authz.ts
  packages/db/migrations/0007_documents.sql
  packages/db/migrations/0008_ingestion.sql
  packages/db/migrations/0010_versions.sql
)

BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do mkdir -p "$BACKUP/$(dirname "$f")"; cp "$f" "$BACKUP/$f"; done
restore() {
  for f in "${FILES[@]}"; do cp "$BACKUP/$f" "$f"; done
  # Rebuild too, so a mutated dist never outlives its source.
  npx tsc -b >/dev/null 2>&1 || true
}
trap 'restore; rm -rf "$BACKUP"; echo; echo "(interrupted — sources restored)"; exit 130' INT TERM
trap 'restore; rm -rf "$BACKUP"' EXIT

# Rebuild before running.
#
# A consumer that imports `@josi-ce/persona` resolves to the package's BUILT
# dist, not its source. Without this, a mutation to persona/src is invisible to
# every test in another package — which is exactly what happened: seven
# mutations were measured against stale compiled output and recorded as
# "survived" when they had never been applied to the code under test.
run() {
  npx tsc -b >/dev/null 2>&1
  npx vitest run 2>&1 | grep -E "^ +Tests +" | tail -1
}

M_FROM="${M_FROM:-1}"; M_TO="${M_TO:-999}"; N=0
should_run() { N=$((N+1)); [[ $N -ge $M_FROM && $N -le $M_TO ]]; }

assert_mutated() {
  local changed=0
  for f in "${FILES[@]}"; do
    cmp -s "$BACKUP/$f" "$f" || changed=1
  done
  if [[ $changed -eq 0 ]]; then
    echo "  !! MUTATION DID NOT APPLY — result below is meaningless"; return 1
  fi
  return 0
}

echo "=== BASELINE ==="; run

mut() { echo; echo "=== M$N: $1 ==="; }

# --------------------------------------------------------------------------
# Containment. Each of these is a real way traversal defences get written wrong.
# --------------------------------------------------------------------------
if should_run; then mut "containment uses startsWith instead of a structural check"
python3 - <<'MUT'
p='packages/storage/src/paths.ts'; s=open(p).read()
s=s.replace("""  if (c === p) return true;
  const rel = relative(p, c);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);""",
"""  return c.startsWith(p);""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "symlinks are never resolved — the check runs on the lexical path only"
python3 - <<'MUT'
p='packages/storage/src/paths.ts'; s=open(p).read()
s=s.replace("""  let real: string;
  try {
    real = await rp(candidate);""","""  let real: string = candidate;
  try {
    real = candidate;""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "'..' is allowed in a path segment"
python3 - <<'MUT'
p='packages/storage/src/paths.ts'; s=open(p).read()
s=s.replace("const FORBIDDEN_SEGMENTS = new Set(['..', '.']);","const FORBIDDEN_SEGMENTS = new Set(['.']);",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an absolute path is accepted where a relative one was expected"
python3 - <<'MUT'
p='packages/storage/src/paths.ts'; s=open(p).read()
s=s.replace("  if (isAbsolute(input)) throw new PathEscape('that path must be relative to the mapped folder');","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a null byte in a path is accepted"
python3 - <<'MUT'
p='packages/storage/src/paths.ts'; s=open(p).read()
s=s.replace("  if (input.includes('\\0')) throw new PathEscape('that path contains a null byte');","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the extension is taken from the FIRST dot, so report.pdf.exe is a pdf"
python3 - <<'MUT'
p='packages/storage/src/paths.ts'; s=open(p).read()
s=s.replace("  const dot = base.lastIndexOf('.');","  const dot = base.indexOf('.');",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a not-yet-existing path is rebuilt under the UNRESOLVED parent"
python3 - <<'MUT'
p='packages/storage/src/paths.ts'; s=open(p).read()
s=s.replace("      return join(realAncestor, ...parts.slice(depth));","      return join(rootReal, cleanRelative);",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# The grant.
# --------------------------------------------------------------------------
if should_run; then mut "mapping works without the administrator having enabled it — M47"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("  const allowed = args.provider === 'local' ? capability.may_map_local : capability.may_map_cloud;","  const allowed = true;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "one capability covers both local and cloud"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("  const allowed = args.provider === 'local' ? capability.may_map_local : capability.may_map_cloud;","  const allowed = capability.may_map_local || capability.may_map_cloud;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "capabilities default to permitted when no row exists"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""const NO_CAPABILITY: StorageCapability = {
  may_map_local: false,
  may_map_cloud: false,
  may_index: false,""","""const NO_CAPABILITY: StorageCapability = {
  may_map_local: true,
  may_map_cloud: true,
  may_index: true,""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the refusal says which kind of mapping was denied"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""    throw new MappingError('an administrator has not enabled folder mapping for you', 'not_permitted');""",
"""    throw new MappingError(`an administrator has not enabled ${args.provider} folder mapping for you`, 'not_permitted');""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a mapping starts with every permission granted — M47"
python3 - <<'MUT'
p='packages/db/migrations/0007_documents.sql'; s=open(p).read()
s=s.replace("""  may_create boolean not null default false,
  may_edit boolean not null default false,
  may_move boolean not null default false,
  may_delete boolean not null default false,""",
"""  may_create boolean not null default true,
  may_edit boolean not null default true,
  may_move boolean not null default true,
  may_delete boolean not null default true,""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a mapping starts indexed"
python3 - <<'MUT'
p='packages/db/migrations/0007_documents.sql'; s=open(p).read()
s=s.replace("  indexing_enabled boolean not null default false,","  indexing_enabled boolean not null default true,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a mapping is recursive by default — M50"
python3 - <<'MUT'
p='packages/db/migrations/0007_documents.sql'; s=open(p).read()
s=s.replace("  recursive boolean not null default false,","  recursive boolean not null default true,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a read-only root can be made writable by its owner"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("    if (wantsWrite && !root?.writable) {","    if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a disabled root is still mappable"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("  if (!root || !root.enabled) throw new MappingError('that folder is not available', 'no_such_root');","  if (!root) throw new MappingError('that folder is not available', 'no_such_root');",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "containment is not checked when the grant is created — M45"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("  const resolved = await resolveWithin(root.container_path, relativePath, { mustExist: true });","  const resolved = { absolute: root.container_path, relative: relativePath };",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a root may be registered anywhere on the host — M45"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""  if (!isInside(base, path)) {
    throw new MappingError('a root must be under the folder Josi mounts shared storage into', 'bad_root');
  }""","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "root registration uses startsWith, so a sibling prefix passes"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("  if (!isInside(base, path)) {","  if (!path.startsWith(base)) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# Ownership and the administrator's limits.
# --------------------------------------------------------------------------
if should_run; then mut "any signed-in person may change a mapping's permissions — M68"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""  const [row] = await db.query<Mapping>(
    `select * from folder_mappings where id = $1 and owner_user_id = $2`,
    [mappingId, userId],
  );""","""  const [row] = await db.query<Mapping>(
    `select * from folder_mappings where id = $1`,
    [mappingId],
  );""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a shared mapping may be unmapped by the person it was shared with"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
s=s.replace("""    '/mappings/:id',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'owner' }),
    handle(async (req, res) => {
      const purged = await unmapFolder(db, {""","""    '/mappings/:id',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'write' }),
    handle(async (req, res) => {
      const purged = await unmapFolder(db, {""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the mapping route takes its owner from the request body — M47"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
s=s.replace("        ownerUserId: req.user!.id,\n        provider,","        ownerUserId: str(req.body?.ownerUserId, 64) || req.user!.id,\n        provider,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a member may set storage capabilities"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
s=s.replace("""    '/admin/capabilities/:userId',
    requireSuperAdmin,""","""    '/admin/capabilities/:userId',""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a member may read the admin health view"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
s=s.replace("""    '/admin/health',
    requireSuperAdmin,""","""    '/admin/health',""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the admin capability list joins in the folder paths — M72"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
s=s.replace("""                (select count(*)::int from folder_mappings m where m.owner_user_id = u.id) as mappings""",
"""                (select count(*)::int from folder_mappings m where m.owner_user_id = u.id) as mappings,
                (select string_agg(m.display_path, ',') from folder_mappings m where m.owner_user_id = u.id) as paths""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the audit log records which folder was mapped — M72"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""    payload: {
      provider: mapping.provider,
      recursive: mapping.recursive,
      indexing: mapping.indexing_enabled,
    },""","""    payload: {
      provider: mapping.provider,
      recursive: mapping.recursive,
      indexing: mapping.indexing_enabled,
      path: mapping.display_path,
    },""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# Purge.
# --------------------------------------------------------------------------
if should_run; then mut "revoking indexing keeps the extracted data — M54"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("  const purged = args.enabled ? null : await purgeDerived(db, args.mappingId);","  const purged = null;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "unmapping leaves the derived data behind — M54"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""  const purged = await purgeDerived(db, args.mappingId);
  await db.query(`delete from folder_mappings where id = $1`, [args.mappingId]);""",
"""  const purged = { documents: 0 };
  await db.query(`delete from folder_mappings where id = $1`, [args.mappingId]);""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an administrator revoking may_index leaves the indexed text in place"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
s=s.replace("      if (flag(req.body?.mayIndex) === false) {","      if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "indexing may be turned on without the administrator's half — M49"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("    if (!capability.may_index) {","    if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "pausing a mapping destroys its data — M78"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""  if (!row) return;
  await appendEvent(db, {""","""  if (!row) return;
  await purgeDerived(db, args.mappingId);
  await appendEvent(db, {""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# Consent wording. M50 makes this a control, not copy.
# --------------------------------------------------------------------------
if should_run; then mut "a recursive scope does not mention future subfolders — M50"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("    ? `${args.displayPath}, everything inside it, and any subfolder added to it in future`","    ? `${args.displayPath} and everything currently inside it`",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the indexing consent does not mention the language model — M49"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("  return `${read} Josi will also read every file in it now and keep the extracted text so it can search them, and will send that text to the language model you have configured when answering questions.`;","  return `${read} Josi will also index it.`;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "mapping and indexing consent say the same thing"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""  if (!args.indexing) {
    return `${read} Files are read only when something you ask for needs them. Nothing is copied or kept.`;
  }""","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# M70.
# --------------------------------------------------------------------------
if should_run; then mut "shared mappings do not block user removal — M70"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""     join resource_shares s
       on s.resource_type = 'folder_mapping' and s.resource_id = m.id""",
"""     left join resource_shares s
       on s.resource_type = 'folder_mapping' and s.resource_id = m.id and false""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# 9b — untrusted bytes.
# --------------------------------------------------------------------------
if should_run; then mut "the size ceiling is not applied — M55"
python3 - <<'MUT'
p='packages/storage/src/gates.ts'; s=open(p).read()
s=s.replace("  if (candidate.byteSize > num(policy.max_file_bytes)) return { ok: false, reason: 'too_large' };","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the extension allowlist is not applied — M55"
python3 - <<'MUT'
p='packages/storage/src/gates.ts'; s=open(p).read()
s=s.replace("  if (!archive && !policy.allowed_extensions.includes(ext)) {","  if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a per-user ceiling may RAISE the workspace maximum — M55"
python3 - <<'MUT'
p='packages/storage/src/gates.ts'; s=open(p).read()
s=s.replace("""  const maxFiles = Math.min(
    policy.max_files_per_user,
    ceilings.maxFiles ?? policy.max_files_per_user,
  );""","  const maxFiles = ceilings.maxFiles ?? policy.max_files_per_user;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "quota is checked without counting the incoming file"
python3 - <<'MUT'
p='packages/storage/src/gates.ts'; s=open(p).read()
s=s.replace("  if (usage.bytes + candidate.byteSize > maxBytes) {","  if (usage.bytes > maxBytes) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "encrypted ZIP-family files are opened anyway — M64"
python3 - <<'MUT'
p='packages/storage/src/gates.ts'; s=open(p).read()
s=s.replace("    if ((flags & 0x0001) !== 0) return true;","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "encrypted PDFs are opened anyway — M64"
python3 - <<'MUT'
p='packages/storage/src/gates.ts'; s=open(p).read()
s=s.replace("    if (header.toString('latin1').includes('/Encrypt')) return true;","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "encryption is not checked before malware — M64"
python3 - <<'MUT'
p='packages/storage/src/gates.ts'; s=open(p).read()
s=s.replace("  if (looksEncrypted(candidate)) return { ok: false, reason: 'encrypted' };","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "archives are indexed even when the administrator excluded them — M65"
python3 - <<'MUT'
p='packages/storage/src/gates.ts'; s=open(p).read()
s=s.replace("  if (archive && !policy.archives_enabled) return { ok: false, reason: 'archive_excluded' };","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the expanded-size bound is checked AFTER accepting the entry — M65"
python3 - <<'MUT'
p='packages/storage/src/gates.ts'; s=open(p).read()
before = """    if (out.bytesExpanded + entry.declaredSize > limits.maxTotalBytes) {
      out.stopped = 'size_limit';
      return out;
    }

    out.bytesExpanded += entry.declaredSize;"""
after = """    out.bytesExpanded += entry.declaredSize;
    if (out.bytesExpanded > limits.maxTotalBytes) {
      out.stopped = 'size_limit';
      return out;
    }"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the archive entry limit is ignored — M65"
python3 - <<'MUT'
p='packages/storage/src/gates.ts'; s=open(p).read()
s=s.replace("    if (out.entriesExtracted >= limits.maxEntries) { out.stopped = 'entry_limit'; return out; }","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "nested archives recurse without limit — M65"
python3 - <<'MUT'
p='packages/storage/src/gates.ts'; s=open(p).read()
s=s.replace("    if (depth >= limits.maxDepth) { out.stopped = 'depth_limit'; return out; }","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "archive entry paths are not checked for traversal — M65"
python3 - <<'MUT'
p='packages/storage/src/gates.ts'; s=open(p).read()
s=s.replace("    if (!safePath(entry.path)) { out.stopped = 'unsafe_path'; return out; }","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "encrypted archive entries are extracted anyway — M65"
python3 - <<'MUT'
p='packages/storage/src/gates.ts'; s=open(p).read()
s=s.replace("    if (entry.encrypted) { out.stopped = 'encrypted_entry'; return out; }","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the archive time limit never fires — M65"
python3 - <<'MUT'
p='packages/storage/src/gates.ts'; s=open(p).read()
s=s.replace("    if (now() - started > limits.maxSeconds * 1000) { out.stopped = 'time_limit'; return out; }","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "on_change mode does not scan at index time — M59"
python3 - <<'MUT'
p='packages/storage/src/gates.ts'; s=open(p).read()
s=s.replace("  return policy.clamav_scan_mode === 'on_change' ? true : event === 'index';","  return policy.clamav_scan_mode === 'on_change' ? event === 'change' : event === 'index';",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an overnight OCR window is treated as empty — M53"
python3 - <<'MUT'
p='packages/storage/src/gates.ts'; s=open(p).read()
s=s.replace("  return hour >= start || hour < end;","  return false;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a malware finding does not block the document — M57"
python3 - <<'MUT'
p='packages/storage/src/ingest.ts'; s=open(p).read()
s=s.replace("    `update documents set state = 'blocked', skip_reason = 'malware_found' where id = $1`,","    `update documents set state = 'discovered' where id = $1`,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a malware finding does not alert the owner and admin — M57"
python3 - <<'MUT'
p='packages/storage/src/ingest.ts'; s=open(p).read()
s=s.replace("     values ($1, $2, $3, $4, $5, now(), now())","     values ($1, $2, $3, $4, $5, null, null)",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a blocked file keeps its extracted text — M57"
python3 - <<'MUT'
p='packages/storage/src/ingest.ts'; s=open(p).read()
before = """  await db.query(`delete from document_text where document_id = $1`, [args.documentId]);
  await db.query(`delete from document_segments where document_id = $1`, [args.documentId]);
  await db.query(
    `insert into malware_findings"""
after = """  await db.query(
    `insert into malware_findings"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an unreachable scanner lets files through unscanned — M56"
python3 - <<'MUT'
p='packages/storage/src/ingest.ts'; s=open(p).read()
s=s.replace("    if (!deps.scanner) {","    if (false) {",1)
s=s.replace("    const { result, hashBefore, hashAfter } = await scanDocument(deps.scanner, bytes);","    if (!deps.scanner) return { kind: 'accepted', documentId };\n    const { result, hashBefore, hashAfter } = await scanDocument(deps.scanner, bytes);",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a skipped file keeps yesterday's searchable text"
python3 - <<'MUT'
p='packages/storage/src/ingest.ts'; s=open(p).read()
before = """  await db.query(`delete from document_text where document_id = $1`, [documentId]);
  await db.query(`delete from document_segments where document_id = $1`, [documentId]);
  await appendEvent(db, {"""
after = "  await appendEvent(db, {"
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "skipped files count against the quota"
python3 - <<'MUT'
p='packages/storage/src/ingest.ts'; s=open(p).read()
s=s.replace("     from documents where owner_user_id = $1 and state <> 'skipped'","     from documents where owner_user_id = $1",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the same work may be queued twice while it is live — M53"
python3 - <<'MUT'
p='packages/db/migrations/0008_ingestion.sql'; s=open(p).read()
before = """create unique index processing_jobs_one_live
  on processing_jobs (document_id, kind)
  where state in ('queued', 'running');"""
after = """create index processing_jobs_one_live
  on processing_jobs (document_id, kind);"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# 9c — search.
# --------------------------------------------------------------------------
if should_run; then mut "search is not scoped to the owner — M68"
python3 - <<'MUT'
p='packages/storage/src/search.ts'; s=open(p).read()
s=s.replace("     where s.owner_user_id = $1","     where ($1::uuid is not null)",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "search returns blocked and skipped documents"
python3 - <<'MUT'
p='packages/storage/src/search.ts'; s=open(p).read()
s=s.replace("       and d.state not in ('blocked', 'skipped')","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "search answers from a revoked mapping"
python3 - <<'MUT'
p='packages/storage/src/search.ts'; s=open(p).read()
s=s.replace("       and m.status <> 'revoked'","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a paused mapping loses its search — M78"
python3 - <<'MUT'
p='packages/storage/src/search.ts'; s=open(p).read()
s=s.replace("       and m.status <> 'revoked'","       and m.status = 'active'",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "semantic search is allowed in Local-only — M51"
python3 - <<'MUT'
p='packages/storage/src/search.ts'; s=open(p).read()
before = """  if (security?.local_only) {
    throw new SemanticForbidden(
      'this installation is set to Local-only, so nothing may be sent to an external service',
    );
  }

  const [policy] = await db.query<{ semantic_enabled: boolean }>("""
after = """  const [policy] = await db.query<{ semantic_enabled: boolean }>("""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "semantic consent may be recorded in Local-only — M51"
python3 - <<'MUT'
p='packages/storage/src/search.ts'; s=open(p).read()
before = """  const [security] = await db.query<{ local_only: boolean }>(
    `select local_only from security_policy where id = true`,
  );
  if (security?.local_only) {
    throw new SemanticForbidden(
      'this installation is set to Local-only, so nothing may be sent to an external service',
    );
  }

  await db.query(
    `insert into semantic_consents"""
after = """  await db.query(
    `insert into semantic_consents"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "semantic search needs no per-user consent — M51"
python3 - <<'MUT'
p='packages/storage/src/search.ts'; s=open(p).read()
s=s.replace("  if (!consent) {","  if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "withdrawing semantic consent keeps the vectors — M51"
python3 - <<'MUT'
p='packages/storage/src/search.ts'; s=open(p).read()
s=s.replace("    `with removed as (delete from document_embeddings where owner_user_id = $1 returning 1)","    `with removed as (select 1 where false and $1::uuid is not null)",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a citation stays openable after the document is purged — M71"
python3 - <<'MUT'
p='packages/storage/src/search.ts'; s=open(p).read()
before = """    canOpen: r.still_there
      && r.owner_user_id === args.viewerUserId
      && r.mapping_status === 'active',"""
after = "    canOpen: true,"
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a citation is openable by somebody who does not own it — M71"
python3 - <<'MUT'
p='packages/storage/src/search.ts'; s=open(p).read()
s=s.replace("      && r.owner_user_id === args.viewerUserId","      && true",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "citations lose their locator — M67"
python3 - <<'MUT'
p='packages/storage/src/search.ts'; s=open(p).read()
s=s.replace("  if (!hit.locator || hit.locatorKind === 'none') return hit.filename;","  return hit.filename;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# 9c — the queue.
# --------------------------------------------------------------------------
if should_run; then mut "the global pause does not stop new work — M75"
python3 - <<'MUT'
p='packages/storage/src/queue.ts'; s=open(p).read()
s=s.replace("  if (policy.processing_paused) return 'paused';","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "OCR runs even when the administrator disabled it — M52"
python3 - <<'MUT'
p='packages/storage/src/queue.ts'; s=open(p).read()
s=s.replace("    if (!policy.ocr_enabled) return 'unreadable';","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the OCR hour window is ignored — M53"
python3 - <<'MUT'
p='packages/storage/src/queue.ts'; s=open(p).read()
s=s.replace("    if (!withinHours(policy, args.hour)) return 'out_of_hours';","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the OCR concurrency ceiling is ignored — M53"
python3 - <<'MUT'
p='packages/storage/src/queue.ts'; s=open(p).read()
s=s.replace("  if ((running[0]?.n ?? 0) >= concurrencyFor(args.policy, args.kind)) return null;","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# 9d — history, sharing, sync, audit.
# --------------------------------------------------------------------------
if should_run; then mut "history is on by default — M60"
python3 - <<'MUT'
p='packages/db/migrations/0007_documents.sql'; s=open(p).read()
s=s.replace("  history_mode text not null default 'disabled'","  history_mode text not null default 'two'",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "history defaults to keeping copies of everyone's files — M60"
python3 - <<'MUT'
p='packages/db/migrations/0007_documents.sql'; s=open(p).read()
s=s.replace("  history_kind text not null default 'snapshot'","  history_kind text not null default 'recovery_copy'",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "history keeps more versions than configured — M60"
python3 - <<'MUT'
p='packages/storage/src/versions.ts'; s=open(p).read()
s=s.replace("  disabled: 0, one: 1, two: 2,","  disabled: 0, one: 2, two: 3,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "versions are never trimmed — M60"
python3 - <<'MUT'
p='packages/storage/src/versions.ts'; s=open(p).read()
s=s.replace("  const trimmed = await db.query<{ id: string }>(\n    `delete from document_versions","  const trimmed = await db.query<{ id: string }>(\n    `select id from document_versions where false and $2::int is not null and $1::uuid is not null; -- delete from document_versions",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a recovery copy may be written into the user's mapped folder — M60"
python3 - <<'MUT'
p='packages/db/migrations/0010_versions.sql'; s=open(p).read()
before = """  constraint version_stored_inside_josi check (
    stored_path is null or stored_path like '/data/versions/%'
  ),"""
s=s.replace(before, "", 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the history disclosure does not mention encryption — M62"
python3 - <<'MUT'
p='packages/storage/src/versions.ts'; s=open(p).read()
s=s.replace("    + 'off indexing, and are NOT encrypted by Josi — they are protected only by the security of this '","    + 'off indexing. '",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a vanished source keeps its searchable text — M79"
python3 - <<'MUT'
p='packages/storage/src/versions.ts'; s=open(p).read()
before = """  await db.query(`delete from document_text where document_id = $1`, [args.documentId]);
  await db.query(`delete from document_segments where document_id = $1`, [args.documentId]);
  return { recycled: rows.length, purged: false };"""
after = "  return { recycled: rows.length, purged: false };"
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the recycle bin never empties — M79"
python3 - <<'MUT'
p='packages/storage/src/versions.ts'; s=open(p).read()
s=s.replace("     where purge_after is not null and purge_after <= now()","     where false and purge_after is not null",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "turning sharing off does not stop sharing — M69"
python3 - <<'MUT'
p='packages/storage/src/versions.ts'; s=open(p).read()
s=s.replace("  if (!policy.sharing_enabled) {","  if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "forbidding workspace-wide sharing does nothing — M69"
python3 - <<'MUT'
p='packages/storage/src/versions.ts'; s=open(p).read()
s=s.replace("  if (args.workspace && !policy.workspace_sharing_enabled) {","  if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "Sync now bypasses the global pause — M77"
python3 - <<'MUT'
p='packages/storage/src/versions.ts'; s=open(p).read()
before = """  if (policy.processing_paused) {
    return { ok: false, reason: 'document processing is paused for the whole installation' };
  }"""
s=s.replace(before, "", 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "Sync now is not rate-limited — M77"
python3 - <<'MUT'
p='packages/storage/src/versions.ts'; s=open(p).read()
s=s.replace("    if (elapsed < MANUAL_SYNC_MIN_SECONDS) {","    if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an expired token does not pause the mapping — M78"
python3 - <<'MUT'
p='packages/storage/src/versions.ts'; s=open(p).read()
s=s.replace("  const shouldPause = args.category === 'token_expired' || args.category === 'permission_denied';","  const shouldPause = false;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a rate limit pauses the mapping too — M78"
python3 - <<'MUT'
p='packages/storage/src/versions.ts'; s=open(p).read()
s=s.replace("  const shouldPause = args.category === 'token_expired' || args.category === 'permission_denied';","  const shouldPause = true;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "audit retention keeps the wrong window — M73"
python3 - <<'MUT'
p='packages/storage/src/versions.ts'; s=open(p).read()
s=s.replace("  '30d': 30, '90d': 90, one_year: 365, forever: null,","  '30d': 3000, '90d': 9000, one_year: 36500, forever: null,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "forever deletes anyway — M73"
python3 - <<'MUT'
p='packages/storage/src/versions.ts'; s=open(p).read()
s=s.replace("  '30d': 30, '90d': 90, one_year: 365, forever: null,","  '30d': 30, '90d': 90, one_year: 365, forever: 365,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the forever warning does not mention growth — M73"
python3 - <<'MUT'
p='packages/storage/src/versions.ts'; s=open(p).read()
s=s.replace("    return 'Keeping the audit trail forever means it grows without limit. On a small machine '","    return 'Audit entries are kept indefinitely. '",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "events become freely deletable — the append-only guard"
python3 - <<'MUT'
p='packages/db/migrations/0010_versions.sql'; s=open(p).read()
before = """    if keep_days is not null and old.created_at < now() - make_interval(days => keep_days) then
      return old;
    end if;"""
after = "    return old;"
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "events become freely updatable — the append-only guard"
python3 - <<'MUT'
p='packages/db/migrations/0010_versions.sql'; s=open(p).read()
before = """  raise exception 'events is append-only';
end;
$$ language plpgsql;"""
after = """  return new;
end;
$$ language plpgsql;"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# 9b–9d over the wire.
# --------------------------------------------------------------------------
if should_run; then mut "the search route takes its owner from the query string — M68"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
s=s.replace("        ownerUserId: req.user!.id,\n        query: q,","        ownerUserId: str(req.query?.ownerUserId, 64) || req.user!.id,\n        query: q,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "sharing a folder needs only write access — M69"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
before = """    '/mappings/:id/share',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'owner' }),
    handle(async (req, res) => {
      const workspace = req.body?.workspace === true;"""
after = """    '/mappings/:id/share',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'write' }),
    handle(async (req, res) => {
      const workspace = req.body?.workspace === true;"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a member may pause the whole installation — M75"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
before = """    '/admin/pause',
    requireSuperAdmin,"""
after = "    '/admin/pause',"
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a member may change the storage policy"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
before = """    '/admin/policy',
    requireSuperAdmin,
    handle(async (req, res) => {
      const b = req.body ?? {};"""
after = """    '/admin/policy',
    handle(async (req, res) => {
      const b = req.body ?? {};"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the policy route stores whatever value it is given"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
before = """      const oneOf = (field: string, v: unknown, allowed: readonly string[]): string | null => {
        if (v === undefined || v === null) return null;
        if (typeof v === 'string' && allowed.includes(v)) return v;
        rejected.push(field);
        return null;
      };"""
after = """      const oneOf = (field: string, v: unknown, _allowed: readonly string[]): string | null => {
        if (v === undefined || v === null) return null;
        if (typeof v === 'string') return v;
        rejected.push(field);
        return null;
      };"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if [[ "$M_TO" -ge 999 ]]; then
  echo; echo "=== RESTORED — full suite must be green ==="; run
fi
