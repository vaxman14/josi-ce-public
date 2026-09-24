// The assistant's window onto connected data: mail, calendar, contacts.
//
// Round-2 item 17 named the gap plainly: "the difference between connected and
// useful". The OAuth plumbing, sealed tokens and per-user capability switches
// all existed; nothing exposed the data to the conversation. These tools do,
// read-only, and the switches stay in charge:
//
//   * OFFERING is decided per turn (`dataToolAvailability`): a tool appears in
//     the model's list only when at least one connected provider has the
//     matching read capability ON right now. Absent tool, absent promise.
//   * EXECUTION re-checks the same capability at call time (`can`). A switch
//     flipped off mid-conversation refuses honestly, in the words of the
//     Connections page, even though the tool was offered when the turn began.
//   * Results are what the provider or the local store actually returned.
//     Empty is reported as empty. There is no path here that invents a row.
//
// Contacts prefer the LOCAL synced store — the sync pipeline exists precisely
// so the assistant does not hammer the People APIs — and fall back to one
// bounded provider read only when the local store has nothing and the switch
// allows it.
import type { Db, MasterKey } from '@josi-ce/core';
import {
  accessTokenFor, can, connectionFor, connectionsWithCapability, getInternalEvent, listInternalEvents, loadClient, readContactPage, readMail,
  refusalReason, searchMail,
  type CalendarEventRow, type CapabilityState, type ConnectionRow, type OAuthClient, type Provider, type RemoteEvent,
} from '@josi-ce/connectors';
import type { ToolSpec } from './tools.js';

/** How the executor reaches sealed tokens. Optional on the context because
 * the task/reminder tools never need it; a data tool called without it
 * refuses rather than crashing. The key is behind a thunk so it is loaded
 * only when a data tool actually runs. */
export interface ConnectorAccess {
  masterKey: () => MasterKey;
  fetchImpl?: typeof fetch;
  /** HTTP for administrator-defined custom APIs. Its own seam rather than
   * `fetchImpl`: that one answers as Google and Microsoft, and a stub that had
   * to satisfy both would be asserting less about each. */
  customApiFetch?: typeof fetch;
  /** DNS, injected by the tests so no suite performs a lookup — and by the
   * SSRF suite so it can answer with a hostile address. Unset in production.
   * Only the custom API tools consult it: the OAuth providers below are pinned
   * hosts that `validateEndpoint` never sees. */
  resolve?: (hostname: string) => Promise<string[]>;
}

type Family = 'mail' | 'calendar' | 'contacts';

export type WriteCapability = 'email_send' | 'calendar_write' | 'contacts_write';

const WRITE_CAPABILITY: Record<WriteCapability, Record<DataProvider, string>> = {
  email_send: { google: 'google.mail.send', microsoft: 'microsoft.mail.send' },
  calendar_write: { google: 'google.calendar.write', microsoft: 'microsoft.calendar.write' },
  contacts_write: { google: 'google.contacts.write', microsoft: 'microsoft.contacts.write' },
};

// Mail, calendar and contacts only ever meant Google and Microsoft. Dropbox,
// Box and Nextcloud are storage-only providers with no mailbox, calendar or
// address book — narrower than `Provider` on purpose, the same choice
// `CONTACT_CAPABILITY` in capabilities.ts makes for the same reason.
type DataProvider = 'google' | 'microsoft';

const FAMILY_CAPABILITY: Record<Family, Record<DataProvider, string>> = {
  mail: { google: 'google.mail.read', microsoft: 'microsoft.mail.read' },
  calendar: { google: 'google.calendar.read', microsoft: 'microsoft.calendar.read' },
  contacts: { google: 'google.contacts.read', microsoft: 'microsoft.contacts.read' },
};

const FAMILY_LABEL: Record<Family, string> = {
  mail: 'email',
  calendar: 'calendar',
  contacts: 'contacts',
};

const PROVIDERS: DataProvider[] = ['google', 'microsoft'];

// ----------------------------------------------------------- tool catalogue

