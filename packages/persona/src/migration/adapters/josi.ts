import { isRecord } from '../types.js';
import { memory, note, profile, type AdapterContext } from './shared.js';

export interface PortableMemory { content: string; provenance: string; pinned: boolean }
export function renderPortableMemories(memories: PortableMemory[]): string {
  return memories.map(m => `- ${m.pinned ? '**' : ''}${m.content}${m.pinned ? '**' : ''}  <!-- ${m.provenance} -->`).join('\n') + (memories.length ? '\n' : '');
}

export function josi(ctx: AdapterContext, bundle: unknown): void {
  if (!isRecord(bundle) || bundle.version !== 1 || !isRecord(bundle.files)) {
    return note(ctx, 'unknown', 'file', 'workspace', 'Not a Josi version-1 profile export.');
  }
  for (const [key, value] of Object.entries(bundle.files)) {
    if (['soul', 'user', 'agents_user'].includes(key) && typeof value === 'string') {
      profile(ctx, 'josi-profile-bundle v1', key as 'soul' | 'user' | 'agents_user', value, true);
    } else if (key === 'memory' && typeof value === 'string') {
      let records: PortableMemory[] = [];
      if (bundle.memory_records !== undefined) {
        if (!Array.isArray(bundle.memory_records) || !bundle.memory_records.every((m: unknown) =>
          isRecord(m) && typeof m.content === 'string' && typeof m.provenance === 'string' && m.provenance.length <= 2000 && typeof m.pinned === 'boolean')
          || renderPortableMemories(bundle.memory_records) !== value) {
          note(ctx, 'josi-memory-records v1', 'memory', 'memory', 'Memory records disagree with MEMORY text or have an invalid shape.');
          continue;
        }
        records = bundle.memory_records;
      } else {
        // Legacy v1 has no escaping. Accept only unambiguous single-line rows;
        // never silently split multiline content or invent provenance.
        const lines = value.replace(/\r\n/g, '\n').split('\n').filter(Boolean);
        let valid = true;
        for (const line of lines) {
          const match = /^- (.+)  <!-- ([^<>\r\n]*) -->$/.exec(line);
          if (!match || match[1].includes('<!--')) { valid = false; break; }
          const pinned = match[1].startsWith('**') && match[1].endsWith('**');
          records.push({ content: pinned ? match[1].slice(2, -2) : match[1], pinned, provenance: match[2] });
        }
        if (!valid) { note(ctx, 'josi-memory-markdown v1', 'memory', 'memory', 'Ambiguous legacy MEMORY text. Re-export with structured memory records, or review it as external Markdown.'); continue; }
      }
      records.forEach((m, i) => memory(ctx, 'josi-memory-records v1', `memory:${i + 1}`, m.content, m.pinned, m.provenance));
      if (!records.length) note(ctx, 'josi-memory-records v1', 'memory', 'memory', 'Empty memory export.', 'ignored');
    } else {
      note(ctx, 'josi-profile-bundle v1', `file:${key}`, 'workspace', key === 'agents_admin'
        ? 'Installation policy is never imported from a personal bundle.' : 'Unsupported bundle field or value.', 'ignored');
    }
  }
}
