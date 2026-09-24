import type { Db } from '@josi-ce/core';

export class EmailTemplateError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export interface EmailTemplateInput {
  name: string; subject: string; heading: string; body: string; accentColor: string;
  ctaLabel: string; ctaUrl: string; footer: string;
}
export interface EmailTemplate extends EmailTemplateInput { id: string; updated_at: string }
export type MergeValues = Record<'recipient' | 'name' | 'date' | 'time', string>;
export interface RenderedEmail { subject: string; text: string; html: string }
export interface FrozenEmail extends RenderedEmail { templateId: string; template: EmailTemplateInput; values: MergeValues }
const limits: Record<keyof EmailTemplateInput, number> = {
  name: 120, subject: 300, heading: 300, body: 30000, accentColor: 7, ctaLabel: 120, ctaUrl: 2000, footer: 2000,
};
export const escapeEmailText = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function url(value: string): void {
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || /[\s<>"'{}]/.test(value)) throw new Error();
  } catch { throw new EmailTemplateError('CTA URL must be an absolute http or https URL without credentials or merge fields.'); }
}
export function validateEmailTemplate(value: unknown): EmailTemplateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EmailTemplateError('A structured template is required.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(k => !Object.hasOwn(limits, k))) throw new EmailTemplateError('Unknown template field. Raw HTML is not supported.');
  const result = {} as EmailTemplateInput;
  for (const key of Object.keys(limits) as (keyof EmailTemplateInput)[]) {
    const v = input[key] ?? '';
    if (typeof v !== 'string' || v.length > limits[key] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) throw new EmailTemplateError(`Invalid ${key} (maximum ${limits[key]} characters).`);
    result[key] = v.trim();
    if (key !== 'name' && key !== 'ctaUrl' && key !== 'accentColor') {
      const remaining = v.replace(/\{\{(recipient|name|date|time)\}\}/g, '');
      if (/[{}]/.test(remaining)) throw new EmailTemplateError('Use only {{recipient}}, {{name}}, {{date}}, and {{time}} merge fields.');
    }
  }
  if (!result.name || !result.subject || !result.body) throw new EmailTemplateError('Name, subject, and body are required.');
  if (/[\r\n]/.test(result.subject)) throw new EmailTemplateError('Subject must be a single line.');
  if (!/^#[0-9a-f]{6}$/i.test(result.accentColor)) throw new EmailTemplateError('Accent color must be a six-digit hex color.');
  if (!!result.ctaLabel !== !!result.ctaUrl) throw new EmailTemplateError('Provide both CTA label and URL, or leave both empty.');
  if (result.ctaUrl) url(result.ctaUrl);
  return result;
}
export function emailMergeValues(input: unknown, recipient: string): MergeValues {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const values = input as Record<string, unknown>;
  if (Object.keys(values).some(k => !['name', 'date', 'time'].includes(k))) throw new EmailTemplateError('Merge values may contain only name, date, and time. Recipient comes from the To address.');
  const result: MergeValues = { recipient, name: '', date: '', time: '' };
  for (const k of ['name', 'date', 'time'] as const) {
    if (values[k] !== undefined && (typeof values[k] !== 'string' || (values[k] as string).length > 500)) throw new EmailTemplateError(`Invalid merge value: ${k}.`);
    result[k] = (values[k] as string | undefined) ?? '';
  }
  return result;
}
export function renderEmailTemplate(input: EmailTemplateInput, values: MergeValues): RenderedEmail {
  const template = validateEmailTemplate(input);
  if (!values || typeof values !== 'object') throw new EmailTemplateError('Merge values are required.');
  const merge = (v: string) => v.replace(/\{\{(recipient|name|date|time)\}\}/g, (_, k: keyof MergeValues) => {
    if (typeof values[k] !== 'string' || !values[k].trim() || values[k].length > 500 || /[\u0000-\u001f\u007f]/.test(values[k])) throw new EmailTemplateError(`Provide a value for {{${k}}}.`);
    return values[k];
  });
  const subject = merge(template.subject);
  if (subject.length > 998 || /[\r\n]/.test(subject)) throw new EmailTemplateError('Rendered subject is invalid.');
  const heading = merge(template.heading), body = merge(template.body), footer = merge(template.footer), cta = merge(template.ctaLabel);
  const e = escapeEmailText;
  const paragraphs = (v: string) => v.split(/\n\s*\n/).map(p => `<p style="margin:0 0 18px;line-height:1.65">${e(p).replace(/\n/g, '<br>')}</p>`).join('');
  return {
    subject,
    text: [heading, body, cta ? `${cta}: ${template.ctaUrl}` : '', footer].filter(Boolean).join('\n\n'),
    html: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"></head><body style="margin:0;background:#f1f5f9;color:#172033;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:24px 12px"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;margin:auto;background:#ffffff;border-top:6px solid ${template.accentColor};border-radius:8px"><tr><td style="padding:32px;overflow-wrap:anywhere">${heading ? `<h1 style="font-size:26px;line-height:1.25;margin:0 0 24px">${e(heading)}</h1>` : ''}${paragraphs(body)}${cta ? `<p style="margin:28px 0"><a href="${e(template.ctaUrl)}" style="display:inline-block;border:2px solid ${template.accentColor};border-radius:6px;padding:12px 22px;color:#172033;text-decoration:none;font-weight:bold">${e(cta)}</a></p>` : ''}${footer ? `<div style="border-top:1px solid #e2e8f0;padding-top:20px;color:#475569;font-size:13px">${paragraphs(footer)}</div>` : ''}</td></tr></table></td></tr></table></body></html>`,
  };
}
function fromRow(row: { id: string; content: EmailTemplateInput; updated_at: string }): EmailTemplate { return { ...row.content, id: row.id, updated_at: row.updated_at }; }
export async function listEmailTemplates(db: Db, owner: string): Promise<EmailTemplate[]> {
  return (await db.query<{id:string;content:EmailTemplateInput;updated_at:string}>(`select id, content, updated_at from email_templates where owner_user_id=$1 order by name,id`, [owner])).map(fromRow);
}
export async function resolveEmailTemplate(db: Db, owner: string, selector: { id?: unknown; name?: unknown }): Promise<EmailTemplate> {
  if ((selector.id === undefined) === (selector.name === undefined)) throw new EmailTemplateError('Supply exactly one template_id or template_name.');
  const key = selector.id ?? selector.name;
  if (typeof key !== 'string' || !key || key.length > 120) throw new EmailTemplateError('Invalid template selector.');
  const rows = await db.query<{id:string;content:EmailTemplateInput;updated_at:string}>(`select id,content,updated_at from email_templates where owner_user_id=$1 and ${selector.id !== undefined ? 'id::text' : 'name'}=$2 limit 2`, [owner, key]);
  if (!rows.length) throw new EmailTemplateError('Template not found.', 404);
  if (rows.length !== 1) throw new EmailTemplateError('That template name is ambiguous. Select an exact template ID.', 409);
  return fromRow(rows[0]);
}
export async function saveEmailTemplate(db: Db, owner: string, value: unknown, id?: string): Promise<EmailTemplate> {
  const content = validateEmailTemplate(value);
  const rows = await db.query<{id:string;content:EmailTemplateInput;updated_at:string}>(id
    ? `update email_templates set name=$2,content=$3,updated_at=now() where owner_user_id=$1 and id::text=$4 returning id,content,updated_at`
    : `insert into email_templates(owner_user_id,name,content) values($1,$2,$3) returning id,content,updated_at`,
  id ? [owner, content.name, JSON.stringify(content), id] : [owner, content.name, JSON.stringify(content)]);
  if (!rows.length) throw new EmailTemplateError('Template not found.', 404);
  return fromRow(rows[0]);
}
export async function deleteEmailTemplate(db: Db, owner: string, id: string): Promise<void> {
  const rows = await db.query(`delete from email_templates where owner_user_id=$1 and id::text=$2 returning id`, [owner, id]);
  if (!rows.length) throw new EmailTemplateError('Template not found.', 404);
}
export async function freezeEmailTemplate(db: Db, owner: string, selector: {id?:unknown;name?:unknown}, recipient: string, merge: unknown): Promise<FrozenEmail> {
  const { id, updated_at: _, ...template } = await resolveEmailTemplate(db, owner, selector);
  const values = emailMergeValues(merge, recipient);
  return { templateId: id, template, values, ...renderEmailTemplate(template, values) };
}
/** Verify a frozen snapshot without consulting the mutable template or clock. */
export function verifyFrozenEmail(value: unknown): FrozenEmail {
  if (!value || typeof value !== 'object') throw new EmailTemplateError('Missing rendered email.');
  const frozen = value as FrozenEmail;
  const rendered = renderEmailTemplate(frozen.template, frozen.values);
  if (rendered.subject !== frozen.subject || rendered.text !== frozen.text || rendered.html !== frozen.html) throw new EmailTemplateError('Rendered email does not match its safe template snapshot.');
  return frozen;
}
