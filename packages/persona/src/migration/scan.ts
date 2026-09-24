import { context, note } from './adapters/shared.js';
import { openclaw } from './adapters/openclaw.js';
import { hermes } from './adapters/hermes.js';
import { josi } from './adapters/josi.js';
import { decodedSecret, migrationSecret, secretPath } from './secrets.js';
import { hash, isRecord, LIMITS, MigrationError, type MigrationFile, type MigrationManifest, type MigrationSource } from './types.js';
import { safePath } from './zip.js';

/** Deterministic scan; no DB, network, model, file writes or execution. */
export function scanMigration(files: MigrationFile[], source: MigrationSource | 'auto' = 'auto'): MigrationManifest {
  if (!['auto', 'openclaw', 'hermes', 'josi'].includes(source)) throw new MigrationError('Choose a supported source.');
  if (files.length > LIMITS.files || files.reduce((sum, file) => sum + file.bytes.length, 0) > LIMITS.expandedBytes) throw new MigrationError('Too many files or expanded bytes.', 413);
  const manifest: MigrationManifest = { version: 1, items: [], fileCount: files.length };
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const workspaceRoots = files.filter(file => /(?:^|\/)(?:SOUL|AGENTS)\.md$/.test(file.path))
    .map(file => file.path.slice(0, file.path.lastIndexOf('/') + 1));
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    safePath(file.path);
    if (file.bytes.length > LIMITS.entryBytes) throw new MigrationError('A file exceeds 1 MiB.', 413);
    const digest = hash(file.bytes);
    const safeName = secretPath(file.path) ? `[refused-file-${manifest.items.length + 1}]` : file.path;
    let ctx = context(safeName, '', source === 'auto' ? 'unknown' : source, digest, manifest.items);
    if (secretPath(file.path)) { note(ctx, 'refused', 'file', 'workspace', 'Credential/session file or sensitive filename; refused.', 'sensitive/refused'); continue; }
    if (!/\.(?:md|json|jsonl)$/i.test(file.path)) { note(ctx, 'unknown', 'file', 'workspace', 'Only Markdown, JSON and JSONL are supported. Map other workspace files separately.'); continue; }
    let text: string;
    try { text = utf8.decode(file.bytes); } catch { note(ctx, 'unknown', 'file', 'workspace', 'File is not valid UTF-8 text.'); continue; }
    // JSON is scanned after decoding, including ignored metadata. Scanning its
    // serialized numbers as prose would mistake millisecond timestamps for
    // payment numbers; escaped strings must be scanned in their decoded form.
    const secret = /\.md$/i.test(file.path) ? migrationSecret(text) : null;
    if (secret) { note(ctx, 'refused', 'file', 'workspace', secret, 'sensitive/refused'); continue; }
    let parsed: unknown;
    if (/\.jsonl?$/i.test(file.path)) {
      try {
        parsed = /\.jsonl$/i.test(file.path) ? text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)) : JSON.parse(text);
      } catch { note(ctx, 'unknown', 'file', 'workspace', 'Invalid JSON/JSONL; no data imported.'); continue; }
      const reason = decodedSecret(parsed);
      if (reason) { note(ctx, 'refused', 'file', 'workspace', reason, 'sensitive/refused'); continue; }
    }
    let detected = source;
    if (source === 'auto') {
      if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.files)) detected = 'josi';
      else if (Array.isArray(parsed) && parsed[0]?.type === 'session') detected = 'openclaw';
      else if ((Array.isArray(parsed) ? parsed : [parsed]).some(record => isRecord(record) && typeof record.id === 'string' && typeof record.source === 'string' && Array.isArray(record.messages))) detected = 'hermes';
      else if (/(?:^|\/)memories\/(?:MEMORY|USER)\.md$/.test(file.path)) detected = 'hermes';
      else if (/(?:^|\/)(?:\.openclaw|workspace|memory)\//.test(file.path) || /(?:^|\/)(?:SOUL|AGENTS)\.md$/.test(file.path)) detected = 'openclaw';
      else if (workspaceRoots.some(root => file.path.startsWith(root)
        && /^(?:USER\.md|MEMORY\.md|memory\/.+\.md)$/.test(file.path.slice(root.length)))) detected = 'openclaw';
      else detected = 'unknown';
    }
    ctx = context(file.path, text, detected === 'auto' ? 'unknown' : detected, digest, manifest.items);
    if (detected === 'openclaw') openclaw(ctx, parsed);
    else if (detected === 'hermes') hermes(ctx, parsed);
    else if (detected === 'josi') josi(ctx, parsed);
    else note(ctx, 'unknown', 'file', 'workspace', 'Source/format is ambiguous. Choose OpenClaw or Hermes explicitly and scan again, or export a documented format.');
  }
  return manifest;
}
