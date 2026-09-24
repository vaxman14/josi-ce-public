import { isRecord } from '../types.js';
import { memory, note, textContent, type AdapterContext } from './shared.js';

// Source contract is pinned in docs/ASSISTANT_MIGRATION.md. Hermes does not
// emit a schema version in these files; never invent a product version.
export function hermes(ctx: AdapterContext, json?: unknown): void {
  if (/(?:^|\/)(?:memories\/)?MEMORY\.md$/.test(ctx.path)) {
    const format = 'hermes-memory-section-delimiter (unversioned)';
    const entries = ctx.text.replace(/\r\n/g, '\n').split('\n§\n').map(value => value.trim()).filter(Boolean);
    entries.forEach((entry, i) => memory(ctx, format, `entry:${i + 1}`, entry));
    if (!entries.length) note(ctx, format, 'empty', 'memory', 'Empty memory store.', 'ignored');
    return;
  }
  if (/(?:^|\/)(?:memories\/)?USER\.md$/.test(ctx.path)) {
    // USER is prose in Hermes, not an invented key/value schema.
    const text = ctx.text.replace(/\r\n/g, '\n').split('\n§\n').join('\n\n');
    if (text.trim().length > 2000) return note(ctx, 'hermes-user-memory (unversioned)', 'file', 'preferences', 'User profile exceeds Josi’s 2,000-character About Me limit.');
    // Flatten line breaks so prose containing "key: value" cannot create a
    // second Josi field when its profile is parsed again.
    if (!text.trim()) return note(ctx, 'hermes-user-memory (unversioned)', 'file', 'preferences', 'Empty user profile.', 'ignored');
    const about = text.trim().replace(/\n/g, ' ');
    ctx.emit('hermes-user-memory (unversioned)', 'user', { category: 'preferences', profileKind: 'user',
      content: `about_me: ${about}\n`, values: { about_me: about }, classification: 'transformed',
      reason: 'Hermes user prose mapped to About Me with line breaks replaced by spaces; never installation policy.' });
    return;
  }
  const records = /\.jsonl$/i.test(ctx.path) && Array.isArray(json) ? json : isRecord(json) ? [json] : null;
  if (records?.length) {
    records.forEach((record, index) => {
      const format = 'hermes-session-export-jsonl (unversioned)';
      const locator = `session:${index + 1}`;
      // Exact export_session shape: session columns at top level + messages.
      // No conversation-envelope, role guessing, foreign trace or SQLite fallback.
      if (!isRecord(record) || typeof record.id !== 'string' || typeof record.source !== 'string'
        || typeof record.started_at !== 'number' || !Number.isFinite(record.started_at) || !Array.isArray(record.messages)
        || 'version' in record || 'schema_version' in record || 'segments' in record) {
        return note(ctx, 'unknown', locator, 'conversation', 'Not a supported Hermes flat session export; unknown/versioned/lineage formats are unsupported.');
      }
      const lines: string[] = [];
      record.messages.forEach((message: unknown, i: number) => {
        const at = `${locator}:message:${i + 1}`;
        if (!isRecord(message) || typeof message.role !== 'string') return note(ctx, format, at, 'conversation', 'Unsupported message shape.');
        if (!Number.isSafeInteger(message.id) || message.id < 1 || message.session_id !== record.id
          || (message.timestamp !== null && (typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)))) {
          return note(ctx, format, at, 'conversation', 'Message lacks documented Hermes row identity, session association or timestamp.');
        }
        if (!['user', 'assistant'].includes(message.role)) return note(ctx, format, at, 'conversation', 'System/tool messages are excluded.', 'ignored');
        const content = textContent(message.content);
        if (content === null) return note(ctx, format, at, 'conversation', 'Unsupported content representation.');
        if (message.tool_calls || message.reasoning || (Array.isArray(message.content) && message.content.some(block => block?.type !== 'text'))) {
          note(ctx, format, `${at}:metadata`, 'conversation', 'Tool calls, reasoning and non-text blocks are excluded.', 'ignored');
        }
        if (content) lines.push(`${message.role}:\n${content}`);
        else note(ctx, format, at, 'conversation', 'No visible text in this message.', 'ignored');
      });
      note(ctx, format, `${locator}:metadata`, 'conversation', 'Runtime configuration, metadata and timing information are not imported.', 'ignored');
      if (!lines.length) return note(ctx, format, locator, 'conversation', 'No supported visible messages.');
      ctx.emit(format, locator, { category: 'conversation', classification: 'transformed', content: lines.join('\n\n'),
        reason: 'Visible user/assistant text in message order. Read-only history; never prompt context.' });
    });
    return;
  }
  note(ctx, 'unknown', 'file', /(?:cron|task|remind)/i.test(ctx.path) ? 'automation' : 'workspace',
    'Unsupported Hermes file. Export sessions as JSONL or select memories/MEMORY.md and memories/USER.md. Recreate tasks and map workspace files separately.');
}
