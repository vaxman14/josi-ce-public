// Reading mail at Google and Microsoft. Read-only, and shaped for a tool
// result rather than for a sync engine: no cursors, no deltas — a bounded
// search and a single fetch, each capped so a model cannot ask for a mailbox.
//
// One shape in and out, two dialects underneath, exactly as contacts.ts does
// it. Nothing here logs a message body or a provider error sentence: a mail
// API's error message quotes somebody's mail.
import type { Provider } from '../capabilities.js';
import { ConnectorError, type FetchOptions } from '../providers.js';
import { providerRequest, raiseProviderError, str } from './http.js';

/** One message as a search result: enough to recognise it, not its content. */
export interface EmailSummary {
  /** The provider's own id. Stable for the life of the message. */
  sourceId: string;
  from: string | null;
  to: string[];
  subject: string | null;
  /** ISO 8601 when the provider gave a parseable time. */
  date: string | null;
  /** The provider's own preview line, when it offers one. */
  snippet: string | null;
}

export interface EmailFull extends EmailSummary {
  body: string;
  /** 'text' or 'html' — Graph often only has HTML. The caller decides how
   * much markup to pass along. */
  bodyKind: 'text' | 'html';
  truncated: boolean;
}

/** The most results a search may return, whatever the caller asked for. */
export const MAIL_SEARCH_CAP = 10;
/** Characters of body a read returns before honestly saying "truncated". */
export const MAIL_BODY_CAP = 8_000;

export interface MailSearchArgs {
  accessToken: string;
  /** Provider-native query syntax is allowed (Gmail operators work). */
  query: string;
  limit?: number;
}

export async function searchMail(
  provider: Provider,
  args: MailSearchArgs,
  opts: FetchOptions = {},
): Promise<EmailSummary[]> {
  const limit = Math.max(1, Math.min(args.limit ?? MAIL_SEARCH_CAP, MAIL_SEARCH_CAP));
  return provider === 'google' ? searchGmail(args, limit, opts) : searchGraph(args, limit, opts);
}

export async function readMail(
  provider: Provider,
  args: { accessToken: string; id: string },
  opts: FetchOptions = {},
): Promise<EmailFull | null> {
  return provider === 'google' ? readGmail(args, opts) : readGraphMail(args, opts);
}

// ------------------------------------------------------------------- Google

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface GmailHeader { name?: unknown; value?: unknown }
interface GmailPart {
  mimeType?: unknown;
  body?: { data?: unknown };
  parts?: GmailPart[];
}
interface GmailMessage {
  id?: unknown;
  snippet?: unknown;
  internalDate?: unknown;
  payload?: GmailPart & { headers?: GmailHeader[] };
}

function gmailHeader(msg: GmailMessage, name: string): string | null {
  const found = (msg.payload?.headers ?? []).find(
    (h) => typeof h?.name === 'string' && h.name.toLowerCase() === name.toLowerCase(),
  );
  return str(found?.value);
}

