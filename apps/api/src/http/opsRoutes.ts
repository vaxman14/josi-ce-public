// Backup, update, diagnostics, telemetry and support over HTTP.
//
// Almost everything here is super-admin only, and the exception is deliberate:
// diagnostics and support tickets belong to the person raising them. M102 says
// the USER inspects the bundle and consents, so a member can create, read and
// approve their own bundle — but a bundle contains no content by construction
// (M113), so this is not a privacy hole, it is the consent flow working.
import { Router, type Request, type Response } from 'express';
import {
  LIMITS, appendEvent, asSecret, consume, deleteVaultSlot, loadMasterKey, openCredentialPayload, storeCredentialPayload,
  type Db, type Limit, type LoadOptions, type MasterKey,
} from '@josi-ce/core';
import {
  BACKUP_DIR, BackupError, DESTINATIONS, DiagnosticsError, MASTER_KEY_DOC, RestoreError,
  SupportError,
  describeDestination, encryptBackupContents, endpointHost, restoreBackup, testDestination, uploadBackup,
  TELEMETRY_DISCLOSURE, TelemetryError, acknowledgementFor, approveBundle,
  buildBundle, checkForUpdate, createBackup, describeBackup, diagnosticsRequired,
  gatewayStatus, isNewer, markInspected, passSecretScan, recordBundle,
  scanForSecrets, sendTelemetry, setTelemetry, submitTicket,
  type BackupWriter, type LogWindow, type TelemetrySender, type TicketCategory,
} from '@josi-ce/ops';
import { UnsafeEndpointError } from '@josi-ce/llm';
import { requireAuth, requireSuperAdmin } from './authz.js';
import { constants, existsSync } from 'node:fs';
import { access, open, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { normalize } from 'node:path';
import { asyncRoute, param } from './async.js';
import type { NasController } from './nasController.js';

export interface OpsRoutesCtx {
  db: Db;
  /** Needed to seal and open the backup destination's credential. */
  masterKey?: LoadOptions | false;
  /** Injected by the suites so no test reaches a real bucket. */
  destinationFetch?: typeof fetch;
  /** Injected. No test writes a real archive or contacts a real endpoint. */
  backupWriter?: BackupWriter;
  restoreReader?: import('@josi-ce/ops').RestoreReader;
  telemetrySender?: TelemetrySender;
  /** M115: unset by default. Nothing is transmitted without it. */
  supportGatewayUrl?: string | null;
  fetchLatestVersion?: () => Promise<string | null>;
  /** Injected by the tests so no suite resolves a hostname. */
  outboundResolve?: (hostname: string) => Promise<string[]>;
  nasController?: NasController | null;
}

/** The destination row as stored. `credentials_enc` is selected only by the
 * routes that must open it, and is never part of a response. */
interface DestinationRow {
  kind: 's3' | 'r2' | 'b2' | 'nas';
  label: string;
  bucket: string;
  region: string;
  account_id: string | null;
  endpoint: string | null;
  object_prefix: string;
  credentials_enc?: string | null;
  api_key_present?: boolean;
  last_check_at: string | null;
  last_check_ok: boolean | null;
  last_check_error: string | null;
  share_protocol?: 'smb' | 'nfs' | null;
  share_host?: string | null;
  share_name?: string | null;
  encryption_enabled?: boolean;
  encryption_key_ref?: string | null;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The master key, or a 503 that says what an operator can do about it.
 *
 * A backup destination credential cannot be stored without it, and storing one
 * in the clear instead is not a fallback worth having. */
function requireDestinationKey(ctx: OpsRoutesCtx): MasterKey {
  if (ctx.masterKey === false) throw new RouteError(503, 'this installation cannot store secrets right now');
  try {
    return loadMasterKey(ctx.masterKey ?? {});
  } catch {
    // The loader's message names a filesystem path. The operator gets the
    // actionable half without it.
    throw new RouteError(
      503,
      'the installation master key is missing or unusable, so nothing can be saved securely.',
    );
  }
}

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return asyncRoute(async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err: unknown) {
      if (err instanceof RouteError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      if (err instanceof SupportError || err instanceof DiagnosticsError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof UnsafeEndpointError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof TelemetryError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof BackupError || err instanceof RestoreError) {
        // A category, never the underlying message: an archive error quotes
        // paths and a database error quotes configuration.
        res.status(500).json({ error: 'that could not be completed', category: err.category });
        return;
      }
      throw err;
    }
  });
}