export const DATA_TOOLS: ToolSpec[] = [
  {
    def: {
      name: 'check_email_availability',
      description: 'Make a live read-only request to the enabled mailbox provider. Use this before claiming email is currently available; stored connection metadata is not live proof.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'search_email',
      description:
        "Use only when the user explicitly asks about their email/mailbox or clearly continues such a request. Never use for ordinary conversation or a bare word such as 'test'. Search the user's connected mailbox (Gmail or Outlook). Read-only. Returns sender, "
        + 'subject, date and a snippet for up to 10 matches — use read_email with an email_id for '
        + 'the full message. Gmail search operators (from:, subject:, newer_than:) work on Gmail. '
        + 'Report an empty result as no matches; never guess at mail contents.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for.' },
          limit: { type: 'number', description: 'Max results, up to 10.' },
        },
        required: ['query'],
      },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'read_email',
      description:
        'Read one email in full, by the email_id a search_email result gave. Read-only. Long '
        + 'bodies are truncated and say so.',
      parameters: {
        type: 'object',
        properties: { email_id: { type: 'string', description: 'An email_id from search_email.' } },
        required: ['email_id'],
      },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'query_calendar',
      description:
        "Use only when the user explicitly asks about their calendar/schedule or clearly continues such a request. Never use for ordinary conversation or a bare word such as 'test'. List events on the user's connected calendar in a time range. Read-only. Defaults to the "
        + 'next 7 days when no range is given; use ISO 8601 times for start and end. Good for '
        + '"what\'s my day/week". Honor Calendar-page selections. Keep provider, account, calendar and event_id in citations and all follow-up actions or reminders. Use get_event with an event_id for full details.',
      parameters: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'Exact calendar source ID from a prior receipt. Otherwise use only calendars selected on the Calendar page.' },
          start: { type: 'string', description: 'Range start, ISO 8601. Defaults to now.' },
          end: { type: 'string', description: 'Range end, ISO 8601. Defaults to 7 days after start.' },
        },
      },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'get_event',
      description: 'Full details of one calendar event, by the event_id a query_calendar result gave. Read-only.',
      parameters: {
        type: 'object',
        properties: { event_id: { type: 'string', description: 'An event_id from query_calendar.' } },
        required: ['event_id'],
      },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'search_contacts',
      description:
        "Use only when the user explicitly asks to search their contacts or clearly continues such a request. Never use for ordinary conversation or a bare word such as 'test'. Look up people in the user's contacts by name, email or phone. Read-only. Searches the "
        + 'locally synced address book first and falls back to the connected account when the '
        + 'local store is empty. Report no match honestly; never invent a person or a number.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'A name, email address or phone fragment.' } },
        required: ['query'],
      },
    },
    actionClass: null,
  },
];

const TOOLS_BY_FAMILY: Record<Family, string[]> = {
  mail: ['check_email_availability', 'search_email', 'read_email'],
  calendar: ['query_calendar', 'get_event'],
  contacts: ['search_contacts'],
};

export const DATA_TOOL_FAMILY: Map<string, Family> = new Map(
  (Object.entries(TOOLS_BY_FAMILY) as Array<[Family, string[]]>)
    .flatMap(([family, names]) => names.map((n) => [n, family] as [string, Family])),
);

// ------------------------------------------------------------- availability

interface FamilyAccess {
  /** Providers whose read switch is ON right now. */
  allowed: DataProvider[];
  /** The most useful refusal when none is — written for the model to relay. */
  refusal: string;
}

async function familyAccess(db: Db, userId: string, family: Family): Promise<FamilyAccess> {
  const allowed: DataProvider[] = [];
  let bestState: CapabilityState | null = null;
  let bestCapability = FAMILY_CAPABILITY[family].google;
  for (const provider of PROVIDERS) {
    const capability = FAMILY_CAPABILITY[family][provider];
    const verdict = await can(db, { ownerUserId: userId, capability });
    if (verdict.allowed) {
      allowed.push(provider);
      continue;
    }
    // The refusal that names the smallest fix wins: an existing connection
    // with the switch off beats "connect an account" — the person already
    // connected one, they just have not enabled this.
    const connected = !!(await connectionFor(db, { ownerUserId: userId, provider }));
    if (connected && (bestState === null || verdict.state === 'off')) {
      bestState = verdict.state;
      bestCapability = capability;
    }
  }
  const refusal = bestState
    ? refusalReason(bestState, bestCapability)
    : `No account with ${FAMILY_LABEL[family]} access is connected. Connect Google or Microsoft on the Connections page first.`;
  return { allowed, refusal };
}

