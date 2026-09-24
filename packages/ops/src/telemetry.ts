// Telemetry and the support contract.
//
// M98: opt-in only, off unless affirmatively enabled, and NEVER prompts,
// message/email/contact/calendar content, credentials, secrets, or identifiable
// business data.
//
// The payload below is built from an explicit allowlist of scalar fields. Not a
// serialised object with sensitive keys removed — an allowlist, because the
// removal approach fails the first time somebody adds a field and forgets the
// filter, and telemetry is exactly the subsystem where that failure is silent
// and permanent.
//
// M111: the installation id is a locally generated random UUID. It is not
// derived from hardware, and it exists for support correlation and rate
// limiting, not for identifying a business.
import { appendEvent, json, type Db } from '@josi-ce/core';
import { UnsafeEndpointError, validateEndpoint } from '@josi-ce/llm';

export class TelemetryError extends Error {}

/** Every field that may ever be transmitted. The test asserts this exact set. */
export const ALLOWED_FIELDS = [
  'installationId',
  'version',
  'platform',
  'arch',
  'features',
  'userCount',
  'threadCount',
  'documentCount',
  'errorCounts',
  'uptimeSeconds',
] as const;
export type AllowedField = (typeof ALLOWED_FIELDS)[number];

export interface TelemetryFacts {
  installationId: string;
  version: string;
  platform: string;
  arch: string;
  /** Which features are switched on. Booleans, never configuration values. */
  features: Record<string, boolean>;
  /** Counts. How many, never which. */
  userCount: number;
  threadCount: number;
  documentCount: number;
  errorCounts: Record<string, number>;
  uptimeSeconds: number;
}

/**
 * Build the payload.
 *
 * Two properties, both asserted by tests:
 *
 *   1. Only allowlisted keys appear, whatever the caller passes.
 *   2. Every leaf is a number, boolean, or a short identifier-shaped string —
 *      never free text. Free text is where content leaks: a feature name is
 *      safe, an error MESSAGE is not, because messages quote the thing that
 *      failed.
 */
export function buildPayload(facts: Partial<TelemetryFacts> & { installationId: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of ALLOWED_FIELDS) {
    const value = (facts as Record<string, unknown>)[field];
    if (value === undefined || value === null) continue;

    if (typeof value === 'number' || typeof value === 'boolean') {
      out[field] = value;
      continue;
    }
    if (typeof value === 'string') {
      // Identifier-shaped only. A version, a platform, a uuid — never a sentence.
      if (!/^[A-Za-z0-9._:-]{1,64}$/.test(value)) {
        throw new TelemetryError(`telemetry field ${field} is not in an allowed form`);
      }
      out[field] = value;
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested: Record<string, number | boolean> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(k)) continue;
        // Only counts and flags below the top level. This is what stops an
        // `errorCounts` map from carrying a message as a key's value.
        if (typeof v === 'number' || typeof v === 'boolean') nested[k] = v;
      }
      out[field] = nested;
      continue;
    }
    throw new TelemetryError(`telemetry field ${field} is not in an allowed form`);
  }
  return out;
}

/** Exactly what an operator is shown at setup, before choosing. M98 requires
 * setup to explain what is sent; this is that text, and the test asserts the
 * payload cannot contain anything it does not mention. */
export const TELEMETRY_DISCLOSURE =
  'If you turn this on, Josi sends: a random installation ID that is generated here and '
  + 'is not derived from your hardware, the Josi version, your platform and CPU '
  + 'architecture, which features are switched on, how many users, conversations and '
  + 'documents exist, counts of errors by type, and how long the installation has been '
  + 'running. It never sends messages, emails, documents, contacts, calendar entries, '
  + 'prompts, credentials, or anything identifying you or your business. It is off unless '
  + 'you turn it on, and you can turn it off again at any time.';

/** An outbound URL an administrator typed.
 *
 * Phase 4 built this guard for model providers and Phase 10 introduced two more
 * URLs the server fetches — the telemetry endpoint and the support gateway —
 * without routing either through it. That is the gap this closes.
 *
 * The reasoning from `packages/llm/src/ssrf.ts` applies unchanged: the person
 * setting this already administers the host, so the classic SSRF threat is
 * absent, but cloud metadata still is not. An operator who pastes
 * 169.254.169.254 should not hand their cloud role's credentials to whatever
 * answers.
 */
