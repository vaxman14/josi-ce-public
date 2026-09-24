// Josi CE API entrypoint.
import { readFileSync } from 'node:fs';
import { pgBackupWriter, pgRestoreReader } from '@josi-ce/ops';
import { connectFromEnv, loadMasterKey } from '@josi-ce/core';
import { attachmentRoot, probeAttachmentStorage, reconcileWorkspaceMount } from '@josi-ce/storage';
import { createApp } from './app.js';
import { publicAddressFromEnvironment, reconcilePublicAddress } from './setup/publicAddress.js';

const attachmentStorage = await probeAttachmentStorage();
if (!attachmentStorage.ok) console.error(`josi-ce: ${attachmentStorage.code}: ${attachmentStorage.message}`);

const PORT = Number(process.env.PORT ?? 8080);

const { db, close, describe } = await connectFromEnv();
console.log(`josi-ce: database ${describe}`);

// Load the key once at boot so a misconfigured installation fails immediately
// and visibly, rather than at the first request that needs to decrypt something.
// The value is never logged — MasterKey redacts itself on inspection.
try {
  loadMasterKey();
  console.log('josi-ce: master key loaded');
} catch (err) {
  console.error(`josi-ce: ${(err as Error).message}`);
  console.error('josi-ce: refusing to start without a usable master key');
  await close();
  process.exit(1);
}

// The real backup path. `pgBackupWriter` shells out to pg_dump, which ships in
// the runtime image; the password is read from its file here and handed to the
// child through the environment only, never logged and never stored.
const pgConn = {
  host: process.env.PGHOST ?? 'db',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.POSTGRES_USER ?? 'josi',
  database: process.env.POSTGRES_DB ?? 'josi',
  password: process.env.PGPASSWORD_FILE
    ? readFileSync(process.env.PGPASSWORD_FILE, 'utf8').trim()
    : process.env.PGPASSWORD,
};

const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '') || 'http://localhost:8080';
// Readiness is the network controller's commit boundary.  Reconcile all
// persisted address derivatives before listening so a failure rolls the whole
// runtime change back instead of leaving Caddy and the database disagreeing.
await reconcilePublicAddress(db, publicAddressFromEnvironment(appUrl));
const workspaceMount = await reconcileWorkspaceMount(db);
if (workspaceMount.status === 'unavailable') {
  console.error('josi-ce: configured workspace mount is unavailable; no workspace access was granted');
} else if (workspaceMount.status === 'ready') {
  console.log(`josi-ce: workspace mount ready (${workspaceMount.writable ? 'read/write' : 'read-only'})`);
}
const cookieSecure = process.env.COOKIE_SECURE === 'true'
  ? true
  : process.env.COOKIE_SECURE === 'false'
    ? false
    : new URL(appUrl).protocol === 'https:';

const app = createApp(db, {
  attachmentStorageRoot: attachmentRoot(),
  // Empty/unset follows APP_URL. This keeps first-run LAN HTTP usable without
  // weakening cookies on a public HTTPS installation. An explicit value is an
  // advanced override, not something the normal installer should require.
  cookieSecure,
  appUrl,
  appleNativeClientId: process.env.APPLE_NATIVE_CLIENT_ID || null,
  webDir: process.env.WEB_DIR,
  backupWriter: pgBackupWriter(pgConn),
  restoreReader: pgRestoreReader(pgConn),
  // M115: no gateway ships. An operator who wants one sets it.
  supportGatewayUrl: process.env.JOSI_SUPPORT_GATEWAY || null,
  setupTokenSha256: process.env.JOSI_SETUP_TOKEN_SHA256 || null,
});

const server = app.listen(PORT, () => console.log(`josi-ce api on :${PORT}`));

/** Stop accepting connections, drain, then close the pool. Without this a
 * `docker compose up -d` redeploy cuts requests off mid-flight. */
async function shutdown(signal: string): Promise<void> {
  console.log(`josi-ce: ${signal} received, shutting down`);
  server.close(() => void 0);
  await close().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