export interface DataToolAvailability {
  /** Specs to offer this turn. */
  specs: ToolSpec[];
  /** For the system prompt: what the assistant can honestly claim. */
  granted: Family[];
  /** For the system prompt: what is off, and the sentence that fixes it. */
  denied: Array<{ what: string; hint: string }>;
}

/** Which data tools this person's switches allow RIGHT NOW.
 *
 * Contacts are also offered when the local store has rows even if every
 * provider switch is off — the rows are already Josi's to search, imported
 * with consent by the sync pipeline. */
export async function dataToolAvailability(db: Db, userId: string): Promise<DataToolAvailability> {
  const specs: ToolSpec[] = [];
  const granted: Family[] = [];
  const denied: DataToolAvailability['denied'] = [];

  for (const family of ['mail', 'calendar', 'contacts'] as Family[]) {
    const access = await familyAccess(db, userId, family);
    let available = access.allowed.length > 0;
    if (!available && family === 'calendar') {
      const [row] = await db.query<{ n: number }>(
        `select count(*)::int as n from calendars where owner_user_id = $1`, [userId],
      );
      available = (row?.n ?? 0) > 0;
    }
    if (!available && family === 'contacts') {
      const [row] = await db.query<{ n: number }>(
        `select count(*)::int as n from contacts where owner_user_id = $1`,
        [userId],
      );
      available = (row?.n ?? 0) > 0;
    }
    if (available) {
      granted.push(family);
      specs.push(...DATA_TOOLS.filter((t) => TOOLS_BY_FAMILY[family].includes(t.def.name)));
    } else {
      denied.push({ what: FAMILY_LABEL[family], hint: access.refusal });
    }
  }
  return { specs, granted, denied };
}

/** Abstract task capabilities backed by a real connected account whose write
 * switch is ON for this person right now. Task templates store the abstract
 * names; provider connections store the concrete Google/Microsoft grants. */
export async function writeActionCapabilities(db: Db, userId: string): Promise<Set<string>> {
  const available = new Set<string>();
  for (const capability of Object.keys(WRITE_CAPABILITY) as WriteCapability[]) {
    for (const provider of PROVIDERS) {
      if ((await can(db, { ownerUserId: userId, capability: WRITE_CAPABILITY[capability][provider] })).allowed) {
        available.add(capability);
        break;
      }
    }
  }
  return available;
}

// ---------------------------------------------------------------- execution

interface ProviderSession {
  provider: DataProvider;
  connection: ConnectionRow;
  client: OAuthClient;
  accessToken: string;
}

const NO_ACCESS = (message: string) => ({ ok: false, error: 'not_enabled', message });

/** Opens a live session per allowed provider — capability re-checked NOW, not
 * trusted from offering time. Returns sessions plus the refusal to use when
 * there are none. */
async function openSessions(
  db: Db,
  access: ConnectorAccess,
  userId: string,
  family: Family,
  only?: DataProvider,
  onlyConnections?: string[],
): Promise<{ sessions: ProviderSession[]; refusal: string }> {
  const verdict = await familyAccess(db, userId, family);
  const wanted = only ? verdict.allowed.filter((p) => p === only) : verdict.allowed;
  const sessions: ProviderSession[] = [];
  const key = access.masterKey();
  for (const provider of wanted) {
    const client = await loadClient(db, key, provider);
    const capability = FAMILY_CAPABILITY[family][provider];
    for (const connection of await connectionsWithCapability(db, { ownerUserId: userId, capability })) {
      if (onlyConnections && !onlyConnections.includes(connection.id)) continue;
      const accessToken = await accessTokenFor(
        db, key, { connection, client }, { fetchImpl: access.fetchImpl },
      );
      sessions.push({ provider, connection, client, accessToken });
    }
  }
  const refusal = only && verdict.allowed.length && !wanted.length
    ? `Your ${only === 'google' ? 'Google' : 'Microsoft'} ${FAMILY_LABEL[family]} access is not enabled. You can turn it on on the Connections page.`
    : verdict.refusal;
  return { sessions, refusal };
}

