// The HTTP surface, assembled in one place so the guard order is visible.
//
// Order matters and is deliberate:
//   json body  ->  attachUser  ->  CSRF  ->  routes
// CSRF runs after the session is attached (so a rejection can be audited with a
// user) but before any handler, so no state-changing code path can be reached
// without a matching token.
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { checkReadiness, type Db, type LoadOptions } from '@josi-ce/core';
import { probeAttachmentStorage } from '@josi-ce/storage';
import { attachUser } from './http/authz.js';
import { requireCsrf } from './http/cookies.js';
import { authRoutes } from './http/authRoutes.js';
import { adminRoutes } from './http/adminRoutes.js';
import { checklistRoutes } from './http/checklistRoutes.js';
import { adminConnectionRoutes, connectionRoutes } from './http/connectionRoutes.js';
import { contactSyncRoutes } from './http/contactSyncRoutes.js';
import { adminConnectorRoutes, connectorRoutes } from './http/connectorRoutes.js';
import { calendarRoutes } from './http/calendarRoutes.js';
import { adminMailRoutes, mailRoutes } from './http/mailRoutes.js';
import { localWorkspaceRoutes } from './http/localWorkspaceRoutes.js';
import { storageRoutes } from './http/storageRoutes.js';
import { opsRoutes } from './http/opsRoutes.js';
import { licenceRoutes } from './http/licenceRoutes.js';
import { adminParentalRoutes, parentalRoutes } from './http/parentalRoutes.js';
import {
  adminDeveloperServiceRoutes, developerServiceRoutes,
} from './http/developerServiceRoutes.js';
import { adminCustomApiRoutes, customApiRoutes } from './http/customApiRoutes.js';
import { personaRoutes } from './http/personaRoutes.js';
import { migrationRoutes } from './http/migrationRoutes.js';
import { adminLlmRoutes, llmRoutes } from './http/llmRoutes.js';
import { adminAssistantRoutes, assistantRoutes } from './http/assistantRoutes.js';
import { adminTelegramRoutes, mountTelegramWebhook, telegramRoutes } from './http/telegramRoutes.js';
import { adminExternalChannelRoutes, externalChannelRoutes, mountExternalChannelWebhooks } from './http/externalChannelRoutes.js';
import { mountCalendarWebhook } from './http/calendarWebhook.js';
import { setupGate } from './http/setupGate.js';
import { setupRoutes } from './setup/setupRoutes.js';
import { mountWebApp } from './http/staticApp.js';
import { voiceBoxRoutes, voiceHelper, type VoiceHelper } from './http/voiceBoxRoutes.js';
import { adminVaultRoutes, vaultRoutes } from './http/vaultRoutes.js';
import { nasController } from './http/nasController.js';
import { maintenanceRoutes } from './http/maintenanceRoutes.js';
import { adminWorkflowRoutes, mountWorkflowCallbacks, workflowRoutes } from './http/workflowRoutes.js';

