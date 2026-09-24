// Storing, versioning, exporting and resetting the four profile layers.
//
// The database is canonical (the plan: "container replacement and upgrades
// cannot erase them"). The Markdown is what the person reads and exports; the
// parsed configuration is what the system uses. Both are stored, and the parse
// is redone on every save so the two can never disagree.
import { randomUUID } from 'node:crypto';
import { appendEvent, json, type Db } from '@josi-ce/core';
import { parseProfile, renderProfile, type ParsedProfile } from './parse.js';
import { AGENTS_FIELDS, CAUTION_ORDER, FIELDS, type Layer } from './schema.js';

export class ProfileError extends Error {}

export interface Profile {
  id: string;
  owner_user_id: string | null;
  kind: Layer;
  content: string;
  parsed: Record<string, string | string[]>;
  ignored: unknown[];
  version: number;
}

/** Whose profile this is. `agents_admin` belongs to the installation. */
function ownerFor(kind: Layer, userId: string | null): string | null {
  return kind === 'agents_admin' ? null : userId;
}

export async function saveProfile(
  db: Db,
  args: { kind: Layer; userId: string | null; content: string; actorUserId: string },
): Promise<{ profile: Profile; parsed: ParsedProfile }> {
  const parsed = parseProfile(args.kind, args.content);
  const owner = ownerFor(args.kind, args.userId);

  if (args.kind !== 'agents_admin' && !owner) {
    throw new ProfileError('a personal profile needs an owner');
  }

  // Two queries rather than one with an unused parameter: `where kind = $2`
  // with $1 never referenced leaves PostgreSQL unable to infer $1's type, which
  // fails at runtime rather than at compile time.
  const [existing] = owner
    ? await db.query<{ id: string; version: number; content: string; parsed: unknown }>(
        `select id, version, content, parsed from persona_profiles
         where owner_user_id = $1 and kind = $2`,
        [owner, args.kind],
      )
    : await db.query<{ id: string; version: number; content: string; parsed: unknown }>(
        `select id, version, content, parsed from persona_profiles where kind = $1`,
        [args.kind],
      );

  if (existing) {
    // Keep the previous version before overwriting, so "reset" and "what did
    // this look like" are real rather than aspirational.
    await db.query(
      `insert into persona_versions (profile_id, version, content, parsed)
       values ($1, $2, $3, $4)
       on conflict (profile_id, version) do nothing`,
      [existing.id, existing.version, existing.content, json(existing.parsed ?? {})],
    );
  }

  // The admin policy has no owner, so the partial unique index does not cover
  // it and `on conflict` cannot name it. Update in place when it exists.
  const rows = existing && !owner
    ? await db.query<Profile>(
        `update persona_profiles set content = $1, parsed = $2, ignored = $3,
           version = version + 1 where kind = 'agents_admin' returning *`,
        [args.content, json(parsed.values), json(parsed.ignored)],
      )
    : await db.query<Profile>(
        `insert into persona_profiles (owner_user_id, kind, content, parsed, ignored, version)
         values ($1, $2, $3, $4, $5, 1)
         on conflict (owner_user_id, kind) where owner_user_id is not null
           do update set content = excluded.content, parsed = excluded.parsed,
                         ignored = excluded.ignored,
                         version = persona_profiles.version + 1
         returning *`,
        [
          owner, args.kind, args.content,
          json(parsed.values), json(parsed.ignored),
        ],
      );
  const row = rows[0];

  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: args.kind === 'agents_admin' ? 'super_admin' : 'user',
    kind: 'persona.saved',
    subjectType: 'persona_profile',
    subjectId: row.id,
    // Which layer, how big, how much was ignored. Never the content — a
    // person's description of themselves is theirs.
    payload: {
      layer: args.kind,
      bytes: Buffer.byteLength(args.content, 'utf8'),
      ignored: parsed.ignored.length,
      authorityAttempts: parsed.authorityAttempts.length,
    },
  });

  return { profile: row, parsed };
}

export async function getProfile(
  db: Db, args: { kind: Layer; userId: string | null },
): Promise<Profile | null> {
  const owner = ownerFor(args.kind, args.userId);
  const [row] = owner
    ? await db.query<Profile>(
        `select * from persona_profiles where owner_user_id = $1 and kind = $2`,
        [owner, args.kind],
      )
    : await db.query<Profile>(
        `select * from persona_profiles where kind = $1`, [args.kind],
      );
  return row ?? null;
}

/** Every layer for one person, with defaults where nothing was written.
 *
 * The plan: "the assistant works before any profile is created." So an absent
 * profile is an empty object, never an error. */
export async function loadAll(
  db: Db, userId: string,
): Promise<Record<Layer, Record<string, string | string[]>>> {
  const rows = await db.query<{ kind: Layer; parsed: Record<string, string | string[]> }>(
    `select kind, parsed from persona_profiles
     where owner_user_id = $1 or kind = 'agents_admin'`,
    [userId],
  );
  const out: Record<Layer, Record<string, string | string[]>> = {
    agents_admin: {}, agents_user: {}, soul: {}, user: {},
  };
  for (const row of rows) {
    out[row.kind] = typeof row.parsed === 'string' ? JSON.parse(row.parsed) : (row.parsed ?? {});
  }
  return out;
}