/** Ids handed to the model carry the provider, so a later read goes back to
 * the right account without guessing. */
const taggedId = (provider: DataProvider, id: string) => `${provider}:${id}`;

function untagId(tagged: string): { provider: DataProvider; connectionId: string | null; id: string } | null {
  const current = /^(google|microsoft):([0-9a-f-]{36}):(.+)$/.exec(tagged);
  if (current) return { provider: current[1] as DataProvider, connectionId: current[2], id: current[3] };
  const legacy = /^(google|microsoft):(.+)$/.exec(tagged);
  return legacy ? { provider: legacy[1] as DataProvider, connectionId: null, id: legacy[2] } : null;
}

export interface CalendarSource { id:string; connection_id:string; provider_calendar_id:string; name:string; is_primary:boolean; is_write_default:boolean; writable:boolean; provider:DataProvider; account:string|null }
export async function selectedCalendars(db:Db,userId:string,sourceId?:string):Promise<CalendarSource[]> {
  return db.query<CalendarSource>(`select s.id,s.connection_id,s.provider_calendar_id,s.name,s.is_primary,s.is_write_default,s.writable,c.provider,c.account_email account
    from calendar_sources s join connections c on c.id=s.connection_id
    where s.owner_user_id=$1 and c.owner_user_id=$1 and s.selected=true and ($2::text is null or s.id::text=$2) order by s.id`,[userId,sourceId??null]);
}
function eventView(source:CalendarSource,event:RemoteEvent) {
  return {
    event_id: `calendar:${source.id}:${Buffer.from(event.sourceId).toString('base64url')}`,
    source_id:source.id, provider:source.provider, account_id:source.connection_id, account:source.account,
    calendar_id:source.provider_calendar_id, calendar_name:source.name, provider_event_id:event.sourceId,
    title:event.title, start:event.start, end:event.end, all_day:event.allDay, location:event.location,
    organizer:event.organizer, attendees:event.attendees, status:event.status,
    ...(event.description !== undefined ? {description:event.description}:{}),
  };
}

/** Runs one data tool. The caller has already matched the name against
 * DATA_TOOL_FAMILY; anything else does not belong here. */