export interface AppConfig {
  /** Production enables a real persistent-volume readiness probe. */
  attachmentStorageRoot?: string;
  voiceBoxHelper?: VoiceHelper;
  nasController?: import('./http/nasController.js').NasController | null;
  /** https in production; false lets cookies work over plain http locally. */
  cookieSecure: boolean;
  /** Public origin, used for invite/reset links. */
  appUrl: string;
  /** Master-key options for the readiness probe, or `false` to skip the check
   * (tests, and the migration container which runs before a key exists). */
  masterKeyCheck?: LoadOptions | false;
  /** Backup-destination HTTP, injected by the suites so no test reaches a real
   * bucket. Unset in production, where the global fetch is used. */
  destinationFetch?: typeof fetch;
  /** Developer-service HTTP, injected by the suites so no test reaches GitHub,
   * Netlify, Vercel or Supabase. */
  developerServiceFetch?: typeof fetch;
  /** HTTP for administrator-defined REST integrations. */
  customApiFetch?: typeof fetch;
  /** The publisher's licence verification key. Unset in production, where the
   * key stamped into the artefact is used; injected by the suites so a test can
   * stand in for a supported build without rebuilding one. */
  licencePublicKey?: string | null;
  /** Backward-compatible test/config name used by the original complete
   * Parental Controls module. Production uses the same stamped public key. */
  entitlementPublicKey?: string | null;
  /** Provider HTTP and DNS, injected by the tests so no suite ever contacts a
   * real model provider. Unset in production, where the real ones are used. */
  llmFetch?: typeof fetch;
  llmResolve?: (hostname: string) => Promise<string[]>;
  /** Provider HTTP for connectors, injected by the tests so no suite ever
   * contacts Google or Microsoft. */
  connectorFetch?: typeof fetch;
  /** Native Sign in with Apple audience. Unset disables the endpoint and keeps
   * installations that do not own an Apple App ID from advertising it. */
  appleNativeClientId?: string | null;
  /** Apple JWKS HTTP, injected so tests never contact Apple. */
  appleFetch?: typeof fetch;
  /** SMTP, injected by the tests so no suite ever contacts a mail server. */
  mailTransport?: import('@josi-ce/mail').SmtpTransport;
  /** How a subscription provider's local binary is run, injected by the tests
   * so no suite ever executes a program. Unset in production. */
  codexRunner?: import('@josi-ce/llm').SpawnRunner;
  /** Telegram Bot API HTTP, injected by the tests so no suite ever contacts
   * api.telegram.org. Unset in production. */
  telegramFetch?: typeof fetch;
  /** Retry timing for outbound Telegram sends. Tests shorten it so a backoff
   * assertion does not spend thirty seconds asleep. */
  telegramRetry?: import('@josi-ce/channels').RetryOptions;
  /** Directory holding the built web bundle. Absent = API only. */
  webDir?: string;
  /** How backups are written. Absent = backups unavailable, which is honest on
   * an installation with no volume for them rather than failing at write time. */
  backupWriter?: import('@josi-ce/ops').BackupWriter;
  /** How a backup is applied. */
  restoreReader?: import('@josi-ce/ops').RestoreReader;
  /** Telemetry transport. Absent = nothing can be sent, whatever the setting. */
  telemetrySender?: import('@josi-ce/ops').TelemetrySender;
  /** M115: unset by default. CE ships no gateway URL and no credential. */
  supportGatewayUrl?: string | null;
  fetchLatestVersion?: () => Promise<string | null>;
  /** DNS for outbound admin-supplied URLs, injected by the tests. */
  outboundResolve?: (hostname: string) => Promise<string[]>;
  /** Hash of the browser installer's one-time first-admin handoff token. */
  setupTokenSha256?: string | null;
}

