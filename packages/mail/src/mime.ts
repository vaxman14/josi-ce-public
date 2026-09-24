import { randomBytes } from 'node:crypto';
import type { RenderedEmail } from './templates.js';

/** Both provider APIs accept MIME. Base64 parts preserve the approved UTF-8 bytes. */
export function renderedEmailMime(email: RenderedEmail, to: string, cc: string[]): string {
  const addresses = [to, ...cc];
  if (addresses.some(a => !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(a))) throw new Error('Invalid email address.');
  if (/[\r\n]/.test(email.subject)) throw new Error('Invalid subject.');
  const boundary = `josi_${randomBytes(18).toString('hex')}`;
  const encode = (v: string) => Buffer.from(v, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  // Fold encoded words on Unicode character boundaries.
  const chunks: string[] = []; let chunk = '';
  for (const c of email.subject) { if (Buffer.byteLength(chunk + c) > 42) { chunks.push(chunk); chunk = ''; } chunk += c; }
  if (chunk) chunks.push(chunk);
  const subject = chunks.map(c => `=?UTF-8?B?${Buffer.from(c).toString('base64')}?=`).join('\r\n ');
  return [`To: ${to}`, ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []), `Subject: ${subject}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', encode(email.text),
    `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', encode(email.html),
    `--${boundary}--`, ''].join('\r\n');
}
