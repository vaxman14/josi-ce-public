// Markdown in, bounded configuration out.
//
// This is the boundary. On one side is a file somebody wrote, which may say
// anything at all. On the other is a small object with known keys and
// enumerated values, and that object is the ONLY thing that reaches prompt
// assembly.
//
// Three properties, each with a test:
//
//   1. An unknown field does not pass through. It is dropped, and reported.
//   2. A known field with an unrecognised value does not pass through. It is
//      dropped, and reported — never coerced to something plausible, because a
//      person who wrote `humour: savage` should be told it did nothing rather
//      than silently given `playful`.
//   3. Prose outside a field does not pass through at all. A profile is a form,
//      and a paragraph between two fields is commentary.
//
// The reporting is not politeness. The plan requires it: "make ignored
// instructions visible to the user rather than silently pretending they
// applied". Silently dropping an instruction teaches somebody their file works
// when it does not, and they will write more.
import {
  FIELDS, MAX_PROFILE_BYTES, findAuthorityAttempts,
  type AuthorityAttempt, type FieldSpec, type Layer,
} from './schema.js';

export class ProfileTooLarge extends Error {}

export interface IgnoredItem {
  /** What was in the file. */
  field: string;
  reason: 'unknown_field' | 'unknown_value' | 'too_long' | 'not_a_field' | 'too_many_items';
  /** Said to the person, in words about their file. */
  explanation: string;
}

export interface ParsedProfile {
  /** The bounded configuration. Keys are always from the layer's field list. */
  values: Record<string, string | string[]>;
  /** Everything that did nothing, and why. */
  ignored: IgnoredItem[];
  /** Text that reads like an attempt to change the rules. Reported so the
   * product can explain what actually happened to it, never used to reject. */
  authorityAttempts: AuthorityAttempt[];
}

/**
 * Parse one layer.
 *
 * The accepted syntax is deliberately boring: `key: value` lines, and
 * `- item` lines under a list key. No nesting, no includes, no references to
 * other files. Every construct a richer format would add is a construct
 * somebody could use to reach somewhere else.
 */
