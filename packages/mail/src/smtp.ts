// The SMTP transport.
//
// nodemailer rather than a hand-written client: SMTP is AUTH mechanisms, TLS
// upgrade, MIME encoding and line-ending rules, and writing that from scratch
// to save one well-audited dependency would be a bad trade in software
// strangers run on their own hardware.
//
// The failure mapping is the point of this file. A bounce or a rejection quotes
// the message that caused it, so the server's own text never reaches a caller,
// a response body, or the audit log — only a category an operator can act on.
import { createTransport } from 'nodemailer';
import { openCredentialPayload, type Db, type MasterKey } from '@josi-ce/core';
import { MailError, type SendErrorCategory, type SmtpTransport } from './send.js';

export interface SmtpProfile {
  kind: 'system' | 'communications';
  host: string;
  port: number;
  security: 'none' | 'starttls' | 'tls';
  username: string | null;
  password: string | null;
  fromName: string;
  fromAddress: string;
}

export class NoProfileError extends Error {}

/** Loads a profile, following copy-from-system for the credential.
 *
 * M34: the communications profile may borrow the system server while keeping
 * its own sender identity. The password then exists in exactly one row, which
 * is why this resolves rather than duplicating it. */
export async function loadProfile(
  db: Db,
  key: MasterKey,
  kind: 'system' | 'communications',
): Promise<SmtpProfile> {
  const [row] = await db.query<{
    kind: string; copy_from_system: boolean; host: string | null; port: number | null;
    security: string | null; username: string | null; password_enc: string | null;
    from_name: string | null; from_address: string | null;
  }>(`select * from smtp_profiles where kind = $1`, [kind]);
  if (!row) throw new NoProfileError(`no ${kind} mail profile is configured`);

  let server = row;
  if (row.copy_from_system) {
    const [system] = await db.query<typeof row>(`select * from smtp_profiles where kind = 'system'`);
    if (!system) throw new NoProfileError('this profile borrows the system server, and none is configured');
    server = { ...system, from_name: row.from_name, from_address: row.from_address } as typeof row;
  }

  if (!server.host || !server.port || !row.from_address) {
    throw new NoProfileError(`the ${kind} mail profile is incomplete`);
  }

  const [owner]=server.password_enc?await db.query<{id:string}>(`select id from users where role='super_admin' order by created_at limit 1`):[];
  return {
    kind: kind,
    host: server.host,
    port: server.port,
    security: (server.security ?? 'starttls') as SmtpProfile['security'],
    username: server.username,
    password: server.password_enc
      ? (await openCredentialPayload<{password:string}>(db,key,{ownerUserId:owner?.id??'',service:'smtp',slot:server.kind,stored:server.password_enc})).password
      : null,
    fromName: row.from_name ?? 'Josi',
    fromAddress: row.from_address,
  };
}

/** Turns a server's refusal into something an operator can act on.
 *
 * Deliberately coarse. The distinction that matters is what the human should
 * DO: fix credentials, fix the network, fix the address, wait, or look at the
 * message itself. */
export function classifySmtpError(err: unknown): SendErrorCategory {
  const code = String((err as { code?: string })?.code ?? '');
  const responseCode = Number((err as { responseCode?: number })?.responseCode ?? 0);
  if (code === 'EAUTH' || responseCode === 535 || responseCode === 534) return 'auth';
  if (['ECONNECTION', 'ETIMEDOUT', 'ECONNREFUSED', 'ESOCKET', 'EDNS'].includes(code)) return 'connection';
  if (responseCode === 550 || responseCode === 551 || responseCode === 553) return 'rejected_recipient';
  if (responseCode === 552 || responseCode === 554) return 'rejected_content';
  if (responseCode === 421 || responseCode === 450 || responseCode === 452) return 'rate_limited';
  return 'unknown';
}

/** The one call this module makes into nodemailer. */
export interface Transporter {
  sendMail(options: Record<string, unknown>): Promise<{ messageId?: string }>;
}

/** `transporter` is injected in tests, matching how `fetchImpl` is injected in
 * the connector and LLM packages. Mocking the module instead would test the
 * mock; this exercises the real function, which is what mutation M14 showed was
 * missing — nothing called `smtpTransport` at all, so its error sanitising was
 * unprotected. */
export function smtpTransport(profile: SmtpProfile, transporter?: Transporter): SmtpTransport {
  const mailer: Transporter = transporter ?? createTransport({
    host: profile.host,
    port: profile.port,
    secure: profile.security === 'tls',
    requireTLS: profile.security === 'starttls',
    auth: profile.username ? { user: profile.username, pass: profile.password ?? '' } : undefined,
  });

  return {
    async send(message) {
      try {
        const info = await mailer.sendMail({
          from: message.from,
          replyTo: message.replyTo,
          to: message.to,
          cc: message.cc.length ? message.cc : undefined,
          subject: message.subject,
          text: message.text,
          headers: message.headers,
          attachments: message.attachments.map((a) => ({
            filename: a.filename, contentType: a.contentType, content: a.content,
          })),
        });
        return { messageId: String(info.messageId ?? '') };
      } catch (err) {
        // The server's own words are dropped here, on purpose.
        throw new MailError('the mail server refused the message', classifySmtpError(err));
      }
    },
  };
}