export function opsRoutes(ctx: OpsRoutesCtx): Router {
  const { db } = ctx;
  const r = Router();
  r.use(requireAuth);

  /** Spend one from this person's allowance, or refuse with a Retry-After.
   *
   * Per user, never global: a shared counter on a small server means one person
   * looping denies the feature to everybody, which is the outage the limit
   * exists to prevent. */
  const limited = async (req: Request, res: Response, limit: Limit): Promise<boolean> => {
    const verdict = await consume(db, { limit, subject: `${limit.bucket}:${req.user!.id}` });
    if (!verdict.ok) {
      res.set('Retry-After', String(verdict.retryAfterSeconds));
      res.status(429).json({
        error: 'that has been done too many times recently',
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
      return false;
    }
    return true;
  };

  // -------------------------------------------------------------------------
  // Diagnostics and support: the person raising them owns them.
  // -------------------------------------------------------------------------

  /** M112: what windows exist, and what a bundle will contain. Shown before
   * anything is built, so nobody consents to a description they never saw. */
  r.get(
    '/diagnostics/options',
    handle(async (_req, res) => res.json({
      windows: ['1h', '24h', '7d'],
      defaultWindow: '24h',
      maxBytes: 25 * 1024 * 1024,
      includes: [
        'The Josi version', 'Whether each container is running and how often it restarted',
        'CPU, memory and free disk', 'Which settings are configured — never their values',
        'Which database migrations have run', 'Recent log lines, with secrets removed',
        'Counts of users, conversations and documents',
      ],
      excludes: [
        'Messages, emails, calendar entries and contacts',
        'Documents and their extracted text', 'Prompts and assistant replies',
        'Database rows', 'Passwords, API keys and tokens',
      ],
      note: 'You will be shown the whole bundle before anything is sent, and you can cancel.',
    })),
  );

  r.post(
    '/diagnostics',
    handle(async (req, res) => {
      // Building one reads config, counts rows and compresses. Cheap once,
      // expensive in a loop.
      if (!(await limited(req, res, LIMITS.diagnostics))) return undefined;
      const window = (['1h', '24h', '7d'].includes(str(req.body?.window, 8))
        ? req.body.window : '24h') as LogWindow;

      // Facts about the installation. Nothing here reads a content table — the
      // builder can only render the sections it knows, which is M113 made
      // structural rather than filtered.
      const [{ users }] = await db.query<{ users: number }>(
        `select count(*)::int as users from users where status = 'active'`,
      );
      const [{ threads }] = await db.query<{ threads: number }>(
        `select count(*)::int as threads from threads`,
      );
      const [{ documents }] = await db.query<{ documents: number }>(
        `select count(*)::int as documents from documents`,
      );
      const [smtp] = await db.query<{ n: number }>(
        `select count(*)::int as n from smtp_profiles`,
      );
      const [policy] = await db.query<{ clamav_enabled: boolean; ocr_enabled: boolean }>(
        `select clamav_enabled, ocr_enabled from storage_policy where id = true`,
      );
      // Custom API connections, as COUNTS. How many are defined, how many the
      // assistant can actually reach, and how many individual actions are
      // switched on — which is the number a supporter needs when somebody
      // reports "Josi called our CRM" or "Josi will not call our CRM". Never a
      // name, never a host, never a credential: a host is somebody's internal
      // service and a bundle goes to a third party's ticket system.
      const [customApis] = await db.query<{ total: number; live: number }>(
        `select count(*)::int as total,
                count(*) filter (where enabled)::int as live
           from custom_api_connections`,
      );
      const [customApiActions] = await db.query<{ live: number }>(
        `select count(*)::int as live
           from custom_api_endpoints e join custom_api_connections c on c.id = e.connection_id
          where e.enabled and c.enabled`,
      );

      const built = buildBundle({
        version: process.env.JOSI_VERSION ?? '0.1.0',
        containers: [],
        resources: {
          cpuCount: (await import('node:os')).cpus().length,
          memoryBytes: (await import('node:os')).totalmem(),
          diskFreeBytes: 0,
        },
        configStatus: {
          smtp: (smtp?.n ?? 0) > 0,
          clamav: policy?.clamav_enabled ?? false,
          ocr: policy?.ocr_enabled ?? false,
          // WHETHER, never which. A boolean answers "could this installation
          // have called an outside API?" without naming one.
          custom_apis: (customApis?.live ?? 0) > 0,
        },
        migrations: [],
        logs: [],
        counts: {
          users, threads, documents,
          custom_apis: customApis?.total ?? 0,
          custom_apis_enabled: customApis?.live ?? 0,
          custom_api_actions_enabled: customApiActions?.live ?? 0,
        },
      });

      const { id } = await recordBundle(db, {
        createdBy: req.user!.id, window, filename: `diagnostics-${Date.now()}.txt`, built,
      });
      return res.status(201).json({
        id, byteSize: built.byteSize, redactions: built.redactions, trimmed: built.trimmed,
      });
    }),
  );

  /** Reading the bundle IS the inspection step. Fetching it records that. */
  r.get(
    '/diagnostics/:id',
    handle(async (req, res) => {
      const id = param(req, 'id');
      const [row] = await db.query<{ created_by: string; byte_size: number }>(
        `select created_by, byte_size from diagnostic_bundles where id = $1`, [id],
      );
      // 404, not 403 — somebody else's bundle is not theirs to know exists.
      if (!row || row.created_by !== req.user!.id) throw new RouteError(404, 'not found');
      await markInspected(db, id);
      return res.json({ id, byteSize: row.byte_size, inspected: true });
    }),
  );

  r.post(
    '/diagnostics/:id/approve',
    handle(async (req, res) => {
      const id = param(req, 'id');
      const [row] = await db.query<{ created_by: string }>(
        `select created_by from diagnostic_bundles where id = $1`, [id],
      );
      if (!row || row.created_by !== req.user!.id) throw new RouteError(404, 'not found');
      await approveBundle(db, { bundleId: id, userId: req.user!.id });
      const scan = await passSecretScan(db, { bundleId: id, text: str(req.body?.text, 1_000_000) });
      return res.json({ approved: true, scan });
    }),
  );

  r.get(
    '/support/options',
    handle(async (_req, res) => res.json({
      categories: (['bug_report', 'feature_request', 'paid_support', 'security_privacy'] as TicketCategory[])
        .map((c) => ({
          category: c,
          diagnosticsRequired: diagnosticsRequired(c),
          acknowledgement: acknowledgementFor(c),
        })),
      gateway: gatewayStatus(ctx.supportGatewayUrl ?? null),
    })),
  );

  r.post(
    '/support/tickets',
    handle(async (req, res) => {
      const category = str(req.body?.category, 32) as TicketCategory;
      if (!['bug_report', 'feature_request', 'paid_support', 'security_privacy'].includes(category)) {
        throw new RouteError(400, 'choose one of the listed categories');
      }
      const description = str(req.body?.description, 8000);
      if (!description) throw new RouteError(400, 'describe the problem');

      const [row] = await db.query<{ id: string }>(
        `insert into support_tickets
           (created_by, category, description, acknowledged_no_guarantee, bundle_id)
         values ($1, $2, $3, $4, $5) returning id`,
        [
          req.user!.id, category, description,
          req.body?.acknowledged === true,
          str(req.body?.bundleId, 64) || null,
        ],
      );
      return res.status(201).json({ id: row.id, acknowledgement: acknowledgementFor(category) });
    }),
  );

  r.post(
    '/support/tickets/:id/submit',
    handle(async (req, res) => {
      // This one leaves the installation, if a gateway is configured.
      if (!(await limited(req, res, LIMITS.support_submit))) return undefined;
      const out = await submitTicket(db, {
        ticketId: param(req, 'id'),
        userId: req.user!.id,
        gatewayUrl: ctx.supportGatewayUrl ?? null,
        resolveImpl: ctx.outboundResolve,
      });
      return res.json(out);
    }),
  );

  // -------------------------------------------------------------------------
  // Administrator.
  // -------------------------------------------------------------------------

  r.get(
    '/admin/backups',
    requireSuperAdmin,
    handle(async (_req, res) => {
      const backups = await db.query(
        `select id, kind, byte_size, state, error_category, includes_recovery_copies,
                master_key_confirmed, progress_percent, progress_phase, progress_step,
                progress_steps, created_at, completed_at
         from backups order by created_at desc limit 50`,
      );
      // The path is deployment detail and is deliberately not returned.
      return res.json({ backups, masterKeyGuidance: MASTER_KEY_DOC });
    }),
  );

  r.post(
    '/admin/backups',
    requireSuperAdmin,
    handle(async (req, res) => {
      // pg_dump against the whole database.
      if (!(await limited(req, res, LIMITS.backup))) return undefined;
      if (!ctx.backupWriter) throw new RouteError(503, 'backups are not available on this installation');
      const [active] = await db.query<{ id: string }>(
        `select id from backups where state = 'running' order by created_at desc limit 1`,
      );
      if (active) throw new RouteError(409, 'a backup is already running');
      const kind = req.body?.kind === 'portable' ? 'portable' : 'full';
      const [destination] = kind === 'full' ? await db.query<DestinationRow>(
        `select * from backup_destination where id = true`,
      ) : [];
      const { backup, description } = await createBackup(db, {
        kind,
        createdBy: req.user!.id,
        masterKeyConfirmed: req.body?.masterKeyConfirmed === true,
        writer: ctx.backupWriter,
        filename: `josi-${kind}-${Date.now()}.zip`,
        deferCompletion: kind === 'full' && destination?.last_check_ok === true,
      });
      if (kind === 'full' && destination?.last_check_ok === true) {
        try {
          const archive = await ctx.backupWriter.read(backup.stored_path);
          await db.query(`update backups set progress_percent = 70, progress_phase = 'uploading off-site copy', progress_step = 4 where id = $1`, [backup.id]);
          if (destination.kind === 'nas') {
            if (destination.encryption_enabled) {
              if (!destination.encryption_key_ref) throw new Error('backup encryption key unavailable');
              const opened = await openCredentialPayload<{ key: string }>(db, requireDestinationKey(ctx), { ownerUserId: req.user!.id, service: 'backup', slot: 'encryption', stored: destination.encryption_key_ref });
              const { writeFile } = await import('node:fs/promises');
              await writeFile(`${destination.bucket}/${backup.id}.zip.enc`, encryptBackupContents(archive, Buffer.from(opened.key, 'base64url')), { mode: 0o600 });
            } else {
              const { copyFile } = await import('node:fs/promises');
              await copyFile(backup.stored_path, `${destination.bucket}/${backup.id}.zip`);
            }
          } else if (destination.credentials_enc) {
            const credentials = await openCredentialPayload<Record<string,string>>(db, requireDestinationKey(ctx), { ownerUserId: req.user!.id, service: 'backup', slot: 'destination', stored: destination.credentials_enc });
            let encryptionKey: Buffer | undefined;
            if (destination.encryption_enabled) {
              if (!destination.encryption_key_ref) throw new Error('backup encryption key unavailable');
              const opened = await openCredentialPayload<{ key: string }>(db, requireDestinationKey(ctx), { ownerUserId: req.user!.id, service: 'backup', slot: 'encryption', stored: destination.encryption_key_ref });
              encryptionKey = Buffer.from(opened.key, 'base64url');
            }
            await uploadBackup({ config: { kind: destination.kind, bucket: destination.bucket, region: destination.region, accountId: destination.account_id, endpoint: destination.endpoint, objectPrefix: destination.object_prefix }, credentials: { accessKeyId: credentials.accessKeyId ?? '', secretAccessKey: credentials.secretAccessKey ?? '', sessionToken: credentials.sessionToken ?? null }, objectKey: `${backup.id}.zip${encryptionKey ? '.enc' : ''}`, contents: archive, encryptionKey, fetchImpl: ctx.destinationFetch, resolve: ctx.outboundResolve });
          }
          await db.query(`update backups set state = 'complete', progress_percent = 100, progress_phase = 'off-site copy verified', progress_step = progress_steps, completed_at = now() where id = $1`, [backup.id]);
          await appendEvent(db, { actorUserId: req.user!.id, actor: 'super_admin', kind: 'backup.created', subjectType: 'backup', subjectId: backup.id, payload: { kind, byteSize: backup.byte_size, offsite: destination.kind } });
        } catch {
          await db.query(`update backups set state = 'failed', error_category = 'unknown', progress_phase = 'off-site copy failed', completed_at = now() where id = $1`, [backup.id]);
          throw new BackupError('the off-site copy could not be verified');
        }
      }
      return res.status(201).json({
        backup: {
          id: backup.id, kind: backup.kind, byteSize: backup.byte_size,
          state: kind === 'full' && destination?.last_check_ok === true ? 'complete' : backup.state,
          includesRecoveryCopies: backup.includes_recovery_copies,
        },
        description,
      });
    }),
  );

  /** The archive itself.
   *
   * Creating an export and listing it are not the feature; retrieving it is.
   * Without this route a row reading "Portable export - Ready" described a file
   * on a volume inside the container, which an operator has no way to reach —
   * the export existed and was, in every practical sense, unavailable.
   *
   * Four things this must get right, and each has a failure it prevents:
   *
   *   - Authorization is enforced HERE, not by the row being hidden. The id is
   *     a uuid, but an unguessable name is not an access control.
   *   - A backup that is not complete is not offered. Sending a partially
   *     written archive would produce a file that restores into a half
   *     installation.
   *   - The stored path is never returned or accepted. It is deployment detail,
   *     and a client-supplied path is a file-read primitive.
   *   - A row whose file has gone says so with 410, distinct from 404 for a
   *     row that never existed. "It is not there any more" and "there is no
   *     such export" are different facts and an operator acts on them
   *     differently.
   */
  r.get(
    '/admin/backups/:id/download',
    requireSuperAdmin,
    handle(async (req, res) => {
      if (!ctx.backupWriter) throw new RouteError(503, 'backups are not available on this installation');
      const id = param(req, 'id');
      // Checked before it reaches the database. A backup id is a uuid, and
      // anything else — a path, a wildcard — is simply not one, so it gets the
      // same answer as any other id naming no backup. Handing it to Postgres
      // instead turns a malformed request into a 500 carrying a database error.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new RouteError(404, 'no such backup');
      }
      const [row] = await db.query<{
        id: string; kind: string; state: string; stored_path: string;
        byte_size: string | number; created_at: string;
      }>(
        `select id, kind, state, stored_path, byte_size, created_at from backups where id = $1`,
        [id],
      );
      if (!row) throw new RouteError(404, 'no such backup');
      if (row.state !== 'complete') {
        throw new RouteError(
          409,
          row.state === 'failed'
            ? 'that backup did not finish, so there is no archive to download'
            : 'that backup is still being written',
        );
      }

      let archive: Buffer;
      try {
        archive = await ctx.backupWriter.read(row.stored_path);
      } catch {
        // The row outlived the file: a volume that was replaced, a manual
        // deletion, a restored-from-scratch installation. Saying "not found"
        // would suggest the operator misread the list.
        throw new RouteError(
          410,
          'the archive for that backup is no longer on this server. Take a new one — the '
          + 'record remains so you can see when the old one was made.',
        );
      }

      // Named for the person receiving it rather than for the filesystem: what
      // it is, which installation date it belongs to, and an extension their
      // operating system will honour.
      const stamp = new Date(row.created_at).toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const filename = `josi-${row.kind}-${stamp}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(archive.byteLength));
      // `attachment` so a browser saves it instead of trying to render it, and
      // the name quoted because it contains no quotes by construction.
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // An archive of an installation's data must never sit in a shared cache.
      res.setHeader('Cache-Control', 'no-store');
      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'backup.downloaded',
        payload: { backupId: row.id, kind: row.kind },
      });
      return res.status(200).end(archive);
    }),
  );

  // ------------------------------------------------------------ destination
  //
  // Sending a backup anywhere but this container's own volume used to mean
  // editing compose files and mounting host secret files named by a prefix the
  // form called `primary` and never explained. That is a deployment procedure
  // wearing a settings form, and it put the one thing that saves an
  // installation behind the one skill most operators do not have.

  /** The catalogue, the current destination, and what the last test proved.
   *
   * The credential is never returned in any form — not the secret, not the key
   * id, not a masked version of either. `credentialsSet` is the only fact about
   * it a screen needs. */
  r.get(
    '/admin/backups/destination',
    requireSuperAdmin,
    handle(async (_req, res) => {
      const [row] = await db.query<DestinationRow>(
        `select kind, label, bucket, region, account_id, endpoint, object_prefix,
                share_protocol, share_host, share_name, encryption_enabled,
                api_key_present, last_check_at, last_check_ok, last_check_error
         from (
           select *, (credentials_enc is not null) as api_key_present
           from backup_destination where id = true
         ) d`,
      );
      return res.json({
        // Field definitions travel with the page so the form cannot draw a
        // provider this build would refuse, exactly as the model catalogue does.
        catalog: DESTINATIONS.map((d) => ({
          kind: d.kind,
          label: d.label,
          credentialsHelp: d.credentialsHelp,
          docsUrl: d.docsUrl,
          fields: d.fields.map((f) => ({
            key: f.key,
            label: f.label,
            secret: f.secret,
            required: f.required,
            placeholder: f.placeholder ?? null,
            help: f.help ?? null,
          })),
        })),
        destination: row
          ? {
              kind: row.kind,
              label: row.label,
              bucket: row.bucket,
              region: row.region,
              accountId: row.account_id,
              endpoint: row.endpoint,
              objectPrefix: row.object_prefix,
              shareProtocol: row.share_protocol,
              shareHost: row.share_host,
              shareName: row.share_name,
              encryptionEnabled: row.encryption_enabled,
              credentialsSet: row.api_key_present,
              // Where the archives actually go, assembled from the stored
              // fields. An operator checking their bucket should not have to
              // reconstruct this from three inputs.
              resolvedEndpoint: row.kind === 'nas' ? row.bucket : `https://${endpointHost({
                kind: row.kind,
                bucket: row.bucket,
                region: row.region,
                accountId: row.account_id,
                endpoint: row.endpoint,
              })}`,
              lastCheckAt: row.last_check_at,
              lastCheckOk: row.last_check_ok,
              lastCheckError: row.last_check_error,
            }
          : null,
        // The volume is always there and is what an installation falls back to.
        // Saying so is the difference between "no destination" and "backups are
        // not being kept".
        localPath: BACKUP_DIR,
      });
    }),
  );

  r.post(
    '/admin/backups/destination/nas/browse',
    requireSuperAdmin,
    handle(async (req, res) => {
      if (!ctx.nasController) throw new RouteError(503, 'the restricted storage controller is unavailable');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const host = str(body.shareHost, 253);
      const share = str(body.shareName, 255);
      if (!host || !share) throw new RouteError(400, 'enter the NAS address and share name');
      const folders = await ctx.nasController.browse({
        protocol: body.shareProtocol === 'nfs' ? 'nfs' : 'smb',
        host,
        share,
        username: str(body.username, 255),
        password: str(body.password, 1000),
        readOnly: true,
      });
      return res.json({ folders });
    }),
  );

  /** Store a destination.
   *
   * Saving ALWAYS clears the last test result. A credential that has not been
   * tried against the bucket it was just pointed at has established nothing,
   * and carrying the previous green tick across would be the screen vouching
   * for a configuration nobody has checked. */
  r.put(
    '/admin/backups/destination',
    requireSuperAdmin,
    handle(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const kind = str(body.kind, 16);
      const descriptor = describeDestination(kind);
      if (!descriptor) throw new RouteError(400, 'choose where backups should be stored');
      const existing = await db.query<{ kind: string; credentials_enc: string | null; encryption_key_ref: string | null }>(
        `select kind, credentials_enc, encryption_key_ref from backup_destination where id = true`,
      );
      const previous = existing[0] ?? null;

      let bucket = str(body.bucket, 255);
      if (!bucket && kind !== 'nas') throw new RouteError(400, 'a bucket name is required');
      if (kind === 'nas') {
        const protocol = body.shareProtocol === 'nfs' ? 'nfs' : 'smb';
        const host = str(body.shareHost, 253);
        const share = str(body.shareName, 255);
        if (!host || !share) throw new RouteError(400, 'enter the NAS address and share name');
        if (!ctx.nasController) throw new RouteError(503, 'the restricted storage controller is unavailable');
        const mounted = await ctx.nasController.configure({ protocol, host, share, folder: str(body.folder, 500), username: str(body.username, 255), password: str(body.password, 1000), readOnly: false });
        bucket = mounted.mountedPath;
      }
      const accountId = str(body.accountId, 128) || null;
      if (kind === 'r2' && !accountId) {
        throw new RouteError(400, 'Cloudflare R2 needs the account ID from your R2 endpoint');
      }
      // R2 signs as `auto` and has no regions of its own to ask for.
      const region = kind === 'r2' ? 'auto' : kind === 'nas' ? 'local' : str(body.region, 64);
      if (!region) throw new RouteError(400, 'a region is required');

      const endpoint = str(body.endpoint, 500) || null;
      if (endpoint) {
        if (kind !== 's3') {
          throw new RouteError(400, 'only Amazon S3 takes a custom endpoint on this form');
        }
        let parsed: URL;
        try {
          parsed = new URL(endpoint);
        } catch {
          throw new RouteError(400, 'that endpoint is not a valid URL');
        }
        // A backup destination receives everything this installation holds, so
        // it goes over TLS or it does not go.
        if (parsed.protocol !== 'https:') throw new RouteError(400, 'the endpoint must be https');
      }

      const accessKeyId = asSecret(body.accessKeyId);
      const secretAccessKey = asSecret(body.secretAccessKey);
      const sessionToken = asSecret(body.sessionToken);
      const supplied = Object.entries({ accessKeyId, secretAccessKey, sessionToken })
        .filter(([, value]) => !value.isEmpty);

      // Blank fields on an edit mean "leave the credential alone" — but only
      // while the destination still points at the same vendor. An R2 token is
      // not an AWS key, so changing kind means entering the credential again
      // rather than silently carrying the old one to a new endpoint.
      const sameKind = previous?.kind === kind;
      let sealed: string | null;
      if (kind === 'nas') {
        const username = asSecret(body.username);
        const password = asSecret(body.password);
        if (!username.isEmpty || !password.isEmpty) {
          sealed = await storeCredentialPayload(db, requireDestinationKey(ctx), { ownerUserId: req.user!.id, kind: 'password', service: 'backup', slot: 'destination', label: 'NAS backup credentials', payload: { username: username.reveal(), password: password.reveal() }, actorUserId: req.user!.id });
        } else if (sameKind && previous?.credentials_enc) {
          sealed = previous.credentials_enc;
        } else {
          sealed = null; // NFS and guest SMB legitimately have no credential.
        }
      } else if (supplied.length) {
        sealed = await storeCredentialPayload(db,requireDestinationKey(ctx),{ownerUserId:req.user!.id,kind:'api_key',service:'backup',slot:'destination',label:`${descriptor.label} backup credentials`,payload:Object.fromEntries(supplied),actorUserId:req.user!.id});
      } else if (sameKind && previous?.credentials_enc) {
        sealed = previous.credentials_enc;
      } else {
        throw new RouteError(
          400,
          `this destination needs ${descriptor.fields
            .filter((f) => f.secret && f.required)
            .map((f) => f.label)
            .join(' and ')}`,
        );
      }

      // Older API clients did not send this field. The current UI sends an
      // explicit true by default; omission remains compatible with those
      // clients instead of unexpectedly creating a recovery key mid-edit.
      const encryptionEnabled = body.encryptionEnabled === true;
      let recoveryKey: string | null = null;
      let encryptionKeyRef = previous?.encryption_key_ref ?? null;
      if (encryptionEnabled) {
        if (!encryptionKeyRef) {
          recoveryKey = randomBytes(32).toString('base64url');
          encryptionKeyRef = await storeCredentialPayload(db, requireDestinationKey(ctx), { ownerUserId: req.user!.id, kind: 'api_key', service: 'backup', slot: 'encryption', label: 'Backup encryption key', payload: { key: recoveryKey }, actorUserId: req.user!.id });
        }
      }

      // Moving away from a NAS destination must also remove the privileged
      // Docker mount. Keeping an unused share attached would preserve host
      // access the administrator explicitly removed from Josi.
      if (previous?.kind === 'nas' && kind !== 'nas') {
        if (!ctx.nasController) throw new RouteError(503, 'the restricted storage controller is unavailable');
        await ctx.nasController.remove();
      }

      await db.query(
        `insert into backup_destination
           (id, kind, label, bucket, region, account_id, endpoint, object_prefix, credentials_enc,
            share_protocol, share_host, share_name, encryption_enabled, encryption_key_ref,
            last_check_at, last_check_ok, last_check_error, updated_at)
         values (true, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, null, null, null, now())
         on conflict (id) do update set
           kind = excluded.kind, label = excluded.label, bucket = excluded.bucket,
           region = excluded.region, account_id = excluded.account_id,
           endpoint = excluded.endpoint, object_prefix = excluded.object_prefix,
           credentials_enc = excluded.credentials_enc,
           share_protocol = excluded.share_protocol, share_host = excluded.share_host,
           share_name = excluded.share_name, encryption_enabled = excluded.encryption_enabled,
           encryption_key_ref = excluded.encryption_key_ref,
           last_check_at = null, last_check_ok = null, last_check_error = null,
           updated_at = now()`,
        [
          kind,
          str(body.label, 120),
          bucket,
          region,
          accountId,
          endpoint,
          str(body.objectPrefix, 200),
          sealed,
          kind === 'nas' ? (body.shareProtocol === 'nfs' ? 'nfs' : 'smb') : null,
          kind === 'nas' ? str(body.shareHost, 253) : null,
          kind === 'nas' ? str(body.shareName, 255) : null,
          encryptionEnabled,
          encryptionEnabled ? encryptionKeyRef : null,
        ],
      );

      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'backup.destination_configured',
        // Where it points is configuration. The credential is not recorded in
        // any form, not even as a hash.
        payload: { kind, bucket, region },
      });
      return res.status(200).json({ ok: true, needsTest: true, recoveryKey });
    }),
  );

  /** Ask the bucket a real question with the stored credential.
   *
   * Listing one object rather than probing the host: it proves the endpoint
   * resolves, the signature verifies AND this credential may actually use this
   * bucket. A reachability check would call a destination working when the
   * first real backup would fail. */
  r.post(
    '/admin/backups/destination/test',
    requireSuperAdmin,
    handle(async (req, res) => {
      const [row] = await db.query<DestinationRow>(
        `select kind, label, bucket, region, account_id, endpoint, object_prefix,
                credentials_enc, last_check_at, last_check_ok, last_check_error
         from backup_destination where id = true`,
      );
      if (!row || (row.kind !== 'nas' && !row.credentials_enc)) {
        throw new RouteError(400, 'no backup destination has been configured yet');
      }

      if (row.kind === 'nas') {
        const path = normalize(row.bucket);
        let result: { ok: boolean; detail: string };
        try {
          await access(path, constants.R_OK | constants.W_OK);
          const probe = `${path}/.josi-write-test-${randomUUID()}`;
          const file = await open(probe, 'wx', 0o600);
          await file.close();
          await rm(probe);
          result = { ok: true, detail: 'Josi can read and write this mounted network share.' };
        } catch {
          result = { ok: false, detail: 'Josi cannot read and write that mounted path. Check the mount and its permissions.' };
        }
        await db.query(`update backup_destination set last_check_at = now(), last_check_ok = $1, last_check_error = $2 where id = true`, [result.ok, result.ok ? null : result.detail]);
        return res.json({ ...result, category: result.ok ? null : 'permission' });
      }

      const opened = await openCredentialPayload<Record<string,string>>(db,requireDestinationKey(ctx),{ownerUserId:req.user!.id,service:'backup',slot:'destination',stored:row.credentials_enc!});
      const result = await testDestination({
        config: {
          kind: row.kind,
          bucket: row.bucket,
          region: row.region,
          accountId: row.account_id,
          endpoint: row.endpoint,
        },
        credentials: {
          accessKeyId: opened.accessKeyId ?? '',
          secretAccessKey: opened.secretAccessKey ?? '',
          sessionToken: opened.sessionToken ?? null,
        },
        fetchImpl: ctx.destinationFetch,
        resolve: ctx.outboundResolve,
      });

      // Recorded either way. A destination whose last test failed must keep
      // saying so until somebody fixes it.
      await db.query(
        `update backup_destination
         set last_check_at = now(), last_check_ok = $1, last_check_error = $2
         where id = true`,
        [result.ok, result.ok ? null : result.detail],
      );
      return res.json({
        ok: result.ok,
        category: result.category ?? null,
        detail: result.detail,
      });
    }),
  );

  /** Stop sending backups off this machine.
   *
   * The credential goes with the row. Leaving it behind "in case they come
   * back" would keep a live cloud credential in the database for a feature the
   * operator has switched off. */
  r.delete(
    '/admin/backups/destination',
    requireSuperAdmin,
    handle(async (req, res) => {
      const [existing] = await db.query<{ kind: string }>(`select kind from backup_destination where id = true`);
      if (existing?.kind === 'nas') await ctx.nasController?.remove();
      await db.query(`delete from backup_destination where id = true`);
      await deleteVaultSlot(db,{ownerUserId:req.user!.id,service:'backup',slot:'destination',actorUserId:req.user!.id});
      await deleteVaultSlot(db,{ownerUserId:req.user!.id,service:'backup',slot:'encryption',actorUserId:req.user!.id});
      await appendEvent(db, {
        actorUserId: req.user!.id, actor: 'super_admin', kind: 'backup.destination_removed',
      });
      return res.status(204).end();
    }),
  );

  /** What you would be told before restoring, without restoring. */
  r.get(
    '/admin/restore/preflight',
    requireSuperAdmin,
    handle(async (_req, res) => res.json({
      masterKeyPresent: !!process.env.MASTER_KEY_FILE,
      guidance: MASTER_KEY_DOC,
      warning: describeBackup('full', false),
    })),
  );

  /** The acceptance criterion, reachable.
   *
   * A restore is destructive and irreversible, so it takes an explicit
   * confirmation rather than a bare POST — and it reports what came back
   * SEPARATELY from whether it succeeded, because "restored" and "your
   * credentials work" are different facts and conflating them is how an
   * operator discovers the difference weeks later.
   */
  r.post(
    '/admin/restore',
    requireSuperAdmin,
    handle(async (req, res) => {
      if (!ctx.restoreReader || !ctx.backupWriter) {
        throw new RouteError(503, 'restore is not available on this installation');
      }
      if (req.body?.confirm !== 'restore') {
        throw new RouteError(400, 'confirm the restore — this replaces the current database');
      }

      const backupId = str(req.body?.backupId, 64) || null;
      if (!backupId) throw new RouteError(400, 'name the backup to restore');
      const [row] = await db.query<{ stored_path: string; state: string }>(
        `select stored_path, state from backups where id = $1`, [backupId],
      );
      if (!row || row.state !== 'complete') throw new RouteError(404, 'no such completed backup');

      const archive = await ctx.backupWriter.read(row.stored_path);
      // Whether the key is mounted is a property of the deployment, read here
      // rather than assumed, so the answer reflects this container.
      const masterKeyPresent = !!process.env.MASTER_KEY_FILE
        && existsSync(process.env.MASTER_KEY_FILE);

      const out = await restoreBackup(db, {
        backupId, archive, masterKeyPresent, reader: ctx.restoreReader,
      });
      return res.json(out);
    }),
  );

  r.get(
    '/admin/update',
    requireSuperAdmin,
    handle(async (_req, res) => {
      const [state] = await db.query<{
        current_version: string; available_version: string | null;
        last_check_at: string | null; last_check_ok: boolean | null;
      }>(`select current_version, available_version, last_check_at, last_check_ok
          from update_state where id = true`);
      return res.json({
        ...state,
        updateAvailable: !!state?.available_version
          && isNewer(state.available_version, state.current_version),
        // Said explicitly, because it is a property people assume the other way.
        automatic: false,
        note: 'Josi never updates itself. Nothing changes until you approve it, and a '
          + 'backup is taken before anything is applied.',
      });
    }),
  );

  r.post(
    '/admin/update/check',
    requireSuperAdmin,
    handle(async (_req, res) => {
      const out = await checkForUpdate(db, {
        fetchLatest: ctx.fetchLatestVersion ?? (async () => null),
      });
      return res.json({
        ...out,
        updateAvailable: !!out.available && isNewer(out.available, out.current),
      });
    }),
  );

  r.get(
    '/admin/telemetry',
    requireSuperAdmin,
    handle(async (_req, res) => {
      const [state] = await db.query<{
        enabled: boolean; last_sent_at: string | null; last_status: string | null;
        last_payload: unknown;
      }>(`select enabled, last_sent_at, last_status, last_payload from telemetry_state where id = true`);
      return res.json({
        ...state,
        disclosure: TELEMETRY_DISCLOSURE,
        // The exact JSON that last left, so this can be checked rather than
        // believed.
        lastPayload: state?.last_payload ?? null,
      });
    }),
  );

  r.put(
    '/admin/telemetry',
    requireSuperAdmin,
    handle(async (req, res) => {
      const enabled = req.body?.enabled === true;
      await setTelemetry(db, {
        enabled,
        endpoint: str(req.body?.endpoint, 500) || null,
        byUserId: req.user!.id,
        resolveImpl: ctx.outboundResolve,
      });
      return res.json({ enabled, disclosure: TELEMETRY_DISCLOSURE });
    }),
  );

  r.post(
    '/admin/telemetry/send',
    requireSuperAdmin,
    handle(async (_req, res) => {
      if (!ctx.telemetrySender) return res.json({ sent: false, reason: 'no sender configured' });
      const [{ id }] = await db.query<{ id: string }>(
        `select installation_id as id from workspace limit 1`,
      ).catch(() => [{ id: '00000000-0000-4000-8000-000000000000' }]);
      const out = await sendTelemetry(db, {
        facts: { installationId: id, version: process.env.JOSI_VERSION ?? '0.1.0' },
        sender: ctx.telemetrySender,
        resolveImpl: ctx.outboundResolve,
      });
      return res.json(out);
    }),
  );

  return r;
}

export { scanForSecrets };
