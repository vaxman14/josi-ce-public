// Who a message says it is from, and what it admits about itself.
//
// Two rules here are not negotiable and are enforced rather than documented:
//
//   M35 — mail goes out under the initiating person's name, through the
//         installation's central mailbox. "Roman via Josi" is a display
//         identity, not a forged sender: the envelope and the From address
//         belong to the installation, and the human name is attached to them.
//         Putting the person's own address in From would be a forgery that
//         SPF and DMARC would correctly reject.
//
//   M41 — every message discloses that Josi wrote it. The wording is the
//         operator's to change; its presence is not. `applyDisclosure` cannot
//         return a body without one, and the database has a length check as
//         well, because a policy row is editable by anything with database
//         access.
import { createHash } from 'node:crypto';

export interface SenderIdentity {
  /** The mailbox the installation actually sends from. */
  fromAddress: string;
  /** What a recipient sees: "Roman via Josi". */
  fromName: string;
  /** Where a reply goes: the routing address for this thread. */
  replyTo: string;
}

export class MailIdentityError extends Error {}

/** RFC 5322 display names need quoting when they contain anything interesting,
 * and a quote or backslash inside one must be escaped or the header breaks —
 * which is also how header injection starts. */
export function encodeDisplayName(name: string): string {
  const cleaned = name.replace(/[\r\n]/g, ' ').trim();
  if (!cleaned) return '';
  if (/^[A-Za-z0-9 ]+$/.test(cleaned)) return cleaned;
  return `"${cleaned.replace(/([\\"])/g, '\\$1')}"`;
}

/** A bare address, rejected if it could carry a second header.
 *
 * The check is deliberately strict rather than RFC-complete: a real address
 * that this refuses is an inconvenience, and a CRLF that it lets through is a
 * header injection. */
export function assertSafeAddress(address: string): string {
  const value = address.trim();
  if (!value || value.length > 320) throw new MailIdentityError('that is not a usable email address');
  if (/[\r\n\0<>,;]/.test(value)) throw new MailIdentityError('that email address contains illegal characters');
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) {
    throw new MailIdentityError('that does not look like an email address');
  }
  return value;
}

/** The From header for operational mail.
 *
 * `<person> via Josi` — the person's name, the installation's address. */
export function operationalSender(args: {
  personName: string;
  profileFromName: string;
  profileFromAddress: string;
  replyToAddress: string;
}): SenderIdentity {
  const person = args.personName.replace(/[\r\n]/g, ' ').trim();
  const suffix = args.profileFromName.replace(/[\r\n]/g, ' ').trim() || 'Josi';
  return {
    fromAddress: assertSafeAddress(args.profileFromAddress),
    fromName: person ? `${person} via ${suffix}` : suffix,
    replyTo: assertSafeAddress(args.replyToAddress),
  };
}

/** The reply address that routes back to one thread and one person.
 *
 * A plus-address on the installation's own mailbox. The token is random and
 * lives in the thread row; nothing about the person or the thread is derivable
 * from it, so a stranger who sees one address learns nothing about any other. */
export function replyAddressFor(profileFromAddress: string, routingToken: string): string {
  const [local, domain] = assertSafeAddress(profileFromAddress).split('@');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(routingToken)) {
    throw new MailIdentityError('routing token is not in the expected form');
  }
  return `${local}+josi.${routingToken}@${domain}`;
}

/** Pulls the routing token back out of whatever the reply was addressed to.
 *
 * Returns null rather than guessing. An inbound message whose token we cannot
 * read is quarantined, never attached to the nearest plausible thread. */
export function routingTokenFrom(address: string): string | null {
  const match = /\+josi\.([A-Za-z0-9_-]{16,64})@/.exec(address);
  return match ? match[1] : null;
}

export const DISCLOSURE_PLACEHOLDER = '{user}';
export const MIN_DISCLOSURE_LENGTH = 10;

/** M41. Appends the disclosure, and refuses to produce a body without one.
 *
 * The refusal matters more than the appending: an operator who blanks the
 * setting, or a bug that passes an empty string, must not silently produce mail
 * that reads as though a human wrote it. */
export function applyDisclosure(args: {
  body: string;
  disclosure: string;
  personName: string;
}): string {
  const text = args.disclosure.replace(DISCLOSURE_PLACEHOLDER, args.personName || 'a colleague').trim();
  if (text.length < MIN_DISCLOSURE_LENGTH) {
    throw new MailIdentityError(
      'the AI disclosure is missing or too short — it can be reworded but not removed',
    );
  }
  const body = args.body.replace(/\s+$/, '');
  // Already present (a redraft, a quoted reply): do not stack it up.
  if (body.includes(text)) return body;
  return `${body}\n\n--\n${text}`;
}

export interface MessageIdentity {
  threadId: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  attachments: Array<{ filename: string; sha256: string }>;
}

/** Everything that makes one outbound message the same as another.
 *
 * ONE canonical form, used for two things, which is why it is a function
 * returning an object rather than two similar-looking hashes:
 *
 *   * `messageFingerprint` hashes it for exactly-once delivery.
 *   * `messagePayload` IS the payload an approval pins — handed to
 *     `requestApproval`, which does its own hashing.
 *
 * Passing a fingerprint as an approval payload hashes the hash, and the
 * comparison then never matches. That bug shipped briefly and was caught by the
 * wire test rather than the unit test, because the unit test built its approval
 * row by hand instead of going through `requestApproval`. */
export function messagePayload(args: MessageIdentity): Record<string, unknown> {
  return {
    threadId: args.threadId,
    to: [...args.to].map((a) => a.toLowerCase()).sort(),
    cc: [...args.cc].map((a) => a.toLowerCase()).sort(),
    subject: args.subject.trim(),
    body: args.body.trim(),
    attachments: [...args.attachments]
      .map((a) => ({ filename: a.filename, sha256: a.sha256 }))
      .sort((x, y) => (x.sha256 < y.sha256 ? -1 : 1)),
  };
}

export function messageFingerprint(args: MessageIdentity): string {
  return createHash('sha256').update(JSON.stringify(messagePayload(args))).digest('hex');
}
