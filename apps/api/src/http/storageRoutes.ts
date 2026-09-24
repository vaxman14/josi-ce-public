// Documents and storage over HTTP.
//
// Two things to check when reading this file.
//
// First: there is no admin route that creates, reads, or browses a mapping.
// The administrator's routes below set CAPABILITIES and POLICY and read
// aggregate counts. That is M47's asymmetry made structural — an administrator
// who could create a mapping for someone could read their files by filling in a
// form, and since Josi indexes what it maps, those files would land in a search
// index the administrator also runs.
//
// Second: the owner is always `req.user!.id`. It is never read from the request
// body, in any route, for any reason.
import { Router, type Request, type Response } from 'express';
import { LIMITS, appendEvent, consume, enqueue, type Db } from '@josi-ce/core';
import {
  MappingError, PathEscape, SemanticForbidden, SemanticNotConsented, SharingDisabled,
  SEMANTIC_DISCLOSURE, assertSemanticAllowed, assertSharingAllowed, auditRetentionNotice,
  capabilityFor, citationLabel, consentText, createMapping, historyDisclosure,
  mappingStatus, mappingsBlockingUserRemoval, mayManualSync, purgeDerived,
  queueHealth, recordSemanticConsent, revokeSemanticConsent, searchDocuments,
  setGlobalPause, setIndexing, setPermissions, sharingPolicy, syncHealth, unmapFolder,
  SKIP_EXPLANATIONS,
  type Provider as MappingProvider,
} from '@josi-ce/storage';
import { requireAuth, requireOwnership, requireSuperAdmin } from './authz.js';
import { asyncRoute, param } from './async.js';

const MAPPING_PROVIDERS = ['local', 'google_drive', 'onedrive', 'dropbox', 'box', 'nextcloud'] as const;
function isKnownMappingProvider(value: string): value is MappingProvider {
  return (MAPPING_PROVIDERS as readonly string[]).includes(value);
}

/** Just the fields the disclosures are generated from. */
interface StoragePolicyRow {
  max_file_bytes: number | string;
  max_total_bytes_per_user: number | string;
  max_files_per_user: number;
  allowed_extensions: string[];
  archives_enabled: boolean;
  archive_max_entries: number;
  archive_max_total_bytes: number | string;
  archive_max_depth: number;
  archive_max_seconds: number;
  history_mode: 'disabled' | 'one' | 'two';
  history_kind: 'snapshot' | 'recovery_copy';
  recycle_bin_days: number;
  audit_retention: '30d' | '90d' | 'one_year' | 'forever';
  [key: string]: unknown;
}

export interface StorageRoutesCtx {
  db: Db;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const flag = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return asyncRoute(async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err: unknown) {
      // A containment failure and a refused grant are both "no". Neither says
      // anything about what is actually on disk.
      if (err instanceof PathEscape) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof RouteError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      if (err instanceof SemanticForbidden || err instanceof SharingDisabled) {
        res.status(403).json({ error: err.message });
        return;
      }
      if (err instanceof SemanticNotConsented) {
        // 409, not 403: this is a thing the person can resolve themselves, and
        // the response says how.
        res.status(409).json({ error: err.message, disclosure: SEMANTIC_DISCLOSURE });
        return;
      }
      if (err instanceof MappingError) {
        const code = err.code;
        const status = code === 'not_found' ? 404
          : code === 'not_permitted' ? 403
          : code === 'already_mapped' ? 409
          : 400;
        res.status(status).json({ error: err.message, code });
        return;
      }
      throw err;
    }
  });
}

