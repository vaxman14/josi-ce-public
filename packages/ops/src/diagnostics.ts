// Diagnostics bundles.
//
// M113 is absolute: bundles ALWAYS exclude prompts, chats, email, calendar,
// contact and task content, uploaded documents and database rows, and "users
// cannot toggle these in".
//
// So the exclusion is not a filter applied to a general collector — it is the
// shape of the collector. There is no "include" list a caller can extend, no
// setting that widens it, and no code path that reads a content table. The
// builder below can only produce the sections named in `SECTIONS`, and adding a
// new one is a source change that has to pass the test asserting the set.
//
// That distinction matters because the alternative — collect everything, then
// redact — fails the first time somebody adds a table and forgets the redactor.
import { createHash } from 'node:crypto';
import { appendEvent, type Db } from '@josi-ce/core';

export type LogWindow = '1h' | '24h' | '7d';

/** M112: 1 hour, 24 hours, 7 days, defaulting to 24. */
export const DEFAULT_LOG_WINDOW: LogWindow = '24h';
export const LOG_WINDOW_HOURS: Record<LogWindow, number> = { '1h': 1, '24h': 24, '7d': 168 };

/** M109. */
export const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;

/**
 * Everything a bundle may contain. The complete list, and the only list.
 *
 * M112 requires version, container health, a resource summary and sanitized
 * config status. Nothing here reads a row of anybody's content, and the test
 * asserts this exact set so a future addition has to be deliberate.
 */
export const SECTIONS = [
  'version',
  'container_health',
  'resources',
  'config_status',
  'migrations',
  'logs',
  'counts',
] as const;
export type Section = (typeof SECTIONS)[number];

export interface BundleInput {
  version: string;
  containers: Array<{ name: string; state: string; restarts: number }>;
  resources: { cpuCount: number; memoryBytes: number; diskFreeBytes: number };
  /** Whether each setting is CONFIGURED — never its value. */
  configStatus: Record<string, boolean>;
  migrations: string[];
  /** Log lines, already windowed. Redacted here, not by the caller. */
  logs: string[];
  /** Aggregate counts only: how many users, how many threads. Never their
   * contents, never their names. */
  counts: Record<string, number>;
}

export interface BundleSection {
  name: Section;
  content: string;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Patterns that mean "this line carries a secret".
 *
 * Deliberately over-broad. A redacted line that did not need redacting costs an
 * engineer a follow-up question; a token that ships in a support bundle is a
 * credential in a third party's ticket system. */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi },
  { name: 'sealed', re: /\bv1\.[A-Za-z0-9+/=]{8,}\.[A-Za-z0-9+/=]{8,}\.[A-Za-z0-9+/=]+/g },
  { name: 'openai', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'google_oauth', re: /\b[0-9]+-[a-z0-9]{20,}\.apps\.googleusercontent\.com/gi },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g },
  { name: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'password_kv', re: /\b(password|passwd|secret|token|api[_-]?key|client[_-]?secret)\s*[=:]\s*\S+/gi },
  { name: 'url_credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi },
  { name: 'base64_key', re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g },
];

export interface Redaction { pattern: string; count: number }

export function redact(text: string): { text: string; redactions: Redaction[] } {
  let out = text;
  const redactions: Redaction[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    let count = 0;
    out = out.replace(re, () => { count += 1; return `[redacted:${name}]`; });
    if (count) redactions.push({ pattern: name, count });
  }
  return { text: out, redactions };
}

/**
 * The final scan (M102), run over the assembled bundle after the operator has
 * approved it.
 *
 * It is a second pass over already-redacted text on purpose. The redactor runs
 * on each section as it is built; this runs on the finished article, so a
 * section added later that forgets to redact still cannot be submitted.
 */
