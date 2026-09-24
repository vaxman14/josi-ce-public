// The real SMTP transport.
//
// Found by Phase 8 mutation M14: making `smtpTransport` throw the mail server's
// own message left all 510 tests passing, because every other test injects a
// stub transport and this function — the one production actually uses — was
// never called at all.
//
// That matters specifically here. A bounce or a rejection QUOTES THE MESSAGE
// THAT CAUSED IT, so an SMTP error string can contain the subject, the body, or
// the recipient list of somebody's mail. Passing it through would put that in
// an API response and in the logs.
//
// The transporter is injected rather than the module mocked, matching how
// `fetchImpl` is injected in the connector and LLM packages. No mail server is
// contacted.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MailError } from '../src/send.js';
import { classifySmtpError, smtpTransport, type SmtpProfile, type Transporter } from '../src/smtp.js';

const PROFILE: SmtpProfile = {
  kind: 'communications',
  host: 'smtp.example.test', port: 587, security: 'starttls',
  username: 'u', password: 'SMTP-PASSWORD', fromName: 'Josi', fromAddress: 'josi@example.test',
};

const message = {
  from: 'Alice via Josi <josi@example.test>',
  replyTo: 'josi+josi.tok@example.test',
  to: ['client@example.test'], cc: [] as string[],
  subject: 'Thursday', text: 'body',
  headers: {} as Record<string, string>,
  attachments: [] as Array<{ filename: string; contentType: string; content: Buffer }>,
};

let sendMail: ReturnType<typeof vi.fn>;
const transporter = (): Transporter => ({ sendMail: sendMail as never });

beforeEach(() => {
  sendMail = vi.fn(async () => ({ messageId: '<ok@example.test>' }));
});

/** Runs the send and returns whatever it threw.
 *
 * A test that asserted inside a `.catch()` would pass silently if the call
 * unexpectedly succeeded, so this fails loudly instead. */
async function failedSend(): Promise<MailError> {
  try {
    await smtpTransport(PROFILE, transporter()).send(message);
  } catch (err) {
    return err as MailError;
  }
  throw new Error('the send was expected to fail and did not');
}

describe('the SMTP transport', () => {
  it('passes a successful send through', async () => {
    const result = await smtpTransport(PROFILE, transporter()).send(message);
    expect(result.messageId).toBe('<ok@example.test>');
  });

  it('never repeats the server text, which quotes the message that bounced', async () => {
    // A real 550 looks like this: the rejected recipient, and often a fragment
    // of the message, come back inside the response.
    sendMail = vi.fn(async () => {
      throw Object.assign(
        new Error('550 5.1.1 <client@example.test> rejected: "Thursday" SECRET-BODY-FRAGMENT'),
        { responseCode: 550 },
      );
    });

    const thrown = await failedSend();
    expect(thrown).toBeInstanceOf(MailError);
    expect(thrown.message).not.toContain('SECRET-BODY-FRAGMENT');
    expect(thrown.message).not.toContain('client@example.test');
    expect(thrown.message).not.toContain('Thursday');
    // What it DOES carry: a category an operator can act on.
    expect(thrown.category).toBe('rejected_recipient');
  });

  it('never leaks the SMTP password in an error', async () => {
    sendMail = vi.fn(async () => {
      throw Object.assign(new Error('535 auth failed for user u with SMTP-PASSWORD'), { code: 'EAUTH' });
    });
    const thrown = await failedSend();
    expect(thrown.message).not.toContain('SMTP-PASSWORD');
    expect(thrown.category).toBe('auth');
  });

  it('maps each failure to what the operator should do about it', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ code: 'EAUTH' }, 'auth'],
      [{ code: 'ECONNREFUSED' }, 'connection'],
      [{ responseCode: 550 }, 'rejected_recipient'],
      [{ responseCode: 552 }, 'rejected_content'],
      [{ responseCode: 421 }, 'rate_limited'],
      [{}, 'unknown'],
    ];
    for (const [props, expected] of cases) {
      sendMail = vi.fn(async () => { throw Object.assign(new Error('anything'), props); });
      const thrown = await failedSend();
      expect(thrown.category, JSON.stringify(props)).toBe(expected);
      expect(classifySmtpError(Object.assign(new Error('x'), props))).toBe(expected);
    }
  });

  it('hands the mailer what it was given, unaltered', async () => {
    const transport = smtpTransport(PROFILE, transporter());
    await transport.send({
      ...message,
      cc: ['cc@example.test'],
      headers: { 'Auto-Submitted': 'auto-generated' },
      attachments: [{ filename: 'f.pdf', contentType: 'application/pdf', content: Buffer.from('x') }],
    });
    const call = sendMail.mock.calls[0][0] as Record<string, any>;
    expect(call.from).toBe(message.from);
    expect(call.replyTo).toBe(message.replyTo);
    expect(call.cc).toEqual(['cc@example.test']);
    expect(call.headers['Auto-Submitted']).toBe('auto-generated');
    expect(call.attachments[0].filename).toBe('f.pdf');
  });

  it('omits cc entirely when there is none, rather than sending an empty header', async () => {
    await smtpTransport(PROFILE, transporter()).send(message);
    expect((sendMail.mock.calls[0][0] as Record<string, unknown>).cc).toBeUndefined();
  });
});