export function storageRoutes(ctx: StorageRoutesCtx): Router {
  const { db } = ctx;
  const r = Router();
  r.use(requireAuth);

  /** The folders the operator has made available, and what this person may do.
   *
   * Deliberately shows roots to everyone who may map: they are operator-declared
   * shared locations with labels chosen for display, not private content. What
   * is inside them is not listed here. */
  r.get(
    '/available',
    handle(async (req, res) => {
      const capability = await capabilityFor(db, req.user!.id);
      const roots = capability.may_map_local
        ? await db.query(
            `select id, label, purpose, writable from storage_roots
             where enabled = true order by label`,
          )
        : [];
      const [policy] = await db.query<{ processing_paused: boolean }>(
        `select processing_paused from storage_policy where id = true`,
      );
      return res.json({ capability, roots, processingPaused: policy?.processing_paused ?? false });
    }),
  );

  /** What agreeing would mean, in words, before anything is created.
   *
   * A separate route rather than a string built in the browser: the sentence a
   * person consents to is a security artefact (M50), and it has to be the same
   * sentence the server would write into the record. */
  r.post(
    '/consent-preview',
    handle(async (req, res) => {
      const [root] = req.body?.rootId
        ? await db.query<{ label: string }>(
            `select label from storage_roots where id = $1 and enabled = true`, [str(req.body.rootId, 64)],
          )
        : [];
      const relative = str(req.body?.relativePath, 1000);
      const displayPath = root
        ? (relative ? `${root.label}/${relative}` : root.label)
        : str(req.body?.displayPath, 500) || 'the selected folder';
      return res.json({
        consent: consentText({
          displayPath,
          recursive: req.body?.recursive === true,
          indexing: req.body?.indexing === true,
        }),
      });
    }),
  );

  r.get(
    '/mappings',
    handle(async (req, res) => {
      const mappings = await db.query(
        `select id, provider, display_path, recursive, may_create, may_edit, may_move, may_delete,
                indexing_enabled, status, paused_reason, created_at
         from folder_mappings where owner_user_id = $1 order by created_at desc`,
        [req.user!.id],
      );
      return res.json({ mappings });
    }),
  );

  r.post(
    '/mappings',
    handle(async (req, res) => {
      const providerInput = str(req.body?.provider, 32);
      if (!isKnownMappingProvider(providerInput)) {
        return res.status(400).json({ error: 'choose local, Google Drive, OneDrive, Dropbox, Box or Nextcloud' });
      }
      const provider = providerInput;
      const mapping = await createMapping(db, {
        // The session, never the body.
        ownerUserId: req.user!.id,
        provider,
        rootId: str(req.body?.rootId, 64) || null,
        relativePath: str(req.body?.relativePath, 1000),
        connectionId: str(req.body?.connectionId, 64) || null,
        remoteFolderId: str(req.body?.remoteFolderId, 200) || null,
        displayPath: str(req.body?.displayPath, 500),
        recursive: req.body?.recursive === true,
      });
      return res.status(201).json({
        mapping,
        consent: consentText({
          displayPath: mapping.display_path,
          recursive: mapping.recursive,
          indexing: false,
        }),
      });
    }),
  );

  /** Reading one mapping accepts a share; changing it does not. */
  r.get(
    '/mappings/:id',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'read' }),
    handle(async (req, res) => {
      const id = param(req, 'id');
      const [mapping] = await db.query(
        `select id, owner_user_id, provider, display_path, recursive,
                may_create, may_edit, may_move, may_delete, indexing_enabled,
                status, paused_reason, created_at
         from folder_mappings where id = $1`,
        [id],
      );
      const [counts] = await db.query(
        `select count(*)::int as total,
                count(*) filter (where state = 'skipped')::int as skipped,
                count(*) filter (where state = 'blocked')::int as blocked
         from documents where mapping_id = $1`,
        [id],
      );
      return res.json({ mapping, counts });
    }),
  );

  r.put(
    '/mappings/:id/permissions',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'owner' }),
    handle(async (req, res) => {
      const mapping = await setPermissions(db, {
        mappingId: param(req, 'id'),
        ownerUserId: req.user!.id,
        create: flag(req.body?.create),
        edit: flag(req.body?.edit),
        move: flag(req.body?.move),
        delete: flag(req.body?.delete),
      });
      return res.json({
        mapping,
        // Said out loud, because granting `delete` is the one people misread.
        notice: mapping.may_delete
          ? 'Josi may ask to delete files in this folder. Every deletion still needs your approval.'
          : undefined,
      });
    }),
  );

  r.put(
    '/mappings/:id/indexing',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'owner' }),
    handle(async (req, res) => {
      const enabled = req.body?.enabled === true;
      const { mapping, purged } = await setIndexing(db, {
        mappingId: param(req, 'id'),
        ownerUserId: req.user!.id,
        enabled,
      });
      return res.json({ mapping, purged });
    }),
  );

  r.delete(
    '/mappings/:id',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'owner' }),
    handle(async (req, res) => {
      const purged = await unmapFolder(db, {
        mappingId: param(req, 'id'),
        ownerUserId: req.user!.id,
      });
      return res.json({ unmapped: true, purged });
    }),
  );

  /** M74: what happened to the files in one of your folders, and why. */
  r.get(
    '/mappings/:id/status',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'read' }),
    handle(async (req, res) => {
      const status = await mappingStatus(db, param(req, 'id'));
      return res.json({
        ...status,
        // A vocabulary token shown to a person is not an explanation.
        explanations: Object.fromEntries(
          status.skipped.map((s) => [s.reason, SKIP_EXPLANATIONS[s.reason as keyof typeof SKIP_EXPLANATIONS]]),
        ),
      });
    }),
  );

  /** Search. Owner-scoped by construction — the session supplies the owner and
   * there is no parameter that could widen it. */
  r.get(
    '/search',
    handle(async (req, res) => {
      // Full-text search across somebody's documents. Generous, because it is a
      // normal thing to do repeatedly, but not unbounded.
      const verdict = await consume(db, {
        limit: LIMITS.search, subject: `search:${req.user!.id}`,
      });
      if (!verdict.ok) {
        res.set('Retry-After', String(verdict.retryAfterSeconds));
        return res.status(429).json({ error: 'too many searches just now' });
      }
      const q = str(req.query?.q, 500);
      const hits = await searchDocuments(db, {
        ownerUserId: req.user!.id,
        query: q,
        mappingId: str(req.query?.mappingId, 64) || null,
        limit: Number(req.query?.limit) || 10,
      });
      return res.json({
        hits: hits.map((h) => ({
          documentId: h.documentId,
          mappingId: h.mappingId,
          citation: citationLabel(h),
          locator: h.locator,
          snippet: h.snippet,
          fromOcr: h.fromOcr,
        })),
      });
    }),
  );

  r.get(
    '/documents',
    handle(async (req, res) => {
      const limit = Math.max(1, Math.min(Number(req.query?.limit) || 100, 200));
      const documents = await db.query(
        `select d.id, d.filename, d.extension, d.byte_size, d.state, d.skip_reason,
                d.updated_at, m.display_path as folder
         from documents d join folder_mappings m on m.id = d.mapping_id
         where d.owner_user_id = $1 order by d.updated_at desc limit $2`,
        [req.user!.id, limit],
      );
      return res.json({ documents: (documents as Array<Record<string, unknown>>).map((document) => ({
        id: document.id, filename: document.filename, extension: document.extension,
        byteSize: document.byte_size, state: document.state, skipReason: document.skip_reason,
        updatedAt: document.updated_at, folder: document.folder,
      })) });
    }),
  );

  /** M51: agreeing to send document text to an embedding service. */
  r.get(
    '/semantic',
    handle(async (req, res) => {
      const [consent] = await db.query(
        `select provider, consented_at from semantic_consents where user_id = $1`,
        [req.user!.id],
      );
      const [policy] = await db.query<{ semantic_enabled: boolean }>(
        `select semantic_enabled from storage_policy where id = true`,
      );
      const [security] = await db.query<{ local_only: boolean }>(
        `select local_only from security_policy where id = true`,
      );
      return res.json({
        available: !!policy?.semantic_enabled && !security?.local_only,
        localOnly: !!security?.local_only,
        disclosure: SEMANTIC_DISCLOSURE,
        consent: consent ?? null,
      });
    }),
  );

  r.post(
    '/semantic/consent',
    handle(async (req, res) => {
      await recordSemanticConsent(db, {
        userId: req.user!.id,
        provider: str(req.body?.provider, 64) || 'configured provider',
      });
      return res.json({ consented: true, disclosure: SEMANTIC_DISCLOSURE });
    }),
  );

  r.delete(
    '/semantic/consent',
    handle(async (req, res) => {
      const purged = await revokeSemanticConsent(db, req.user!.id);
      return res.json({ consented: false, purged });
    }),
  );

  /** M69: sharing a mapped folder, subject to the administrator's switches.
   *
   * The same ownership rule as Phase 8's mail threads: sharing needs `owner`,
   * so a colleague given access cannot pass it on. */
  r.post(
    '/mappings/:id/share',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'owner' }),
    handle(async (req, res) => {
      const workspace = req.body?.workspace === true;
      const withUserId = str(req.body?.userId, 64);
      assertSharingAllowed(await sharingPolicy(db), { workspace });

      if (!withUserId && !workspace) {
        throw new RouteError(400, 'name a colleague to share with, or share with the workspace');
      }
      if (withUserId) {
        const [target] = await db.query<{ id: string }>(
          `select id from users where id = $1 and status = 'active'`, [withUserId],
        );
        if (!target) throw new RouteError(404, 'no such colleague');
      }

      const mappingId = param(req, 'id');
      await db.query(
        `insert into resource_shares
           (resource_type, resource_id, owner_user_id, shared_with_user_id, shared_with_workspace, can_write)
         values ('folder_mapping', $1, $2, $3, $4, false)
         on conflict do nothing`,
        [mappingId, req.user!.id, withUserId || null, workspace],
      );
      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'user',
        kind: 'storage.mapping_shared',
        subjectType: 'folder_mapping',
        subjectId: mappingId,
        payload: { workspace },
      });
      return res.json({
        shared: true,
        notice: workspace
          ? 'Everyone in this workspace can now read the files in this folder.'
          : 'They can now read the files in this folder. They cannot change it or share it on.',
      });
    }),
  );

  r.delete(
    '/mappings/:id/share',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'owner' }),
    handle(async (req, res) => {
      const mappingId = param(req, 'id');
      const workspace = req.body?.workspace === true;
      if (workspace) {
        await db.query(
          `delete from resource_shares where resource_type = 'folder_mapping'
           and resource_id = $1 and shared_with_workspace = true`, [mappingId],
        );
      } else {
        await db.query(
          `delete from resource_shares where resource_type = 'folder_mapping'
           and resource_id = $1 and shared_with_user_id = $2`,
          [mappingId, str(req.body?.userId, 64) || null],
        );
      }
      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'user',
        kind: 'storage.mapping_unshared',
        subjectType: 'folder_mapping',
        subjectId: mappingId,
        payload: { workspace },
      });
      return res.json({ shared: false });
    }),
  );

  /** M77: Sync now, rate-limited, and unable to bypass the global pause. */
  r.post(
    '/mappings/:id/sync',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'owner' }),
    handle(async (req, res) => {
      const mappingId = param(req, 'id');
      const [policy] = await db.query<{
        cloud_sync_minutes: number; manual_sync_enabled: boolean; processing_paused: boolean;
      }>(
        `select cloud_sync_minutes, manual_sync_enabled, processing_paused
         from storage_policy where id = true`,
      );
      const [state] = await db.query<{ last_manual_sync_at: string | null }>(
        `select last_manual_sync_at from sync_state where mapping_id = $1`, [mappingId],
      );

      const verdict = mayManualSync(policy, state ?? { last_manual_sync_at: null }, new Date());
      if (!verdict.ok) {
        if (verdict.retryAfterSeconds) res.set('Retry-After', String(verdict.retryAfterSeconds));
        return res.status(429).json({ error: verdict.reason, retryAfterSeconds: verdict.retryAfterSeconds });
      }

      await db.query(
        `insert into sync_state (mapping_id, owner_user_id, last_manual_sync_at)
         values ($1, $2, now())
         on conflict (mapping_id) do update set last_manual_sync_at = now()`,
        [mappingId, req.user!.id],
      );
      // The job the button claims to queue. The worker resolves the owner from
      // the mapping itself, so this id is the only thing the payload carries.
      await enqueue(db, { kind: 'storage.sync', payload: { mappingId } });
      return res.json({ queued: true });
    }),
  );

  // -------------------------------------------------------------------------
  // Administrator. Capabilities and policy. No content, no filenames, no paths.
  // -------------------------------------------------------------------------
  r.get(
    '/admin/capabilities',
    requireSuperAdmin,
    handle(async (_req, res) => {
      const rows = await db.query(
        `select u.id as user_id, u.username, u.display_name,
                coalesce(c.may_map_local, false) as may_map_local,
                coalesce(c.may_map_cloud, false) as may_map_cloud,
                coalesce(c.may_index, false) as may_index,
                coalesce(c.coding_enabled, false) as coding_enabled,
                c.max_files, c.max_bytes,
                (select count(*)::int from folder_mappings m where m.owner_user_id = u.id) as mappings
         from users u
         left join storage_capabilities c on c.user_id = u.id
         where u.status = 'active'
         order by u.username`,
      );
      // A COUNT of mappings is metadata. Their paths are not, and are not here.
      return res.json({ users: rows });
    }),
  );

  r.put(
    '/admin/capabilities/:userId',
    requireSuperAdmin,
    handle(async (req, res) => {
      const userId = param(req, 'userId');
      const [target] = await db.query<{ id: string }>(
        `select id from users where id = $1 and status = 'active'`, [userId],
      );
      if (!target) return res.status(404).json({ error: 'no such person' });

      const [row] = await db.query(
        `insert into storage_capabilities
           (user_id, may_map_local, may_map_cloud, may_index, max_files, max_bytes, granted_by)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (user_id) do update set
           may_map_local = coalesce($2, storage_capabilities.may_map_local),
           may_map_cloud = coalesce($3, storage_capabilities.may_map_cloud),
           may_index     = coalesce($4, storage_capabilities.may_index),
           max_files     = $5, max_bytes = $6, granted_by = $7, updated_at = now()
         returning *`,
        [
          userId,
          flag(req.body?.mayMapLocal) ?? false,
          flag(req.body?.mayMapCloud) ?? false,
          flag(req.body?.mayIndex) ?? false,
          Number.isInteger(req.body?.maxFiles) ? req.body.maxFiles : null,
          Number.isInteger(req.body?.maxBytes) ? req.body.maxBytes : null,
          req.user!.id,
        ],
      );

      // M47's other half: taking `may_index` away is a revocation, and M54 says
      // a revocation destroys derived data immediately. Turning the capability
      // off while leaving indexed text in place would make the switch a lie.
      let purged = null;
      if (flag(req.body?.mayIndex) === false) {
        const mappings = await db.query<{ id: string }>(
          `update folder_mappings set indexing_enabled = false, indexing_consented_at = null
           where owner_user_id = $1 and indexing_enabled = true returning id`,
          [userId],
        );
        let documents = 0;
        for (const m of mappings) documents += (await purgeDerived(db, m.id)).documents;
        purged = { mappings: mappings.length, documents };
      }

      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'storage.capability_changed',
        subjectType: 'user',
        subjectId: userId,
        payload: {
          mayMapLocal: row.may_map_local, mayMapCloud: row.may_map_cloud,
          mayIndex: row.may_index, purged,
        },
      });
      return res.json({ capability: row, purged });
    }),
  );

  /** M72/M74: aggregate health. Counts and states, never a name or a path. */
  r.get(
    '/admin/health',
    requireSuperAdmin,
    handle(async (_req, res) => {
      const byState = await db.query(
        `select state, count(*)::int as n from documents group by state order by state`,
      );
      const byProvider = await db.query(
        `select provider, status, count(*)::int as n from folder_mappings
         group by provider, status order by provider, status`,
      );
      const skips = await db.query(
        `select skip_reason, count(*)::int as n from documents
         where skip_reason is not null group by skip_reason order by n desc`,
      );
      return res.json({ documents: byState, mappings: byProvider, skipped: skips });
    }),
  );

  /** M70: what stops a person being removed. Named so a human can act on it. */
  r.get(
    '/admin/users/:userId/blocking',
    requireSuperAdmin,
    handle(async (req, res) => {
      const blocking = await mappingsBlockingUserRemoval(db, param(req, 'userId'));
      return res.json({
        // The path IS shown here, and only here, because an administrator being
        // asked to transfer or purge a shared folder cannot act on an opaque id.
        // It is already shared with somebody, and the alternative is an
        // administrator guessing.
        blocking: blocking.map((b) => ({ id: b.id, displayPath: b.display_path, sharedWith: b.shared_with })),
        instruction: blocking.length
          ? 'Each of these is shared with someone else. Transfer it to another owner or purge it before removing this person.'
          : 'Nothing shared. Removing this person will delete their mapped folders and everything derived from them.',
      });
    }),
  );

  r.get(
    '/admin/policy',
    requireSuperAdmin,
    handle(async (_req, res) => {
      const [policy] = await db.query<StoragePolicyRow>(`select * from storage_policy where id = true`);
      return res.json({
        policy,
        historyDisclosure: historyDisclosure(policy),
        auditNotice: auditRetentionNotice(policy.audit_retention),
      });
    }),
  );

  /** M75: stop new work. Deletes nothing; search keeps answering. */
  r.put(
    '/admin/pause',
    requireSuperAdmin,
    handle(async (req, res) => {
      const paused = req.body?.paused === true;
      await setGlobalPause(db, { paused, byUserId: req.user!.id });
      return res.json({
        paused,
        notice: paused
          ? 'New indexing, OCR and extraction are stopped. Nothing has been deleted and existing search still works.'
          : 'Processing has resumed.',
      });
    }),
  );

  /** M74/M78: queue and connection health. Counts and categories only. */
  r.get(
    '/admin/queue',
    requireSuperAdmin,
    handle(async (_req, res) => res.json(await queueHealth(db))),
  );

  r.get(
    '/admin/sync-health',
    requireSuperAdmin,
    handle(async (_req, res) => res.json({ mappings: await syncHealth(db) })),
  );

  /** The settings that change what is kept, with the sentences that describe
   * what they actually do. M61 requires the history policy to be plainly
   * visible; M73 requires the "forever" warning. */
  r.put(
    '/admin/policy',
    requireSuperAdmin,
    handle(async (req, res) => {
      const b = req.body ?? {};

      // A value outside the vocabulary is NAMED, not silently dropped and not
      // passed to the database to fail there.
      //
      // Letting it through produced a 500 from the CHECK constraint, which is
      // why the earlier test could not tell the two apart: it only asserted the
      // value was not stored, and the constraint guaranteed that on its own.
      // Saying which field was rejected is also the honest behaviour — an
      // ignored setting the operator believes they changed is worse than an
      // error.
      const rejected: string[] = [];
      const oneOf = (field: string, v: unknown, allowed: readonly string[]): string | null => {
        if (v === undefined || v === null) return null;
        if (typeof v === 'string' && allowed.includes(v)) return v;
        rejected.push(field);
        return null;
      };
      const oneOfNumber = (field: string, v: unknown, allowed: readonly number[]): number | null => {
        if (v === undefined || v === null) return null;
        if (typeof v === 'number' && allowed.includes(v)) return v;
        rejected.push(field);
        return null;
      };
      const positiveInteger = (field: string, v: unknown, maximum: number): number | null => {
        if (v === undefined || v === null) return null;
        if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= maximum) return v;
        rejected.push(field);
        return null;
      };
      const extensions = (value: unknown): string[] | null => {
        if (value === undefined || value === null) return null;
        if (!Array.isArray(value)) { rejected.push('allowedExtensions'); return null; }
        const normalized = value.map((v) => typeof v === 'string'
          ? v.trim().toLowerCase().replace(/^\.+/, '')
          : '');
        if (!normalized.length || normalized.some((v) => !/^[a-z0-9]{1,12}$/.test(v))) {
          rejected.push('allowedExtensions');
          return null;
        }
        return [...new Set(normalized)];
      };

      const historyMode = oneOf('historyMode', b.historyMode, ['disabled', 'one', 'two']);
      const historyKind = oneOf('historyKind', b.historyKind, ['snapshot', 'recovery_copy']);
      const auditRetention = oneOf('auditRetention', b.auditRetention, ['30d', '90d', 'one_year', 'forever']);
      const scanMode = oneOf('clamavScanMode', b.clamavScanMode, ['on_index', 'on_change']);
      const recycleDays = oneOfNumber('recycleBinDays', b.recycleBinDays, [7, 30, 90]);
      const syncMinutes = oneOfNumber('cloudSyncMinutes', b.cloudSyncMinutes, [5, 15, 30, 60]);
      const maxFileBytes = positiveInteger('maxFileBytes', b.maxFileBytes, 10 * 1024 * 1024 * 1024);
      const maxTotalBytesPerUser = positiveInteger('maxTotalBytesPerUser', b.maxTotalBytesPerUser, 100 * 1024 * 1024 * 1024);
      const maxFilesPerUser = positiveInteger('maxFilesPerUser', b.maxFilesPerUser, 1_000_000);
      const allowedExtensions = extensions(b.allowedExtensions);
      const archiveMaxEntries = positiveInteger('archiveMaxEntries', b.archiveMaxEntries, 100_000);
      const archiveMaxTotalBytes = positiveInteger('archiveMaxTotalBytes', b.archiveMaxTotalBytes, 10 * 1024 * 1024 * 1024);
      const archiveMaxDepth = positiveInteger('archiveMaxDepth', b.archiveMaxDepth, 3);
      const archiveMaxSeconds = positiveInteger('archiveMaxSeconds', b.archiveMaxSeconds, 3600);

      if (rejected.length) {
        return res.status(400).json({
          error: 'those settings are not values Josi recognises, so nothing was changed',
          rejected,
        });
      }

      const [policy] = await db.query<StoragePolicyRow>(
        `update storage_policy set
           history_mode = coalesce($1, history_mode),
           history_kind = coalesce($2, history_kind),
           recycle_bin_days = coalesce($3, recycle_bin_days),
           audit_retention = coalesce($4, audit_retention),
           clamav_enabled = coalesce($5, clamav_enabled),
           clamav_scan_mode = coalesce($6, clamav_scan_mode),
           clamav_auto_update = coalesce($7, clamav_auto_update),
           ocr_enabled = coalesce($8, ocr_enabled),
           semantic_enabled = coalesce($9, semantic_enabled),
           sharing_enabled = coalesce($10, sharing_enabled),
           workspace_sharing_enabled = coalesce($11, workspace_sharing_enabled),
           archives_enabled = coalesce($12, archives_enabled),
           manual_sync_enabled = coalesce($13, manual_sync_enabled),
           cloud_sync_minutes = coalesce($14, cloud_sync_minutes),
           max_file_bytes = coalesce($15, max_file_bytes),
           max_total_bytes_per_user = coalesce($16, max_total_bytes_per_user),
           max_files_per_user = coalesce($17, max_files_per_user),
           allowed_extensions = coalesce($18, allowed_extensions),
           archive_max_entries = coalesce($19, archive_max_entries),
           archive_max_total_bytes = coalesce($20, archive_max_total_bytes),
           archive_max_depth = coalesce($21, archive_max_depth),
           archive_max_seconds = coalesce($22, archive_max_seconds)
         where id = true returning *`,
        [
          historyMode, historyKind, recycleDays, auditRetention,
          flag(b.clamavEnabled) ?? null, scanMode, flag(b.clamavAutoUpdate) ?? null,
          flag(b.ocrEnabled) ?? null, flag(b.semanticEnabled) ?? null,
          flag(b.sharingEnabled) ?? null, flag(b.workspaceSharingEnabled) ?? null,
          flag(b.archivesEnabled) ?? null, flag(b.manualSyncEnabled) ?? null, syncMinutes,
          maxFileBytes, maxTotalBytesPerUser, maxFilesPerUser, allowedExtensions,
          archiveMaxEntries, archiveMaxTotalBytes, archiveMaxDepth, archiveMaxSeconds,
        ],
      );
      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'storage.policy_changed',
        payload: { fields: Object.keys(b) },
      });
      return res.json({
        policy,
        // What these settings MEAN, generated from the settings themselves so
        // the wording cannot drift from the behaviour.
        historyDisclosure: historyDisclosure(policy),
        auditNotice: auditRetentionNotice(policy.audit_retention),
      });
    }),
  );


  return r;
}