export function parseProfile(layer: Layer, markdown: string): ParsedProfile {
  if (Buffer.byteLength(markdown, 'utf8') > MAX_PROFILE_BYTES) {
    throw new ProfileTooLarge(
      `that file is larger than the ${Math.floor(MAX_PROFILE_BYTES / 1000)} KB limit`,
    );
  }

  const spec = FIELDS[layer];
  const values: Record<string, string | string[]> = {};
  const ignored: IgnoredItem[] = [];
  const authorityAttempts: AuthorityAttempt[] = [];

  const lines = markdown.split('\n');
  let currentList: { key: string; spec: FieldSpec; items: string[] } | null = null;
  let currentText: { key: string; spec: FieldSpec; lines: string[] } | null = null;

  const closeText = (): void => {
    if (!currentText) return;
    const joined = currentText.lines.join('\n').trim();
    if (joined) acceptText(currentText.key, currentText.spec, joined);
    currentText = null;
  };
  const closeList = (): void => {
    if (!currentList) return;
    if (currentList.items.length) {
      values[currentList.key] = currentList.items.slice(0, currentList.spec.maxItems ?? 20);
      if (currentList.items.length > (currentList.spec.maxItems ?? 20)) {
        ignored.push({
          field: currentList.key,
          reason: 'too_many_items',
          explanation: `Only the first ${currentList.spec.maxItems} were kept.`,
        });
      }
    }
    currentList = null;
  };

  function acceptText(key: string, fieldSpec: FieldSpec, raw: string): void {
    const max = fieldSpec.maxLength ?? 500;
    if (raw.length > max) {
      ignored.push({
        field: key,
        reason: 'too_long',
        explanation: `Kept the first ${max} characters; the rest was dropped.`,
      });
    }
    const kept = raw.slice(0, max);
    authorityAttempts.push(...findAuthorityAttempts(key, kept));
    values[key] = kept;
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();

    // Blank lines end a text block but not a list.
    if (!trimmed) {
      if (currentText && currentText.lines.length) currentText.lines.push('');
      continue;
    }
    // Markdown headings are decoration. A profile is a form; a heading does not
    // set anything.
    if (/^#{1,6}\s/.test(trimmed)) { closeText(); closeList(); continue; }

    // A list item, if a list key is open.
    if (currentList && /^[-*]\s+/.test(trimmed)) {
      const item = trimmed.replace(/^[-*]\s+/, '').trim();
      const max = currentList.spec.maxItemLength ?? 200;
      currentList.items.push(item.slice(0, max));
      authorityAttempts.push(...findAuthorityAttempts(currentList.key, item));
      continue;
    }

    const kv = /^([A-Za-z][A-Za-z0-9 _-]{0,60}?)\s*:\s*(.*)$/.exec(trimmed);
    if (!kv) {
      // Prose. If a text field is open it belongs to that field; otherwise it is
      // commentary and does nothing.
      if (currentText) { currentText.lines.push(trimmed); continue; }
      if (trimmed.length > 3) {
        ignored.push({
          field: trimmed.slice(0, 60),
          reason: 'not_a_field',
          explanation: 'Lines that are not "name: value" are treated as notes and do nothing.',
        });
      }
      continue;
    }

    closeText();
    closeList();

    const key = kv[1].trim().toLowerCase().replace(/[ -]/g, '_');
    const rest = kv[2].trim();
    const fieldSpec = Object.hasOwn(spec, key) ? spec[key] : undefined;

    if (!fieldSpec) {
      ignored.push({
        field: key,
        reason: 'unknown_field',
        explanation: 'Josi does not have a setting by that name, so this line did nothing. '
          + 'Adding a field here cannot create one.',
      });
      // Still scan it: somebody who wrote `permissions: admin` should be told.
      authorityAttempts.push(...findAuthorityAttempts(key, `${key}: ${rest}`));
      continue;
    }

    switch (fieldSpec.kind) {
      case 'enum': {
        const allowed = fieldSpec.values ?? [];
        const value = rest.toLowerCase().replace(/[ -]/g, '_');
        if (!allowed.includes(value)) {
          ignored.push({
            field: key,
            reason: 'unknown_value',
            explanation: `"${rest.slice(0, 40)}" is not one of: ${allowed.join(', ')}. `
              + 'This setting was left at its default.',
          });
          authorityAttempts.push(...findAuthorityAttempts(key, rest));
          break;
        }
        values[key] = value;
        break;
      }
      case 'name': {
        const max = fieldSpec.maxLength ?? 60;
        if (rest.length > max) {
          ignored.push({
            field: key, reason: 'too_long',
            explanation: `Kept the first ${max} characters.`,
          });
        }
        // A name is a name: no newlines, no control characters.
        const cleaned = rest.replace(/[\r\n\t\0]/g, ' ').trim().slice(0, max);
        authorityAttempts.push(...findAuthorityAttempts(key, cleaned));
        if (cleaned) values[key] = cleaned;
        break;
      }
      case 'list': {
        currentList = { key, spec: fieldSpec, items: [] };
        if (rest) {
          // `interests: a, b, c` as well as a bullet list.
          for (const item of rest.split(',')) {
            const v = item.trim();
            if (v) currentList.items.push(v.slice(0, fieldSpec.maxItemLength ?? 200));
          }
          authorityAttempts.push(...findAuthorityAttempts(key, rest));
        }
        break;
      }
      case 'text':
      default: {
        currentText = { key, spec: fieldSpec, lines: rest ? [rest] : [] };
        break;
      }
    }
  }

  closeText();
  closeList();

  return { values, ignored, authorityAttempts };
}

/** Back to Markdown, for export. Round-trips through `parseProfile`. */
export function renderProfile(layer: Layer, values: Record<string, string | string[]>): string {
  const spec = FIELDS[layer];
  const out: string[] = [];
  for (const [key, fieldSpec] of Object.entries(spec)) {
    const value = values[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      out.push(`${key}:`);
      for (const item of value) out.push(`- ${item}`);
      out.push('');
      continue;
    }
    if (!String(value).length) continue;
    if (fieldSpec.kind === 'text' && String(value).includes('\n')) {
      out.push(`${key}:`);
      out.push(String(value));
      out.push('');
      continue;
    }
    out.push(`${key}: ${value}`);
  }
  return out.join('\n').trim() + '\n';
}
