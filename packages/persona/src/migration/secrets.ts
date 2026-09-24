import { refuseSecret } from '../memory.js';

// Imported filenames, metadata, ignored fields and decoded JSON strings are
// scanned too. A refusal returns only a fixed reason, never the matched text.
export function migrationSecret(text: string): string | null {
  const normalized = text.normalize('NFKC');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(normalized)) {
    return 'Invisible/control characters require removal before import.';
  }
  if (refuseSecret(normalized)) return 'Likely credentials, private keys or payment data; file refused.';
  const patterns = [
    /\b(?:password|passwd|passphrase|credential(?:s)?|api[_ .-]?key|access[_ .-]?token|refresh[_ .-]?token|id[_ .-]?token|client[_ .-]?secret|secret(?:[_ .-]?(?:access[_ .-]?key|key))?|session[_ .-]?(?:key|token)|authorization|cookie|set-cookie)\b["']?\s*[:=]\s*["']?\S+/i,
    /\b(?:aws_secret_access_key|azure_client_secret|npm_auth_token|_authToken)\s*=\s*\S+/i,
    /\b(?:password|token|credential|cookie|api key|secret)\s+(?:is|was)\s+\S+/i,
    /\b(?:sk-|xai-|gh[pousr]_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{16,}/,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
    /[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@/i,
    /\b(?:cvv|cvc|iban|routing[_ -]?number|bank[_ -]?account)\s*["']?\s*[:=]\s*\S+/i,
    /\b(?:private[_ -]?key|provider[_ -]?credentials|oauth[_ -]?session)\b\s*["']?\s*[:=]/i,
  ];
  return patterns.some(pattern => pattern.test(normalized))
    ? 'Likely credentials, sessions or payment data; file refused.' : null;
}

export function secretPath(path: string): boolean {
  return /(?:^|\/)(?:\.env(?:\..*)?|auth(?:-profiles)?\.json|credentials(?:\.[^/]*)?|cookies?(?:\.[^/]*)?|tokens?(?:\.[^/]*)?|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx))(?:\/|$)/i.test(path)
    || migrationSecret(path) !== null;
}

export function decodedSecret(value: unknown): string | null {
  // Iterative walk avoids a stack overflow from adversarial JSON nesting.
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length) {
    if (++visited > 50_000) return 'JSON has too many values to inspect safely.';
    const item = pending.pop();
    if (typeof item === 'string') { const reason = migrationSecret(item); if (reason) return reason; }
    else if (item && typeof item === 'object') {
      for (const [key, val] of Object.entries(item)) {
        // Numeric timestamps/counters are data, not card numbers. Credential
        // labels still refuse numeric values; other numbers are scanned.
        const numericMetadata = /^(?:timestamp|started_at|ended_at|created_at|updated_at|id|parentId|input_tokens|output_tokens|message_count)$/.test(key);
        const scalar = typeof val === 'string' || (typeof val === 'number' && !numericMetadata) ? String(val) : '';
        const reason = migrationSecret(`${key}: ${scalar}`);
        if (reason) return reason;
        pending.push(val);
      }
    }
  }
  return null;
}