export function createApp(db: Db, cfg: AppConfig): Express {
  const app = express();

  // A request body is the only unbounded input here; 1 MB is generous for JSON
  // and small enough that a hostile client cannot exhaust memory.
  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buffer) => { (req as Request).rawBody = Buffer.from(buffer); },
  }));
  app.disable('x-powered-by');

  // Liveness: is this process up. Deliberately consults nothing — a health
  // check that fails when the database blips gets a healthy process restarted,
  // which makes the outage worse.
  app.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, service: 'josi-ce' });
  });

  // Readiness: may this instance take traffic. Names coarse subsystems and
  // nothing else — no hostnames, ports, versions, paths or database error text.
  app.get('/ready', (_req, res) => {
    void (async () => {
      const result = await checkReadiness(db, { masterKey: cfg.masterKeyCheck });
      res.set('Cache-Control', 'no-store');
      const storage = cfg.attachmentStorageRoot ? await probeAttachmentStorage(cfg.attachmentStorageRoot) : {ok: true};
      const blockers = [...result.blockers, ...(storage.ok ? [] : ['attachment_storage'])];
      res.status(blockers.length ? 503 : 200).json({ready: blockers.length === 0, blockers});
    })();
  });

  // The Telegram webhook, mounted on the ROOT and before `/api`.
  //
  // Outside the API router on purpose: `requireCsrf` and the setup gate both
  // live there, and neither can apply to a caller that has no session and is
  // not a browser. Putting it here means it needs no exemption from either —
  // and an exemption is a hole a later route copies by accident. It
  // authenticates on Telegram's secret-token header instead, in constant time,
  // and answers 404 to everything that fails.
  mountTelegramWebhook(app, {
    db,
    masterKey: cfg.masterKeyCheck,
    fetchImpl: cfg.telegramFetch,
    appUrl: cfg.appUrl,
    llmFetch: cfg.llmFetch,
    llmResolve: cfg.llmResolve,
    connectorFetch: cfg.connectorFetch,
    retry: cfg.telegramRetry,
  });
  mountExternalChannelWebhooks(app, {
    db, masterKey: cfg.masterKeyCheck, appUrl: cfg.appUrl, fetchImpl: cfg.connectorFetch,
    llmFetch: cfg.llmFetch, llmResolve: cfg.llmResolve, connectorFetch: cfg.connectorFetch,
  });
  mountWorkflowCallbacks(app, { db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.connectorFetch });
  mountCalendarWebhook(app, db);

  const api = express.Router();
  api.use(attachUser({ db }));
  api.use(requireCsrf);
  // Before the routes, after CSRF: an unconfigured installation refuses
  // everything except the wizard, and a configured one refuses the wizard.
  api.use(setupGate(db, cfg.setupTokenSha256));
  const voiceBox = voiceBoxRoutes(cfg.voiceBoxHelper ?? voiceHelper(process.env.JOSI_VOICE_HELPER_SOCKET));
  api.use('/admin/voice-box', voiceBox.admin);
  api.use('/voice', voiceBox.voice);

  api.use('/setup', setupRoutes({
    db,
    masterKey: cfg.masterKeyCheck,
    // The wizard now contacts what it configures, so it needs the same seams
    // every other subsystem already had.
    llmFetch: cfg.llmFetch,
    llmResolve: cfg.llmResolve,
    connectorFetch: cfg.connectorFetch,
    mailTransport: cfg.mailTransport,
  }));
  api.use('/auth', authRoutes({
    db, cookieSecure: cfg.cookieSecure, appUrl: cfg.appUrl,
    masterKey: cfg.masterKeyCheck, mailTransport: cfg.mailTransport, connectorFetch: cfg.connectorFetch,
    appleNativeClientId: cfg.appleNativeClientId, appleFetch: cfg.appleFetch,
  }));
  // Phase 7 owns /connections now: the Phase 1 router proved the ownership
  // shape against a real table; this one actually connects accounts.
  // Mounted BEFORE /connections on purpose. The OAuth connector router matches
  // /:provider, so `developer` would otherwise be read as a provider name and
  // answered 404 by the wrong router.
  api.use('/connections/developer', developerServiceRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.developerServiceFetch,
  }));
  api.use('/admin/developer-services', adminDeveloperServiceRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.developerServiceFetch,
  }));

  api.use('/connections', connectorRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.connectorFetch, appUrl: cfg.appUrl,
  }));
  api.use('/calendar', calendarRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.connectorFetch,
  }));
  // Contact sync sits under /contacts, beside the assistant's own contact
  // routes. Every route in it resolves ownership from the origin rather than
  // from the request, and there is no administrator equivalent: an admin who
  // could start somebody's contact sync could read their address book.
  api.use('/contacts', contactSyncRoutes({
    db, masterKey: cfg.masterKeyCheck, connectorFetch: cfg.connectorFetch,
  }));
  api.use('/llm', llmRoutes({ db, masterKey: cfg.masterKeyCheck, codexRunner: cfg.codexRunner }));
  // Mounted before /admin so the more specific prefix wins; both are behind
  // requireSuperAdmin either way.
  api.use('/assistant', assistantRoutes({
    db, appUrl: cfg.appUrl, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.llmFetch, resolve: cfg.llmResolve,
    codexRunner: cfg.codexRunner, connectorFetch: cfg.connectorFetch,
    customApiFetch: cfg.customApiFetch, outboundResolve: cfg.outboundResolve,
  }));
  api.use('/admin/assistant', adminAssistantRoutes({ db }));
  api.use('/admin/llm', adminLlmRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.llmFetch, resolve: cfg.llmResolve,
    codexRunner: cfg.codexRunner,
  }));
  // BEFORE `/admin`, with the other specific prefixes.
  //
  // Mount order was wrong here and a mutation found it: with `/admin/telegram`
  // registered after `/admin`, a member's request was refused by adminRoutes'
  // own `requireSuperAdmin` and never reached this router at all. The RBAC test
  // passed — for the wrong reason — and removing THIS router's guard changed
  // nothing observable. The protection was real but it was mount order, and
  // mount order is not where an access-control decision should live.
  api.use('/admin/telegram', adminTelegramRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.telegramFetch, appUrl: cfg.appUrl,
  }));
  api.use('/admin/channels', adminExternalChannelRoutes({
    db, masterKey: cfg.masterKeyCheck, appUrl: cfg.appUrl, fetchImpl: cfg.connectorFetch,
    llmFetch: cfg.llmFetch, llmResolve: cfg.llmResolve, connectorFetch: cfg.connectorFetch,
  }));
  api.use('/admin/parental-controls', adminParentalRoutes({
    db,
    appUrl: cfg.appUrl,
    masterKey: cfg.masterKeyCheck,
    entitlementPublicKey: cfg.licencePublicKey ?? cfg.entitlementPublicKey,
  }));
  api.use('/admin/vault', adminVaultRoutes({ db, masterKey: cfg.masterKeyCheck }));
  api.use('/admin/custom-apis', adminCustomApiRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.customApiFetch,
    resolve: cfg.outboundResolve,
  }));
  api.use('/admin/workflows', adminWorkflowRoutes({ db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.connectorFetch }));
  api.use('/admin/maintenance', maintenanceRoutes({ db }));
  api.use('/admin', adminRoutes({ db, appUrl: cfg.appUrl }));
  // Same mount point, so the super-admin guard above covers it too.
  api.use('/admin', checklistRoutes(db));
  api.use('/mail', mailRoutes({ db, masterKey: cfg.masterKeyCheck, transport: cfg.mailTransport }));
  api.use('/admin/mail', adminMailRoutes({ db, masterKey: cfg.masterKeyCheck, transport: cfg.mailTransport }));
  api.use('/admin/connectors', adminConnectorRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.connectorFetch, appUrl: cfg.appUrl,
  }));
  api.use('/admin/connections', adminConnectionRoutes({ db }));
  api.use('/storage', storageRoutes({ db }));
  api.use('/workspace', localWorkspaceRoutes({ db }));
  api.use('/telegram', telegramRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.telegramFetch, appUrl: cfg.appUrl,
  }));
  api.use('/channels', externalChannelRoutes({
    db, masterKey: cfg.masterKeyCheck, appUrl: cfg.appUrl, fetchImpl: cfg.connectorFetch,
    llmFetch: cfg.llmFetch, llmResolve: cfg.llmResolve, connectorFetch: cfg.connectorFetch,
  }));
  api.use('/migrations', migrationRoutes(db));
  api.use('/persona', personaRoutes({
    db,
    masterKey: cfg.masterKeyCheck,
    fetchImpl: cfg.llmFetch,
    resolve: cfg.llmResolve,
  }));
  api.use('/admin/licence', licenceRoutes({ db, publicKey: cfg.licencePublicKey }));
  // Family authority is deliberately separate from installation administration:
  // a super-admin can activate the licence but gains no access to any child.
  api.use('/parental', parentalRoutes({
    db,
    appUrl: cfg.appUrl,
    masterKey: cfg.masterKeyCheck,
    entitlementPublicKey: cfg.licencePublicKey ?? cfg.entitlementPublicKey,
  }));
  api.use('/vault', vaultRoutes({ db, masterKey: cfg.masterKeyCheck }));
  api.use('/custom-apis', customApiRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.customApiFetch,
    resolve: cfg.outboundResolve,
  }));
  api.use('/workflows', workflowRoutes({ db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.connectorFetch }));

  api.use('/ops', opsRoutes({
    db,
    masterKey: cfg.masterKeyCheck,
    destinationFetch: cfg.destinationFetch,
    backupWriter: cfg.backupWriter,
    restoreReader: cfg.restoreReader,
    telemetrySender: cfg.telemetrySender,
    supportGatewayUrl: cfg.supportGatewayUrl ?? null,
    fetchLatestVersion: cfg.fetchLatestVersion,
    outboundResolve: cfg.outboundResolve,
    nasController: cfg.nasController ?? nasController(),
  }));

  api.use((_req, res) => res.status(404).json({ error: 'no such endpoint' }));

  // JSON errors for /api, always. An HTML stack trace inside a fetch() is a bug
  // report nobody can read — and a stack trace in a response body is a leak.
  api.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    console.error(`api error ${req.method} ${req.originalUrl}`, err);
    if (res.headersSent) return;
    // A database constraint refusing a write is the server rejecting the
    // REQUEST, not the server breaking. "Something broke on our side" for a
    // CHECK violation sent an operator hunting a crash that was actually a
    // validation gap — three identical retries against the same constraint,
    // each told the same lie. The constraint name is schema, not content, and
    // it is the one word a bug report needs.
    const pgCode = (err as { code?: unknown })?.code;
    if (pgCode === '23514' || pgCode === '23505' || pgCode === '23503') {
      const constraint = String((err as { constraint_name?: unknown; constraint?: unknown }).constraint_name
        ?? (err as { constraint?: unknown }).constraint ?? 'a database rule');
      res.status(409).json({
        error: `the database refused that: it violates ${constraint}. This is a validation gap — `
          + 'the request should have been refused with a clearer reason. Please report it, quoting the rule name.',
      });
      return;
    }
    res.status(500).json({ error: 'something broke on our side' });
  });

  app.use('/api', api);

  // Last: the SPA and its security headers. Mounted after /api so an unknown
  // endpoint still answers with the API's JSON 404 rather than an HTML page.
  mountWebApp(app, { dir: cfg.webDir,
    voiceEnabled: Boolean(cfg.voiceBoxHelper || process.env.JOSI_VOICE_HELPER_SOCKET) });

  return app;
}
