// Reading calendars at Google and Microsoft. Read-only, bounded, and shaped
// for "what's my week": a time-windowed list and a single-event fetch.
//
// Same discipline as mail.ts: one shape in and out, provider error sentences
// never quoted, every request under a timeout, results capped.
import type { Provider } from '../capabilities.js';
import { ConnectorError, type FetchOptions } from '../providers.js';
import { providerRequest, raiseProviderError, str } from './http.js';

export interface RemoteEvent {
  sourceId: string;
  title: string | null;
  /** ISO 8601, or a bare date (YYYY-MM-DD) for an all-day event. */
  start: string | null;
  end: string | null;
  allDay: boolean;
  location: string | null;
  organizer: string | null;
  /** Addresses only, capped — a 200-person invite list is noise, not context. */
  attendees: string[];
  status: string | null;
  /** Present only on a single-event fetch, and capped. */
  description?: string | null;
}

export interface RemoteCalendar {
  sourceId: string;
  name: string;
  color: string | null;
  primary: boolean;
  writable: boolean;
}

/** The most events one query returns. A week of a busy calendar fits; a
 * model that wants more narrows the window. */
export const CALENDAR_RESULT_CAP = 25;
const ATTENDEE_CAP = 20;
const DESCRIPTION_CAP = 4_000;

export interface CalendarQueryArgs {
  accessToken: string;
  /** ISO 8601 range, inclusive start, exclusive end. */
  timeMin: string;
  timeMax: string;
  limit?: number;
  calendarId?: string;
}

export async function listEvents(
  provider: Provider,
  args: CalendarQueryArgs,
  opts: FetchOptions = {},
): Promise<RemoteEvent[]> {
  const limit = Math.max(1, Math.min(args.limit ?? CALENDAR_RESULT_CAP, 1000));
  return provider === 'google' ? listGoogle(args, limit, opts) : listGraph(args, limit, opts);
}

export async function getEvent(
  provider: Provider,
  args: { accessToken: string; id: string; calendarId?: string },
  opts: FetchOptions = {},
): Promise<RemoteEvent | null> {
  return provider === 'google' ? getGoogle(args, opts) : getGraph(args, opts);
}

/** Discover every calendar below one account. Provider pagination is followed
 * to exhaustion; there is no product-imposed account/calendar count. */
export async function listCalendars(
  provider: Provider,
  args: { accessToken: string },
  opts: FetchOptions = {},
): Promise<RemoteCalendar[]> {
  return provider === 'google' ? listGoogleCalendars(args, opts) : listGraphCalendars(args, opts);
}

// ------------------------------------------------------------------- Google

const GCAL_ROOT = 'https://www.googleapis.com/calendar/v3';
const googleEventsUrl = (calendarId = 'primary') => `${GCAL_ROOT}/calendars/${encodeURIComponent(calendarId)}/events`;

interface GoogleEvent {
  id?: unknown;
  summary?: unknown;
  status?: unknown;
  location?: unknown;
  description?: unknown;
  start?: { dateTime?: unknown; date?: unknown };
  end?: { dateTime?: unknown; date?: unknown };
  organizer?: { email?: unknown };
  attendees?: Array<{ email?: unknown }>;
}

function fromGoogle(event: GoogleEvent, withDescription: boolean): RemoteEvent | null {
  const sourceId = str(event.id);
  if (!sourceId) return null;
  const allDay = !!str(event.start?.date);
  const out: RemoteEvent = {
    sourceId,
    title: str(event.summary),
    start: str(event.start?.dateTime) ?? str(event.start?.date),
    end: str(event.end?.dateTime) ?? str(event.end?.date),
    allDay,
    location: str(event.location),
    organizer: str(event.organizer?.email),
    attendees: (event.attendees ?? []).map((a) => str(a?.email)).filter(Boolean).slice(0, ATTENDEE_CAP) as string[],
    status: str(event.status),
  };
  if (withDescription) out.description = (str(event.description) ?? '').slice(0, DESCRIPTION_CAP) || null;
  return out;
}