export function scanForSecrets(bundle: string): { clean: boolean; findings: Redaction[] } {
  const findings: Redaction[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const matches = bundle.match(re);
    if (matches?.length) findings.push({ pattern: name, count: matches.length });
  }
  return { clean: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export interface BuiltBundle {
  sections: BundleSection[];
  text: string;
  byteSize: number;
  sha256: string;
  redactions: Redaction[];
  /** M109: what was dropped to fit, named rather than silently truncated. */
  trimmed: string[];
}

/**
 * Assemble a bundle, redacting as it goes and trimming to fit.
 *
 * M109's trimming order is "old logs and oversized/noisy files first", which is
 * also the only order that keeps a bundle useful: version, health, resources and
 * config status are small and are the things a supporter reads first. Logs are
 * large and the oldest are the least relevant.
 */
export function buildBundle(input: BundleInput, maxBytes = MAX_BUNDLE_BYTES): BuiltBundle {
  const trimmed: string[] = [];
  const allRedactions: Redaction[] = [];

  const render = (name: Section): string => {
    switch (name) {
      case 'version': return `version: ${input.version}`;
      case 'container_health':
        return input.containers
          .map((c) => `${c.name}: ${c.state} (restarts: ${c.restarts})`).join('\n');
      case 'resources':
        return `cpus: ${input.resources.cpuCount}\n`
          + `memory_bytes: ${input.resources.memoryBytes}\n`
          + `disk_free_bytes: ${input.resources.diskFreeBytes}`;
      case 'config_status':
        // Whether each thing is CONFIGURED. Never what it is set to.
        return Object.entries(input.configStatus)
          .map(([k, v]) => `${k}: ${v ? 'configured' : 'not configured'}`).join('\n');
      case 'migrations': return input.migrations.join('\n');
      case 'counts':
        return Object.entries(input.counts).map(([k, v]) => `${k}: ${v}`).join('\n');
      case 'logs': return input.logs.join('\n');
      default: return '';
    }
  };

  const sections: BundleSection[] = [];
  for (const name of SECTIONS) {
    const { text, redactions } = redact(render(name));
    allRedactions.push(...redactions);
    sections.push({ name, content: text, bytes: Buffer.byteLength(text, 'utf8') });
  }

  // Trim logs first, oldest first, until it fits.
  const overhead = sections
    .filter((s) => s.name !== 'logs')
    .reduce((n, s) => n + s.bytes + s.name.length + 8, 0);

  const logsSection = sections.find((s) => s.name === 'logs')!;
  if (overhead + logsSection.bytes > maxBytes) {
    const budget = Math.max(0, maxBytes - overhead);
    const lines = logsSection.content.split('\n');
    let kept: string[] = [];
    let used = 0;
    // From the newest backwards: the most recent lines are the ones that
    // explain what just went wrong.
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const size = Buffer.byteLength(lines[i], 'utf8') + 1;
      if (used + size > budget) {
        trimmed.push(`${i + 1} older log lines`);
        break;
      }
      kept.unshift(lines[i]);
      used += size;
    }
    logsSection.content = kept.join('\n');
    logsSection.bytes = Buffer.byteLength(logsSection.content, 'utf8');
  }

  const text = sections.map((s) => `--- ${s.name} ---\n${s.content}`).join('\n\n');
  const bytes = Buffer.from(text, 'utf8');
  return {
    sections,
    text,
    byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    redactions: allRedactions,
    trimmed,
  };
}

// ---------------------------------------------------------------------------
// The consent sequence (M102)
// ---------------------------------------------------------------------------

export class DiagnosticsError extends Error {}

export const DIAGNOSTICS_DIR = '/data/diagnostics';

export async function recordBundle(
  db: Db,
  args: { createdBy: string; window: LogWindow; filename: string; built: BuiltBundle },
): Promise<{ id: string }> {
  if (args.built.byteSize > MAX_BUNDLE_BYTES) {
    throw new DiagnosticsError('that bundle is larger than the 25 MB limit');
  }
  const cleaned = args.filename.replace(/[^A-Za-z0-9._-]/g, '');
  if (!cleaned || cleaned.startsWith('.')) throw new DiagnosticsError('that is not a usable filename');

  const [row] = await db.query<{ id: string }>(
    `insert into diagnostic_bundles (created_by, log_window, stored_path, byte_size, sha256)
     values ($1, $2, $3, $4, $5) returning id`,
    [args.createdBy, args.window, `${DIAGNOSTICS_DIR}/${cleaned}`, args.built.byteSize, args.built.sha256],
  );
  await appendEvent(db, {
    actorUserId: args.createdBy,
    actor: 'user',
    kind: 'diagnostics.created',
    subjectType: 'diagnostic_bundle',
    subjectId: row.id,
    payload: { window: args.window, byteSize: args.built.byteSize, redactions: args.built.redactions.length },
  });
  return row;
}

/** M102: the user INSPECTS, then consents. Two acts, in that order, because
 * consent collected on something nobody looked at is not consent. */
export async function markInspected(db: Db, bundleId: string): Promise<void> {
  await db.query(`update diagnostic_bundles set inspected_at = now() where id = $1`, [bundleId]);
}

export async function approveBundle(db: Db, args: { bundleId: string; userId: string }): Promise<void> {
  const [row] = await db.query<{ inspected_at: string | null }>(
    `select inspected_at from diagnostic_bundles where id = $1`, [args.bundleId],
  );
  if (!row) throw new DiagnosticsError('no such bundle');
  if (!row.inspected_at) {
    throw new DiagnosticsError('open the bundle and read it before approving it');
  }
  await db.query(`update diagnostic_bundles set approved_at = now() where id = $1`, [args.bundleId]);
  await appendEvent(db, {
    actorUserId: args.userId,
    actor: 'user',
    kind: 'diagnostics.approved',
    subjectType: 'diagnostic_bundle',
    subjectId: args.bundleId,
    payload: {},
  });
}

/** The last gate before anything leaves. */
export async function passSecretScan(
  db: Db, args: { bundleId: string; text: string },
): Promise<{ clean: boolean; findings: Redaction[] }> {
  const result = scanForSecrets(args.text);
  if (result.clean) {
    await db.query(
      `update diagnostic_bundles set secret_scan_passed_at = now() where id = $1`,
      [args.bundleId],
    );
  }
  return result;
}