export async function executeDataTool(
  db: Db,
  args: { userId: string; access: ConnectorAccess | null },
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const family = DATA_TOOL_FAMILY.get(name);
  if (!family) return { ok: false, error: 'unknown_tool', message: `no tool named ${name}` };

  // Contacts read the local store before they need any provider at all.
  if (name === 'search_contacts') return searchContacts(db, args, input);

  if (!args.access && family !== 'calendar') {
    return { ok: false, error: 'unavailable', message: 'Connected accounts cannot be reached right now. Tell the user their data connections are unavailable at the moment.' };
  }

  switch (name) {
    case 'check_email_availability': {
      if (!args.access) return { ok: false, error: 'unavailable', message: 'Email cannot be reached live right now.' };
      try {
        const { sessions, refusal } = await openSessions(db, args.access, args.userId, 'mail');
        if (!sessions.length) return NO_ACCESS(refusal);
        const live: string[] = [];
        for (const session of sessions) {
          const url = session.provider === 'google'
            ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile'
            : 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=id';
          const response = await (args.access.fetchImpl ?? fetch)(url, { headers: { Authorization: `Bearer ${session.accessToken}` } });
          if (response.ok) live.push(session.provider === 'google' ? 'Gmail' : 'Outlook');
        }
        return live.length
          ? { ok: true, available: true, providers: live, message: `${live.join(' and ')} answered a live mailbox check.` }
          : { ok: false, error: 'provider_unavailable', message: 'The configured mailbox did not answer a live check. No email availability was claimed.' };
      } catch {
        return { ok: false, error: 'provider_unavailable', message: 'The configured mailbox could not be reached live. No email availability was claimed.' };
      }
    }
    case 'search_email': {
      const query = String(input.query ?? '').trim();
      if (!query) return { ok: false, error: 'bad_query', message: 'Say what to search for.' };
      const { sessions, refusal } = await openSessions(db, args.access!, args.userId, 'mail');
      if (!sessions.length) return NO_ACCESS(refusal);
      const limit = Number.isFinite(Number(input.limit)) ? Number(input.limit) : undefined;
      const emails = [];
      for (const s of sessions) {
        const found = await searchMail(s.provider, { accessToken: s.accessToken, query, limit }, { fetchImpl: args.access!.fetchImpl });
        emails.push(...found.map((e) => ({
          email_id: taggedId(s.provider, e.sourceId),
          from: e.from, to: e.to, subject: e.subject, date: e.date, snippet: e.snippet,
        })));
      }
      return {
        ok: true,
        emails,
        ...(emails.length ? {} : { message: 'No email matched that search.' }),
      };
    }

    case 'read_email': {
      const ref = untagId(String(input.email_id ?? ''));
      if (!ref) return { ok: false, error: 'not_found', message: 'There is no email with that id. Use an email_id from search_email.' };
      const { sessions, refusal } = await openSessions(db, args.access!, args.userId, 'mail', ref.provider);
      if (!sessions.length) return NO_ACCESS(refusal);
      const s = sessions[0];
      const email = await readMail(s.provider, { accessToken: s.accessToken, id: ref.id }, { fetchImpl: args.access!.fetchImpl });
      if (!email) return { ok: false, error: 'not_found', message: 'There is no email with that id.' };
      return {
        ok: true,
        email: {
          email_id: taggedId(s.provider, email.sourceId),
          from: email.from, to: email.to, subject: email.subject, date: email.date,
          body: email.body,
          body_kind: email.bodyKind,
          truncated: email.truncated,
          ...(email.truncated ? { note: 'The body was longer than shown; this is the beginning of it.' } : {}),
        },
      };
    }

    case 'query_calendar': {
      const window = calendarWindow(input);
      if (!window) {
        return { ok: false, error: 'bad_time', message: 'Give start and end as ISO 8601 times, with start before end and a range of at most 92 days.' };
      }
      const sources = await selectedCalendars(db,args.userId,typeof input.source_id === 'string' ? input.source_id : undefined);
      if (!sources.length) return NO_ACCESS('No selected calendar is available. Open Calendar, refresh calendars, and select the exact calendar to query.');
      const calendarIds = new Set<string>();
      const sourceByCalendar = new Map<string,CalendarSource>();
      const coverageProblems: string[] = [];
      for (const source of sources) {
        if (!(await can(db,{ownerUserId:args.userId,capability:FAMILY_CAPABILITY.calendar[source.provider]})).allowed) {
          coverageProblems.push(`${source.name} access is disabled`);
          continue;
        }
        const [origin] = await db.query<{calendar_id:string;status:string;last_sync_at:string|null;sync_interval_seconds:number}>(`select calendar_id,status,last_sync_at,sync_interval_seconds from calendar_sync_origins where connection_id=$1 and provider_calendar_id=$2`,[source.connection_id,source.provider_calendar_id]);
        if (!origin) { coverageProblems.push(`${source.name} has not synchronized yet`); continue; }
        const age = origin.last_sync_at ? Date.now()-new Date(origin.last_sync_at).getTime() : Number.POSITIVE_INFINITY;
        const staleAfter = Math.max(900_000, Number(origin.sync_interval_seconds)*3_000);
        if (origin.status !== 'idle') coverageProblems.push(`${source.name} synchronization ${origin.status === 'error' ? 'failed' : 'is incomplete'}`);
        else if (!origin.last_sync_at || !Number.isFinite(age) || age > staleAfter) coverageProblems.push(`${source.name} synchronization is stale`);
        calendarIds.add(origin.calendar_id); sourceByCalendar.set(origin.calendar_id,source);
      }
      const found = await listInternalEvents(db, { ownerUserId: args.userId, start: window.start, end: window.end });
      const events=[];
      for(const e of found.filter((candidate)=>calendarIds.has(candidate.calendar_id))){
        const source=sourceByCalendar.get(e.calendar_id)!;
        const [link]=await db.query<{provider_event_id:string}>(`select l.provider_event_id from calendar_event_links l join calendar_sync_origins o on o.id=l.origin_id where l.event_id=$1 and o.calendar_id=$2`,[e.id,e.calendar_id]);
        events.push({ event_id: e.id, source_id:source.id, provider:source.provider, account_id:source.connection_id,account:source.account,
          calendar_id:source.provider_calendar_id,calendar_name:source.name,provider_event_id:link?.provider_event_id??null,title:e.title,
          start:e.all_day?e.start_date:e.starts_at,end:e.all_day?e.end_date:e.ends_at,all_day:e.all_day,location:e.location,
          organizer:e.organizer,attendees:e.attendees,status:e.status,sync_state:e.sync_state,
          recurrence:e.recurrence,recurring_event_id:(e as CalendarEventRow & {recurring_provider_event_id?:string|null}).recurring_provider_event_id??null,
          original_start:(e as CalendarEventRow & {original_start?:string|null}).original_start??null });
      }
      events.sort((a, b) => String(a.start ?? '').localeCompare(String(b.start ?? '')));
      if (!events.length && coverageProblems.length) {
        return { ok:false,error:'calendar_coverage_unavailable',message:`I cannot honestly say this range is empty because ${coverageProblems.join('; ')}. Refresh or reconnect the calendar, then try again.` };
      }
      return {
        ok: true,
        sources: sources.map(s=>({source_id:s.id,provider:s.provider,account_id:s.connection_id,account:s.account,calendar_id:s.provider_calendar_id,calendar_name:s.name})),
        range: { start: window.start, end: window.end },
        events,
        ...(coverageProblems.length ? { coverage_warning:`Results may be incomplete: ${coverageProblems.join('; ')}.` } : {}),
        ...(events.length ? {} : { message: 'The synchronized calendars have no events in that range.' }),
      };
    }

    case 'get_event': {
      const event = await getInternalEvent(db, { ownerUserId: args.userId, eventId: String(input.event_id ?? '') });
      if (!event) return { ok: false, error: 'not_found', message: 'There is no event with that id.' };
      const [source]=await db.query<CalendarSource>(`select s.id,s.connection_id,s.provider_calendar_id,s.name,c.provider,c.account_email account
        from calendar_sync_origins o join calendar_sources s on s.connection_id=o.connection_id and s.provider_calendar_id=o.provider_calendar_id
        join connections c on c.id=s.connection_id where o.calendar_id=$1 and s.owner_user_id=$2 and s.selected=true`,[event.calendar_id,args.userId]);
      if(!source||!(await can(db,{ownerUserId:args.userId,capability:FAMILY_CAPABILITY.calendar[source.provider]})).allowed)return NO_ACCESS('The event\'s original calendar is unavailable or permission was removed. No other calendar was substituted.');
      const [link]=await db.query<{provider_event_id:string}>(`select provider_event_id from calendar_event_links where event_id=$1`,[event.id]);
      return { ok: true, event: { event_id: event.id, source_id:source.id,provider:source.provider,account_id:source.connection_id,account:source.account,
        calendar_id:source.provider_calendar_id,calendar_name:source.name,provider_event_id:link?.provider_event_id??null,title: event.title,
        start: event.all_day ? event.start_date : event.starts_at, end: event.all_day ? event.end_date : event.ends_at,
        all_day: event.all_day, location: event.location, organizer: event.organizer,
        attendees: event.attendees, status: event.status, description: event.description,
        recurrence: event.recurrence, recurring_event_id:event.recurring_provider_event_id,
        original_start:event.original_start, sync_state: event.sync_state, sync_error: event.sync_error } };
    }

    default:
      return { ok: false, error: 'unknown_tool', message: `no tool named ${name}` };
  }
}