async function listGoogle(args: CalendarQueryArgs, limit: number, opts: FetchOptions): Promise<RemoteEvent[]> {
  const params = new URLSearchParams({
    timeMin: args.timeMin,
    timeMax: args.timeMax,
    // Recurring events expanded into occurrences, in time order — the shape a
    // "what's my week" answer needs; the raw recurrence rule is not.
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(limit),
  });
  const out: RemoteEvent[] = [];
  let token = '';
  const seen = new Set<string>();
  do {
    if (token) params.set('pageToken', token);
    params.set('maxResults', String(Math.min(250, limit-out.length)));
    const result = await providerRequest(`${googleEventsUrl(args.calendarId)}?${params}`, { headers: { Authorization: `Bearer ${args.accessToken}` } }, opts);
    if (result.status < 200 || result.status >= 300) raiseProviderError(result.status, result.body);
    const body = (result.body ?? {}) as { items?: GoogleEvent[]; nextPageToken?: string };
    out.push(...(body.items ?? []).map(e=>fromGoogle(e,false)).filter((e):e is RemoteEvent=>!!e));
    token = body.nextPageToken ?? '';
    if (token && (seen.has(token) || out.length >= limit)) throw new ConnectorError('Calendar range is too busy. Choose a shorter range to retrieve all events.', {category:'provider_error'});
    seen.add(token);
  } while (token);
  return out;

}