export async function assertOutboundUrlSafe(
  url: string,
  resolveImpl?: (hostname: string) => Promise<string[]>,
): Promise<void> {
  await validateEndpoint(url, { resolve: resolveImpl });
}

export async function setTelemetry(
  db: Db,
  args: {
    enabled: boolean; endpoint?: string | null; byUserId: string;
    resolveImpl?: (hostname: string) => Promise<string[]>;
  },
): Promise<void> {
  // Checked when it is SET, so a bad endpoint is refused while somebody is
  // looking at the screen rather than failing later in a background send.
  if (args.enabled && args.endpoint) {
    await assertOutboundUrlSafe(args.endpoint, args.resolveImpl);
  }
  // Phase 3's constraint is `enabled = false or opted_in_at is not null`, so
  // enabling without recording when somebody agreed is impossible — the
  // database refuses it. Setting the timestamp here is honouring that rule, not
  // working around it.
  await db.query(
    `update telemetry_state set
       enabled = $1,
       -- Cleared whenever telemetry is off, whatever the caller passed. A
       -- stored endpoint on a disabled installation is a loaded gun: the next
       -- thing that flips the enabled flag starts transmitting immediately.
       endpoint = case when $1 then $2 else null end,
       opted_in_at = case when $1 then coalesce(opted_in_at, now()) else opted_in_at end
     where id = true`,
    [args.enabled, args.endpoint ?? null],
  );
  await appendEvent(db, {
    actorUserId: args.byUserId,
    actor: 'super_admin',
    kind: args.enabled ? 'telemetry.enabled' : 'telemetry.disabled',
    payload: {},
  });
}

export interface TelemetrySender {
  send(endpoint: string, payload: Record<string, unknown>): Promise<void>;
}

/**
 * Send, if and only if it was affirmatively enabled.
 *
 * The check is here rather than at the caller because "off unless enabled" has
 * to survive a caller that forgets. Returns what it did so the caller can say
 * so plainly rather than implying a send happened.
 */
export async function sendTelemetry(
  db: Db,
  args: {
    facts: Partial<TelemetryFacts> & { installationId: string };
    sender: TelemetrySender;
    resolveImpl?: (hostname: string) => Promise<string[]>;
  },
): Promise<{ sent: boolean; reason?: string; payload?: Record<string, unknown> }> {
  const [state] = await db.query<{ enabled: boolean; endpoint: string | null }>(
    `select enabled, endpoint from telemetry_state where id = true`,
  );
  if (!state?.enabled) return { sent: false, reason: 'telemetry is off' };
  if (!state.endpoint) return { sent: false, reason: 'no endpoint is configured' };

  // And again at SEND time. A hostname that resolved to something benign when
  // it was saved can resolve to metadata now — checking only at save time is
  // checking the wrong moment.
  try {
    await assertOutboundUrlSafe(state.endpoint, args.resolveImpl);
  } catch (err) {
    if (err instanceof UnsafeEndpointError) {
      await db.query(
        `update telemetry_state set last_status = 'failed',
           consecutive_failures = consecutive_failures + 1 where id = true`,
      );
      return { sent: false, reason: 'that endpoint is not a safe destination' };
    }
    throw err;
  }

  const payload = buildPayload(args.facts);
  try {
    await args.sender.send(state.endpoint, payload);
  } catch {
    await db.query(
      `update telemetry_state set last_status = 'failed',
         consecutive_failures = consecutive_failures + 1 where id = true`,
    );
    return { sent: false, reason: 'the endpoint could not be reached' };
  }

  // Kept so a suspicious operator can read exactly what left, rather than
  // taking our word for it.
  await db.query(
    `update telemetry_state set last_sent_at = now(), last_status = 'ok',
       consecutive_failures = 0, last_payload = $1 where id = true`,
    [json(payload)],
  );
  return { sent: true, payload };
}

// ---------------------------------------------------------------------------
// Support (M102, M104, M105, M107, M115)
// ---------------------------------------------------------------------------

export type TicketCategory = 'bug_report' | 'feature_request' | 'paid_support' | 'security_privacy';

/** M105: mandatory for bug reports and paid support; optional otherwise. */
export function diagnosticsRequired(category: TicketCategory): boolean {
  return category === 'bug_report' || category === 'paid_support';
}

