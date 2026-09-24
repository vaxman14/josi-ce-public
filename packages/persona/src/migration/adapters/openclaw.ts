import { isRecord } from '../types.js';
import { markdownMemories, note, profile, textContent, type AdapterContext } from './shared.js';

export function openclaw(ctx: AdapterContext, json?: unknown): void {
  const base = ctx.path.split('/').at(-1);
  const format = 'openclaw-workspace-markdown (unversioned)';
  if (base === 'SOUL.md') return profile(ctx, format, 'soul', ctx.text);
  if (base === 'USER.md') return profile(ctx, format, 'user', ctx.text);
  if (base === 'AGENTS.md') return profile(ctx, format, 'agents_user', ctx.text);
  if (base === 'MEMORY.md' || /(?:^|\/)memory\/.+\.md$/.test(ctx.path)) return markdownMemories(ctx, format);
  if (/\.jsonl$/i.test(ctx.path) && Array.isArray(json) && json[0]?.type === 'session') {
    const header = json[0];
    const sessionFormat = `openclaw-pi-session-jsonl v${header.version ?? 'unknown'}`;
    if (header.version !== 3 || typeof header.id !== 'string' || typeof header.timestamp !== 'string' || typeof header.cwd !== 'string') {
      return note(ctx, 'openclaw-pi-session-jsonl (unsupported version)', 'file', 'conversation', 'Only Pi session JSONL version 3 is supported.');
    }
    note(ctx, sessionFormat, 'header', 'conversation', 'Session header identified; host paths and runtime settings are not imported.', 'ignored');
    const lines: string[] = [];
    json.slice(1).forEach((entry, i) => {
      const locator = `line:${i + 2}`;
      if (!isRecord(entry) || entry.type !== 'message' || !isRecord(entry.message)) {
        return note(ctx, sessionFormat, locator, 'conversation', 'Non-message session event or unknown event shape; not imported.', 'ignored');
      }
      if (typeof entry.id !== 'string' || (entry.parentId !== null && typeof entry.parentId !== 'string') || typeof entry.timestamp !== 'string') {
        return note(ctx, sessionFormat, locator, 'conversation', 'Message lacks the documented v3 event identity/timestamp fields.');
      }
      const message = entry.message;
      if (!['user', 'assistant'].includes(message.role)) return note(ctx, sessionFormat, locator, 'conversation', 'Tool/system/extension messages never migrate.', 'ignored');
      const content = textContent(message.content);
      if (content === null) return note(ctx, sessionFormat, locator, 'conversation', 'Unsupported message content representation.');
      if (Array.isArray(message.content) && message.content.some(block => block?.type !== 'text')) {
        note(ctx, sessionFormat, `${locator}:blocks`, 'conversation', 'Non-text blocks (tools, reasoning or attachments) are excluded.', 'ignored');
      }
      if (content) lines.push(`${message.role}:\n${content}`);
      else note(ctx, sessionFormat, locator, 'conversation', 'No visible text in this message.', 'ignored');
    });
    if (!lines.length) return note(ctx, sessionFormat, 'archive', 'conversation', 'No supported visible user/assistant messages.');
    ctx.emit(sessionFormat, 'archive', { category: 'conversation', classification: 'transformed', content: lines.join('\n\n'),
      reason: 'Visible user/assistant text only, in file order (including branches). Read-only history; never prompt context.' });
    return;
  }
  if (base === 'jobs.json') {
    ctx.emit('openclaw-cron-store (preview only; schema not imported)', 'file', { category: 'automation', classification: 'unsupported', content: ctx.text,
      reason: 'Cron store candidate shown for manual review. Schedules, payloads and delivery actions have no supported migration mapping; recreate reviewed tasks in Josi.' });
    return;
  }
  if (['HEARTBEAT.md', 'BOOT.md'].includes(base ?? '')) return note(ctx, format, 'file', 'automation',
    'Proactive/run-on-start instructions have no automatic equivalent. Review and recreate tasks manually.');
  note(ctx, 'unknown', 'file', 'workspace', 'Unsupported workspace file. Copy only files you need into your own mapped folder; connect that folder separately in Workspace.');
}