/** Default window: now → 7 days out. Explicit ranges are capped at 92 days —
 * a quarter answers every reasonable question and bounds the response. */
function calendarWindow(input: Record<string, unknown>): { start: string; end: string } | null {
  const parse = (v: unknown): Date | null => {
    const s = String(v ?? '').trim();
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  if ((input.start !== undefined && !parse(input.start)) || (input.end !== undefined && !parse(input.end))) return null;
  const start = parse(input.start) ?? new Date();
  const end = parse(input.end) ?? new Date(start.getTime() + 7 * 86_400_000);
  if (end.getTime() <= start.getTime()) return null;
  if (end.getTime() - start.getTime() > 92 * 86_400_000) return null;
  return { start: start.toISOString(), end: end.toISOString() };
}

const CONTACT_RESULT_CAP = 10;

async function searchContacts(
  db: Db,
  args: { userId: string; access: ConnectorAccess | null },
  input: Record<string, unknown>,
): Promise<unknown> {
  const query = String(input.query ?? '').trim();
  if (!query) return { ok: false, error: 'bad_query', message: 'Say who to look for.' };

  // Local first. The sync pipeline filled this table with consent; searching
  // it costs nobody a rate limit.
  const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const local = await db.query<{ id: string; name: string | null; email: string | null; phone: string | null }>(
    `select id, name, email, phone from contacts
     where owner_user_id = $1 and (name ilike $2 or email ilike $2 or phone ilike $2)
     order by updated_at desc limit ${CONTACT_RESULT_CAP}`,
    [args.userId, like],
  );
  if (local.length) {
    return {
      ok: true,
      source: 'local',
      contacts: local.map((c) => ({ contact_id: c.id, name: c.name, email: c.email, phone: c.phone })),
    };
  }

  // Fall back to the provider only when the local store holds NOTHING for
  // this person — an empty search against a populated store is an answer.
  const [any] = await db.query<{ n: number }>(
    `select count(*)::int as n from contacts where owner_user_id = $1`,
    [args.userId],
  );
  if ((any?.n ?? 0) > 0) {
    return { ok: true, contacts: [], message: 'No contact matched that.' };
  }

  if (!args.access) {
    return { ok: true, contacts: [], message: 'No contacts are synced yet, and connected accounts cannot be reached right now.' };
  }
  const { sessions, refusal } = await openSessions(db, args.access, args.userId, 'contacts');
  if (!sessions.length) {
    return { ok: true, contacts: [], message: `No contacts are synced yet. ${refusal}` };
  }

  // One bounded read per provider, filtered here. Reuses the proven contact
  // adapter rather than growing a second provider dialect for search.
  const needle = query.toLowerCase();
  const matches: Array<{ contact_id: string; name: string | null; email: string | null; phone: string | null }> = [];
  for (const s of sessions) {
    let cursor: string | null = null;
    for (let page = 0; page < 2 && matches.length < CONTACT_RESULT_CAP; page++) {
      const result = await readContactPage(
        s.provider,
        { accessToken: s.accessToken, pageCursor: cursor, pageSize: 200 },
        { fetchImpl: args.access.fetchImpl },
      );
      for (const c of result.contacts) {
        if (c.deleted) continue;
        const hay = [c.displayName, ...c.emails, ...c.phones].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(needle)) continue;
        matches.push({
          contact_id: taggedId(s.provider, c.sourceId),
          name: c.displayName,
          email: c.emails[0] ?? null,
          phone: c.phones[0] ?? null,
        });
        if (matches.length >= CONTACT_RESULT_CAP) break;
      }
      cursor = result.nextPageCursor;
      if (!cursor) break;
    }
  }
  return {
    ok: true,
    source: 'provider',
    contacts: matches,
    ...(matches.length ? {} : { message: 'No contact matched that.' }),
  };
}