async function getGoogle(args: { accessToken: string; id: string; calendarId?: string }, opts: FetchOptions): Promise<RemoteEvent | null> {
  const result = await providerRequest(
    `${googleEventsUrl(args.calendarId)}/${encodeURIComponent(args.id)}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
    opts,
  );
  if (result.status === 404 || result.status === 410) return null;
  if (result.status < 200 || result.status >= 300) raiseProviderError(result.status, result.body);
  return fromGoogle((result.body ?? {}) as GoogleEvent, true);
}


async function listGoogleCalendars(args: { accessToken: string }, opts: FetchOptions): Promise<RemoteCalendar[]> {
  const out: RemoteCalendar[] = [];
  let token = '';
  do {
    const params = new URLSearchParams({ maxResults: '250' });
    if (token) params.set('pageToken', token);
    const result = await providerRequest(`${GCAL_ROOT}/users/me/calendarList?${params}`, {
      headers: { Authorization: `Bearer ${args.accessToken}` },
    }, opts);
    if (result.status < 200 || result.status >= 300) raiseProviderError(result.status, result.body);
    const body = (result.body ?? {}) as { items?: Array<Record<string, unknown>>; nextPageToken?: unknown };
    for (const item of body.items ?? []) {
      const sourceId = str(item.id); const name = str(item.summaryOverride) ?? str(item.summary);
      if (sourceId && name) out.push({ sourceId, name, color: str(item.backgroundColor), primary: item.primary === true, writable: item.accessRole === 'owner' || item.accessRole === 'writer' });
    }
    token = str(body.nextPageToken) ?? '';
  } while (token);
  return out;
}

// ---------------------------------------------------------------- Microsoft

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_EVENT_SELECT = 'id,subject,start,end,isAllDay,location,organizer,attendees,showAs';

interface GraphEvent {
  id?: unknown;
  subject?: unknown;
  isAllDay?: unknown;
  showAs?: unknown;
  start?: { dateTime?: unknown };
  end?: { dateTime?: unknown };
  location?: { displayName?: unknown };
  organizer?: { emailAddress?: { address?: unknown } };
  attendees?: Array<{ emailAddress?: { address?: unknown } }>;
  bodyPreview?: unknown;
}

// Graph returns UTC wall times without a suffix even with the UTC preference.
function graphTime(value: unknown, allDay: boolean): string | null {
  const date = str(value); if (!date) return null;
  if (allDay) return date.slice(0,10);
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(date) ? date : `${date}Z`;
}

function fromGraph(event: GraphEvent, withDescription: boolean): RemoteEvent | null {
  const sourceId = str(event.id);
  if (!sourceId) return null;
  const out: RemoteEvent = {
    sourceId,
    title: str(event.subject),
    start: graphTime(event.start?.dateTime, event.isAllDay === true),
    end: graphTime(event.end?.dateTime, event.isAllDay === true),
    allDay: event.isAllDay === true,
    location: str(event.location?.displayName),
    organizer: str(event.organizer?.emailAddress?.address),
    attendees: (event.attendees ?? [])
      .map((a) => str(a?.emailAddress?.address))
      .filter(Boolean)
      .slice(0, ATTENDEE_CAP) as string[],
    status: str(event.showAs),
  };
  if (withDescription) out.description = (str(event.bodyPreview) ?? '').slice(0, DESCRIPTION_CAP) || null;
  return out;
}

async function listGraph(args: CalendarQueryArgs, limit: number, opts: FetchOptions): Promise<RemoteEvent[]> {
  const params = new URLSearchParams({
    startDateTime: args.timeMin,
    endDateTime: args.timeMax,
    $orderby: 'start/dateTime',
    $top: String(limit),
    $select: GRAPH_EVENT_SELECT,
  });
  let url: string | null = `${GRAPH_BASE}/me/${args.calendarId ? `calendars/${encodeURIComponent(args.calendarId)}/` : ''}calendarView?${params}`;
  const out: RemoteEvent[] = []; const seen = new Set<string>();
  while (url) {
    if (seen.has(url)) throw new ConnectorError('Calendar pagination did not advance. Retry with a shorter range.', {category:'provider_error'});
    seen.add(url);
    const result = await providerRequest(url, {headers:{Authorization:`Bearer ${args.accessToken}`,Prefer:'outlook.timezone="UTC"'}}, opts);
    if (result.status < 200 || result.status >= 300) raiseProviderError(result.status,result.body);
    const body = (result.body ?? {}) as {value?:GraphEvent[]; '@odata.nextLink'?:string};
    out.push(...(body.value ?? []).map(e=>fromGraph(e,false)).filter((e):e is RemoteEvent=>!!e));
    const next = body['@odata.nextLink'];
    if(next && (!next.startsWith(`${GRAPH_BASE}/`) || out.length >= limit)) throw new ConnectorError('Calendar range is too busy. Choose a shorter range to retrieve all events.', {category:'provider_error'});
    url = next ?? null;
  }
  return out;

}

async function getGraph(args: { accessToken: string; id: string; calendarId?: string }, opts: FetchOptions): Promise<RemoteEvent | null> {
  if (!/^[A-Za-z0-9_=-]{1,512}$/.test(args.id)) {
    throw new ConnectorError('that is not an event id', { category: 'provider_error' });
  }
  const params = new URLSearchParams({ $select: `${GRAPH_EVENT_SELECT},bodyPreview` });
  const result = await providerRequest(
    `${GRAPH_BASE}/me/${args.calendarId ? `calendars/${encodeURIComponent(args.calendarId)}/` : ''}events/${args.id}?${params}`,
    { headers: { Authorization: `Bearer ${args.accessToken}`, Prefer: 'outlook.timezone="UTC"' } },
    opts,
  );
  if (result.status === 404) return null;
  if (result.status < 200 || result.status >= 300) raiseProviderError(result.status, result.body);
  return fromGraph((result.body ?? {}) as GraphEvent, true);
}


async function listGraphCalendars(args: { accessToken: string }, opts: FetchOptions): Promise<RemoteCalendar[]> {
  const out: RemoteCalendar[] = [];
  let url: string | null = `${GRAPH_BASE}/me/calendars?$top=100&$select=id,name,color,canEdit,isDefaultCalendar`;
  while (url) {
    const result = await providerRequest(url, { headers: { Authorization: `Bearer ${args.accessToken}` } }, opts);
    if (result.status < 200 || result.status >= 300) raiseProviderError(result.status, result.body);
    const body = (result.body ?? {}) as { value?: Array<Record<string, unknown>>; '@odata.nextLink'?: unknown };
    for (const item of body.value ?? []) {
      const sourceId = str(item.id); const name = str(item.name);
      if (sourceId && name) out.push({ sourceId, name, color: str(item.color), primary: item.isDefaultCalendar === true, writable: item.canEdit === true });
    }
    const next = str(body['@odata.nextLink']);
    url = next?.startsWith(`${GRAPH_BASE}/`) ? next : null;
  }
  return out;
}