/** M107: what the submitter has to acknowledge, per category. Saying "we may
 * never reply" before someone spends an hour writing a report is more honest
 * than an auto-responder saying it afterwards. */
export function acknowledgementFor(category: TicketCategory): string {
  switch (category) {
    case 'paid_support':
      return 'Submitting this is a request to be contacted about paid support. It is not a '
        + 'purchase, it does not guarantee a response, and no work has been agreed.';
    case 'security_privacy':
      return 'Please do not attach unrelated data. If your report involves a specific document '
        + 'or message, describe it rather than uploading it.';
    case 'feature_request':
      return 'Feature requests are read but carry no guarantee of a response or of being built.';
    case 'bug_report':
    default:
      return 'Bug reports carry no guaranteed response or fix. A diagnostics bundle is required, '
        + 'and you will be shown exactly what it contains before anything is sent.';
  }
}

/** M115: CE knows only an abstract gateway URL, unset by default.
 *
 * With no gateway configured the support page explains how to file an issue
 * manually. It does not post anywhere by default, and there is no credential
 * anywhere in this repository. */
export function gatewayStatus(url: string | null | undefined): {
  configured: boolean; message: string;
} {
  if (!url) {
    return {
      configured: false,
      message: 'No support gateway is configured for this installation, so nothing is sent '
        + 'anywhere. You can still create a bundle, read it, and send it yourself.',
    };
  }
  return {
    configured: true,
    message: 'Your administrator has configured a support gateway. Nothing is sent until you '
      + 'have read the bundle and approved it.',
  };
}

export class SupportError extends Error {}

export async function submitTicket(
  db: Db,
  args: {
    ticketId: string;
    userId: string;
    /** The gateway, or null. Null means nothing is transmitted. */
    gatewayUrl: string | null;
    resolveImpl?: (hostname: string) => Promise<string[]>;
  },
): Promise<{ submitted: boolean; reason?: string }> {
  const [ticket] = await db.query<{
    category: TicketCategory;
    bundle_id: string | null;
    acknowledged_no_guarantee: boolean;
    created_by: string | null;
  }>(
    `select category, bundle_id, acknowledged_no_guarantee, created_by
     from support_tickets where id = $1`,
    [args.ticketId],
  );
  if (!ticket) throw new SupportError('no such ticket');
  if (ticket.created_by !== args.userId) throw new SupportError('no such ticket');

  if (!ticket.acknowledged_no_guarantee) {
    throw new SupportError('the acknowledgement has not been accepted');
  }
  if (diagnosticsRequired(ticket.category) && !ticket.bundle_id) {
    throw new SupportError('this kind of report needs a diagnostics bundle');
  }

  if (ticket.bundle_id) {
    const [bundle] = await db.query<{
      inspected_at: string | null; approved_at: string | null; secret_scan_passed_at: string | null;
    }>(
      `select inspected_at, approved_at, secret_scan_passed_at
       from diagnostic_bundles where id = $1`,
      [ticket.bundle_id],
    );
    if (!bundle?.inspected_at || !bundle.approved_at || !bundle.secret_scan_passed_at) {
      throw new SupportError('the bundle has not been read, approved and scanned');
    }
  }

  if (!args.gatewayUrl) {
    return { submitted: false, reason: 'no support gateway is configured, so nothing was sent' };
  }
  // A bundle is about to leave the installation. Where it goes gets the same
  // check as any other outbound URL.
  try {
    await assertOutboundUrlSafe(args.gatewayUrl, args.resolveImpl);
  } catch (err) {
    if (err instanceof UnsafeEndpointError) {
      return { submitted: false, reason: 'the configured support gateway is not a safe destination' };
    }
    throw err;
  }

  await db.query(
    `update support_tickets set state = 'submitted', submitted_at = now() where id = $1`,
    [args.ticketId],
  );
  await appendEvent(db, {
    actorUserId: args.userId,
    actor: 'user',
    kind: 'support.submitted',
    subjectType: 'support_ticket',
    subjectId: args.ticketId,
    // The category. Never the description — that is the user's words about
    // their own installation.
    payload: { category: ticket.category, withBundle: !!ticket.bundle_id },
  });
  return { submitted: true };
}
