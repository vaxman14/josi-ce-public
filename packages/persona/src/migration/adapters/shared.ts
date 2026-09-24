import { parseProfile, renderProfile } from '../../parse.js';
import { findAuthorityAttempts, type Layer } from '../../schema.js';
import { hash, LIMITS, MigrationError, type Category, type MigrationItem, type MigrationSource } from '../types.js';

export type Proposal = Omit<MigrationItem, 'id' | 'provenance'>;
export interface AdapterContext {
  path: string;
  text: string;
  source: MigrationSource;
  emit(format: string, locator: string, item: Proposal): void;
}
export function context(path: string, text: string, source: MigrationSource, sha256: string, items: MigrationItem[]): AdapterContext {
  return { path, text, source, emit(format, locator, item) {
    if (items.length >= LIMITS.items) throw new MigrationError('More than 10,000 preview items. Split this export.', 413);
    const provenance = { source, format, path, locator, sha256 };
    items.push({ ...item, provenance, id: hash(JSON.stringify(provenance)).slice(0, 32) });
  } };
}
export function note(ctx: AdapterContext, format: string, locator: string, category: Category, reason: string, classification: Proposal['classification'] = 'unsupported'): void {
  ctx.emit(format, locator, { category, classification, reason });
}

export function memory(ctx: AdapterContext, format: string, locator: string, content: string, pinned = false, provenance?: string): void {
  if (!content.trim()) return note(ctx, format, locator, 'memory', 'Empty memory.', 'ignored');
  if (content.length > 2000) return note(ctx, format, locator, 'memory', 'Memory exceeds 2,000 characters; shorten it in the source and scan again.');
  if (findAuthorityAttempts('memory', content).length) return note(ctx, format, locator, 'memory',
    'Instruction-like authority or approval-bypass language is quarantined; rewrite it as a plain personal fact before import.', 'sensitive/refused');
  ctx.emit(format, locator, { category: 'memory', classification: 'imported unchanged', content, pinned,
    memoryProvenance: provenance, reason: 'Separate owner-scoped fact; review before saving. No instruction authority.' });
}

export function profile(ctx: AdapterContext, format: string, kind: Exclude<Layer, 'agents_admin'>, text: string, portable = false): void {
  const category = kind === 'soul' ? 'personality' : kind === 'user' ? 'preferences' : 'behaviour';
  if (Buffer.byteLength(text) > 20000) return note(ctx, format, kind, category, 'Profile exceeds 20,000 bytes; shorten it and scan again.');
  const parsed = parseProfile(kind, text);
  // External free prose is mapped explicitly to one bounded field, never
  // treated as a privileged profile file or an instruction extension.
  if (!portable && kind !== 'agents_user' && !Object.keys(parsed.values).length && text.trim()) {
    if (text.trim().length > 2000) return note(ctx, format, kind, category, 'Prose exceeds the 2,000-character Josi field; shorten it and scan again.');
    parsed.values[kind === 'soul' ? 'custom_personality' : 'about_me'] = text.trim().replace(/\r?\n/g, ' ');
    parsed.ignored = [];
  }
  parsed.ignored.forEach((ignored, index) => note(ctx, format, `${kind}:ignored:${index}`, category,
    ignored.reason === 'unknown_value' ? 'unknown_value: This field does not match a supported Josi enum value.'
      : `${ignored.reason}: ${ignored.explanation}`, 'ignored'));
  if (findAuthorityAttempts(kind, text).length) note(ctx, format, `${kind}:authority`, category,
    'Authority instructions have no effect. Tool access, approval rules and installation policy cannot migrate.', 'ignored');
  if (!Object.keys(parsed.values).length) return note(ctx, format, kind, category,
    kind === 'agents_user' ? 'No exact Josi behaviour enum fields found. Recreate preferences in Personalization.' : 'No supported profile fields found.', 'ignored');
  ctx.emit(format, kind, { category, profileKind: kind, values: parsed.values,
    content: portable ? text : renderProfile(kind, parsed.values),
    classification: portable ? 'imported unchanged' : 'transformed',
    reason: kind === 'agents_user' ? 'Only exact closed Josi enums; installation policy can further restrict them.'
      : 'Mapped to bounded Josi profile fields. Existing profiles will never be replaced.' });
}

/** Markdown has no fact schema. Preserve each paragraph/bullet as an editable
 * proposed fact, including multiline continuation; do not invent summaries. */
export function markdownMemories(ctx: AdapterContext, format: string): void {
  const blocks: Array<{ line: number; text: string }> = [];
  let current: { line: number; text: string } | undefined;
  const flush = () => { if (current) blocks.push(current); current = undefined; };
  ctx.text.replace(/\r\n/g, '\n').split('\n').forEach((line, index) => {
    if (/^\s*#{1,6}\s/.test(line)) {
      flush(); note(ctx, format, `line:${index + 1}`, 'memory', 'Markdown heading used only as a section label.', 'ignored');
    } else if (!line.trim()) flush();
    else if (/^\s*[-*]\s+/.test(line)) { flush(); current = { line: index + 1, text: line.replace(/^\s*[-*]\s+/, '') }; }
    else if (current) current.text += `\n${line}`;
    else current = { line: index + 1, text: line };
  });
  flush();
  blocks.forEach(block => memory(ctx, format, `line:${block.line}`, block.text));
  if (!blocks.length && !ctx.text.trim()) note(ctx, format, 'empty', 'memory', 'Empty file.', 'ignored');
}

export function textContent(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value === null) return '';
  if (!Array.isArray(value)) return null;
  // Only an exact text projection; tools, image blobs and hidden reasoning are
  // never guessed or rendered. The caller reports any non-text blocks.
  return value.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
}