/** M-new: reset changes no conversations and no unrelated memory. It restores
 * a previous version of ONE layer, and nothing else is touched. */
export async function resetProfile(
  db: Db, args: { kind: Layer; userId: string | null; toVersion?: number; actorUserId: string },
): Promise<Profile> {
  const current = await getProfile(db, { kind: args.kind, userId: args.userId });
  if (!current) throw new ProfileError('there is nothing to reset');

  let content = '';
  if (args.toVersion !== undefined) {
    const [old] = await db.query<{ content: string }>(
      `select content from persona_versions where profile_id = $1 and version = $2`,
      [current.id, args.toVersion],
    );
    if (!old) throw new ProfileError('no such version');
    content = old.content;
  }

  const { profile } = await saveProfile(db, {
    kind: args.kind, userId: args.userId, content, actorUserId: args.actorUserId,
  });
  return profile;
}

export async function listVersions(
  db: Db, args: { kind: Layer; userId: string | null },
): Promise<Array<{ version: number; created_at: string; bytes: number }>> {
  const current = await getProfile(db, { kind: args.kind, userId: args.userId });
  if (!current) return [];
  const rows = await db.query<{ version: number; created_at: string; content: string }>(
    `select version, created_at, content from persona_versions
     where profile_id = $1 order by version desc limit 50`,
    [current.id],
  );
  return rows.map((r) => ({
    version: r.version, created_at: r.created_at,
    bytes: Buffer.byteLength(r.content ?? '', 'utf8'),
  }));
}

export interface ExportBundle {
  version: 1;
  exported_at: string;
  files: Partial<Record<Layer | 'memory', string>>;
  /** Optional lossless companion to the unchanged version-1 Markdown view. */
  memory_records?: Array<{ content: string; provenance: string; pinned: boolean }>;
}

/** M-new: "Import/export all four portable Markdown files... Round trips
 * preserve content and versions." */
export async function exportProfiles(
  db: Db, args: { userId: string; includeAdmin?: boolean; now: string },
): Promise<ExportBundle> {
  const files: Partial<Record<Layer | 'memory', string>> = {};
  for (const kind of ['soul', 'user', 'agents_user'] as const) {
    const p = await getProfile(db, { kind, userId: args.userId });
    if (p?.content) files[kind] = p.content;
  }
  if (args.includeAdmin) {
    const p = await getProfile(db, { kind: 'agents_admin', userId: null });
    if (p?.content) files.agents_admin = p.content;
  }

  const memories = await db.query<{ content: string; provenance: string; pinned: boolean }>(
    `select content, provenance, pinned from memories where owner_user_id = $1
     order by pinned desc, created_at`,
    [args.userId],
  );
  if (memories.length) {
    files.memory = memories
      .map((m) => `- ${m.pinned ? '**' : ''}${m.content}${m.pinned ? '**' : ''}  <!-- ${m.provenance} -->`)
      .join('\n') + '\n';
  }

  return { version: 1, exported_at: args.now, files, ...(memories.length ? { memory_records: memories } : {}) };
}

export async function importProfiles(
  db: Db,
  args: { userId: string; bundle: ExportBundle; actorUserId: string },
): Promise<{ profiles: Record<string, ParsedProfile>; receipt: import('./migration/types.js').MigrationReceipt }> {
  if (args.bundle?.version !== 1 || !args.bundle.files) throw new ProfileError('that is not a Josi profile export');
  if (args.userId !== args.actorUserId) throw new ProfileError('a personal import must belong to its actor');
  if (!db.transaction) throw new (await import('./migration/types.js')).MigrationError('Atomic transactions are unavailable; nothing was imported.', 503);
  const { scanMigration } = await import('./migration/scan.js');
  const { migrationScope, previewMigration, commitMigrationInTransaction } = await import('./migration/store.js');
  const scanned = scanMigration([{ path: 'josi-profile-export.json', bytes: Buffer.from(JSON.stringify(args.bundle)) }], 'josi');
  return db.transaction(async tx => {
    const profiles: Record<string, ParsedProfile> = {};
    // Preserve the released v1 restore contract for Josi-owned backups. This
    // trusted restore path is separate from the foreign-assistant wizard,
    // which never overwrites an occupied profile layer.
    for (const kind of ['soul', 'user', 'agents_user'] as const) {
      const content = args.bundle.files[kind];
      if (typeof content !== 'string') continue;
      const saved = await saveProfile(tx, { kind, userId: args.userId, content, actorUserId: args.actorUserId });
      profiles[kind] = saved.parsed;
    }
    const memoryOnly = { ...scanned, items: scanned.items.filter(item => item.category === 'memory') };
    const scope = await migrationScope(tx, args.userId);
    const reviewed = await previewMigration(tx, scope, memoryOnly);
    const receipt = await commitMigrationInTransaction(tx, scope, reviewed, randomUUID());
    return { profiles, receipt };
  });
}

export { AGENTS_FIELDS, CAUTION_ORDER, FIELDS, renderProfile };