function gmailDate(msg: GmailMessage): string | null {
  const ms = Number(msg.internalDate);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  const header = gmailHeader(msg, 'Date');
  if (!header) return null;
  const parsed = new Date(header);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function gmailSummary(msg: GmailMessage): EmailSummary | null {
  const sourceId = str(msg.id);
  if (!sourceId) return null;
  return {
    sourceId,
    from: gmailHeader(msg, 'From'),
    to: (gmailHeader(msg, 'To') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    subject: gmailHeader(msg, 'Subject'),
    date: gmailDate(msg),
    snippet: str(msg.snippet),
  };
}

/** Depth-first for a text/plain part; html only when no plain text exists. */
function gmailBody(part: GmailPart | undefined): { text: string; kind: 'text' | 'html' } | null {
  if (!part) return null;
  const decode = (data: unknown): string | null => {
    if (typeof data !== 'string' || !data) return null;
    try { return Buffer.from(data, 'base64url').toString('utf8'); } catch { return null; }
  };
  const walk = (p: GmailPart, want: string): string | null => {
    if (p.mimeType === want) {
      const text = decode(p.body?.data);
      if (text) return text;
    }
    for (const child of p.parts ?? []) {
      const found = walk(child, want);
      if (found) return found;
    }
    return null;
  };
  const plain = walk(part, 'text/plain');
  if (plain) return { text: plain, kind: 'text' };
  const html = walk(part, 'text/html');
  if (html) return { text: html, kind: 'html' };
  return null;
}

async function searchGmail(args: MailSearchArgs, limit: number, opts: FetchOptions): Promise<EmailSummary[]> {
  const params = new URLSearchParams({ q: args.query, maxResults: String(limit) });
  const listed = await providerRequest(
    `${GMAIL_BASE}/messages?${params}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
    opts,
  );
  if (listed.status < 200 || listed.status >= 300) raiseProviderError(listed.status, listed.body);
  const ids = ((listed.body as { messages?: Array<{ id?: unknown }> } | null)?.messages ?? [])
    .map((m) => str(m?.id))
    .filter(Boolean)
    .slice(0, limit) as string[];

  // Gmail's list endpoint returns only ids; the headers come one message at a
  // time. Sequential on purpose — a burst of parallel calls is how a tool
  // trips the per-user rate limit that then breaks the person's OTHER tools.
  const summaries: EmailSummary[] = [];
  for (const id of ids) {
    const metaParams = new URLSearchParams({ format: 'metadata' });
    for (const header of ['From', 'To', 'Subject', 'Date']) metaParams.append('metadataHeaders', header);
    const got = await providerRequest(
      `${GMAIL_BASE}/messages/${encodeURIComponent(id)}?${metaParams}`,
      { headers: { Authorization: `Bearer ${args.accessToken}` } },
      opts,
    );
    if (got.status === 404) continue; // deleted between list and fetch
    if (got.status < 200 || got.status >= 300) raiseProviderError(got.status, got.body);
    const summary = gmailSummary((got.body ?? {}) as GmailMessage);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

async function readGmail(args: { accessToken: string; id: string }, opts: FetchOptions): Promise<EmailFull | null> {
  const got = await providerRequest(
    `${GMAIL_BASE}/messages/${encodeURIComponent(args.id)}?format=full`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
    opts,
  );
  if (got.status === 404) return null;
  if (got.status < 200 || got.status >= 300) raiseProviderError(got.status, got.body);
  const msg = (got.body ?? {}) as GmailMessage;
  const summary = gmailSummary(msg);
  if (!summary) return null;
  const body = gmailBody(msg.payload) ?? { text: str(msg.snippet) ?? '', kind: 'text' as const };
  return {
    ...summary,
    body: body.text.slice(0, MAIL_BODY_CAP),
    bodyKind: body.kind,
    truncated: body.text.length > MAIL_BODY_CAP,
  };
}

// ---------------------------------------------------------------- Microsoft

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_MAIL_SELECT = 'id,subject,from,toRecipients,receivedDateTime,bodyPreview';

interface GraphRecipient { emailAddress?: { address?: unknown; name?: unknown } }
interface GraphMessage {
  id?: unknown;
  subject?: unknown;
  receivedDateTime?: unknown;
  bodyPreview?: unknown;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  body?: { contentType?: unknown; content?: unknown };
}

function graphAddress(r: GraphRecipient | undefined): string | null {
  const address = str(r?.emailAddress?.address);
  const name = str(r?.emailAddress?.name);
  if (address && name && name.toLowerCase() !== address.toLowerCase()) return `${name} <${address}>`;
  return address ?? name;
}

function graphSummary(msg: GraphMessage): EmailSummary | null {
  const sourceId = str(msg.id);
  if (!sourceId) return null;
  return {
    sourceId,
    from: graphAddress(msg.from),
    to: (msg.toRecipients ?? []).map(graphAddress).filter(Boolean) as string[],
    subject: str(msg.subject),
    date: str(msg.receivedDateTime),
    snippet: str(msg.bodyPreview),
  };
}

async function searchGraph(args: MailSearchArgs, limit: number, opts: FetchOptions): Promise<EmailSummary[]> {
  // Graph's $search takes a quoted phrase; the quotes inside are escaped so a
  // query cannot terminate the phrase and smuggle OData onto the URL.
  const quoted = `"${args.query.replace(/"/g, '\\"')}"`;
  const params = new URLSearchParams({ $search: quoted, $top: String(limit), $select: GRAPH_MAIL_SELECT });
  const listed = await providerRequest(
    `${GRAPH_BASE}/me/messages?${params}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
    opts,
  );
  if (listed.status < 200 || listed.status >= 300) raiseProviderError(listed.status, listed.body);
  return (((listed.body as { value?: GraphMessage[] } | null)?.value) ?? [])
    .map(graphSummary)
    .filter(Boolean)
    .slice(0, limit) as EmailSummary[];
}

async function readGraphMail(args: { accessToken: string; id: string }, opts: FetchOptions): Promise<EmailFull | null> {
  if (!/^[A-Za-z0-9_=-]{1,512}$/.test(args.id)) {
    // A Graph id is opaque base64url. Anything else is not an id, and it is
    // about to be interpolated into a URL we call with a bearer token.
    throw new ConnectorError('that is not a message id', { category: 'provider_error' });
  }
  const params = new URLSearchParams({ $select: `${GRAPH_MAIL_SELECT},body` });
  const got = await providerRequest(
    `${GRAPH_BASE}/me/messages/${args.id}?${params}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
    opts,
  );
  if (got.status === 404) return null;
  if (got.status < 200 || got.status >= 300) raiseProviderError(got.status, got.body);
  const msg = (got.body ?? {}) as GraphMessage;
  const summary = graphSummary(msg);
  if (!summary) return null;
  const content = str(msg.body?.content) ?? str(msg.bodyPreview) ?? '';
  return {
    ...summary,
    body: content.slice(0, MAIL_BODY_CAP),
    bodyKind: msg.body?.contentType === 'text' ? 'text' : 'html',
    truncated: content.length > MAIL_BODY_CAP,
  };
}
