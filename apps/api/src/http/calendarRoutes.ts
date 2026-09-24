import { Router, type Request, type Response } from 'express';
import { loadMasterKey, type Db, type LoadOptions } from '@josi-ce/core';
import {
  accessTokenFor, ensureInternalCalendar, getConnection, getEvent, listCalendars, listEvents, loadClient,
  syncCalendarOrigin,
  type CalendarProvider, type OAuthProvider,
} from '@josi-ce/connectors';
import { asyncRoute, param } from './async.js';
import { requireAuth } from './authz.js';

interface Ctx { db: Db; masterKey?: LoadOptions | false; fetchImpl?: typeof fetch }
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
  try { return await fn(req, res); } catch (error) {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

function key(ctx: Ctx) {
  if (ctx.masterKey === false) throw new HttpError(503, 'calendar connections are unavailable');
  try { return loadMasterKey(ctx.masterKey ?? {}); } catch { throw new HttpError(503, 'the installation master key is unavailable'); }
}

async function calendarAccess(db: Db, connectionId: string): Promise<boolean> {
  const [row] = await db.query<{ allowed: boolean }>(
    `select cc.enabled and cc.scopes_granted_at is not null and coalesce(p.allowed, true) as allowed
       from connection_capabilities cc
       left join admin_capability_policy p on p.capability = cc.capability
      where cc.connection_id = $1 and cc.capability in ('google.calendar.read','microsoft.calendar.read')`,
    [connectionId],
  );
  return row?.allowed === true;
}

async function discover(ctx: Ctx, ownerUserId: string) {
  const errors: Array<{ connectionId: string; provider: OAuthProvider; error: string }> = [];
  const connections = await ctx.db.query<{ id: string; provider: CalendarProvider }>(
    `select id, provider from connections where owner_user_id = $1
      and provider in ('google','microsoft') and status = 'active' order by created_at`,
    [ownerUserId],
  );
  for (const connection of connections) {
    try {
      if (!(await calendarAccess(ctx.db, connection.id))) continue;
      const full = await getConnection(ctx.db, connection.id); if (!full) continue;
      const masterKey = key(ctx);
      const client = await loadClient(ctx.db, masterKey, connection.provider);
      const accessToken = await accessTokenFor(ctx.db, masterKey, { connection: full, client }, { fetchImpl: ctx.fetchImpl });
      const remote = await listCalendars(connection.provider, { accessToken }, { fetchImpl: ctx.fetchImpl });
      const truePrimary = remote.find((calendar) => calendar.primary);
      if (truePrimary && truePrimary.sourceId !== 'primary') {
        // `primary` is a Google request alias, not the durable calendar id.
        // Early calendar sync created it before discovery knew the real id.
        await ctx.db.query(
          `update calendar_sync_origins o set provider_calendar_id=$2
            where o.connection_id=$1 and o.provider_calendar_id='primary'
              and not exists(select 1 from calendar_sync_origins x where x.connection_id=$1 and x.provider_calendar_id=$2)`,
          [connection.id, truePrimary.sourceId],
        );
        await ctx.db.query(
          `update calendar_sources s set provider_calendar_id=$2
            where s.connection_id=$1 and s.provider_calendar_id='primary'
              and not exists(select 1 from calendar_sources x where x.connection_id=$1 and x.provider_calendar_id=$2)`,
          [connection.id, truePrimary.sourceId],
        );
      }
      // The provider's latest list is authoritative. Clearing first keeps the
      // partial unique index useful even if an old response marked two rows.
      await ctx.db.query(`update calendar_sources set is_primary=false where connection_id=$1`, [connection.id]);
      for (const calendar of remote) await ctx.db.query(
        `insert into calendar_sources
          (owner_user_id, connection_id, provider_calendar_id, name, color, is_primary, writable, is_write_default)
         values ($1,$2,$3,$4,$5,$6,$7,
           $6 and $7 and not exists(select 1 from calendar_sources where owner_user_id=$1 and is_write_default))
         on conflict (connection_id, provider_calendar_id) do update set
          name=excluded.name, color=excluded.color, is_primary=excluded.is_primary,
          writable=excluded.writable, last_discovered_at=now()`,
        [ownerUserId, connection.id, calendar.sourceId, calendar.name, calendar.color, calendar.primary, calendar.writable],
      );
      await ctx.db.query(
        `delete from calendar_sources s where s.connection_id=$1 and s.provider_calendar_id='primary'
          and exists(select 1 from calendar_sources real where real.connection_id=$1 and real.is_primary and real.provider_calendar_id<>'primary')
          and not exists(select 1 from calendar_sync_origins o where o.connection_id=$1 and o.provider_calendar_id='primary')`,
        [connection.id],
      );
      // Every owner has exactly one write destination, independent of how
      // many calendars are selected for reading.
      const [writeDefault] = await ctx.db.query<{id:string}>(
        `select id from calendar_sources where owner_user_id=$1 and writable and selected
         order by is_write_default desc,is_primary desc,last_discovered_at desc,id limit 1`, [ownerUserId],
      );
      await ctx.db.query(`update calendar_sources set is_write_default=false where owner_user_id=$1 and is_write_default`, [ownerUserId]);
      if(writeDefault)await ctx.db.query(`update calendar_sources set is_write_default=true where id=$1 and owner_user_id=$2`,[writeDefault.id,ownerUserId]);
      const selected = await ctx.db.query<{ provider_calendar_id:string; name:string; writable:boolean }>(
        `select provider_calendar_id,name,writable from calendar_sources where connection_id=$1 and selected order by id`,
        [connection.id],
      );
      for (const source of selected) {
        const origin = await ensureInternalCalendar(ctx.db, {
          ownerUserId, connectionId: connection.id, provider: connection.provider,
          providerCalendarId: source.provider_calendar_id, name: source.name, writable: source.writable,
        });
        await syncCalendarOrigin(ctx.db, origin.id, { masterKey, fetchImpl: ctx.fetchImpl });
      }
      await ctx.db.query(`update calendars set is_default=false where owner_user_id=$1 and is_default`, [ownerUserId]);
      await ctx.db.query(
        `update calendars c set is_default=true
          from calendar_sync_origins o join calendar_sources s
            on s.connection_id=o.connection_id and s.provider_calendar_id=o.provider_calendar_id
         where c.id=o.calendar_id and o.owner_user_id=$1 and s.is_write_default`, [ownerUserId],
      );
    } catch {
      errors.push({ connectionId: connection.id, provider: connection.provider, error: 'That account could not be refreshed. Check its connection health.' });
    }
  }
  return errors;
}

export function calendarRoutes(ctx: Ctx): Router {
  const r = Router(); r.use(requireAuth);
  r.get('/internal/calendars', handle(async (req, res) => {
    const calendars = await ctx.db.query(
      `select c.id, c.name, c.color, c.is_default as "isDefault",
              o.id as "originId", o.provider, o.provider_calendar_id as "providerCalendarId",
              o.sync_mode as "syncMode", o.status as "syncStatus",
              o.last_sync_at as "lastSyncAt", o.last_error_category as "lastError",
              cn.account_email as account
         from calendars c
         left join calendar_sync_origins o on o.calendar_id=c.id and o.owner_user_id=$1
         left join connections cn on cn.id=o.connection_id
        where c.owner_user_id=$1
        order by c.is_default desc, c.name, o.created_at`,
      [req.user!.id],
    );
    return res.json({ calendars });
  }));
  r.get('/internal/events', handle(async (req, res) => {
    const start = new Date(String(req.query.start ?? '')); const end = new Date(String(req.query.end ?? ''));
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || end.getTime()-start.getTime()>92*86400000) throw new HttpError(400, 'choose a valid range of at most 92 days');
    const events = await ctx.db.query(
      `select e.id, e.calendar_id as "calendarId", e.title, e.description, e.location,
              e.starts_at as "startsAt", e.ends_at as "endsAt",
              e.start_date as "startDate", e.end_date as "endDate", e.all_day as "allDay",
              e.timezone, e.status, e.organizer, e.attendees, e.recurrence,
              e.recurring_event_id as "recurringEventId", e.original_start as "originalStart",
              e.sync_state as "syncState", e.sync_error as "syncError", e.updated_at as "updatedAt",
              c.name as "calendarName", c.color as "calendarColor",
              o.provider, o.last_sync_at as "lastSyncAt", cn.account_email as account
         from calendar_events e
         join calendars c on c.id=e.calendar_id and c.owner_user_id=e.owner_user_id
         left join calendar_sync_origins o on o.calendar_id=e.calendar_id and o.owner_user_id=e.owner_user_id
         left join connections cn on cn.id=o.connection_id
        where e.owner_user_id=$1 and e.deleted_at is null
          and ((not e.all_day and e.starts_at<$3 and e.ends_at>$2)
            or (e.all_day and e.start_date<$3::date and e.end_date>$2::date))
        order by coalesce(e.starts_at,e.start_date::timestamptz),e.id`,
      [req.user!.id, start.toISOString(), end.toISOString()],
    );
    return res.json({ events });
  }));
  r.get('/internal/events/:id', handle(async (req, res) => {
    const [event] = await ctx.db.query(
      `select e.id, e.calendar_id as "calendarId", e.title, e.description, e.location,
              e.starts_at as "startsAt", e.ends_at as "endsAt",
              e.start_date as "startDate", e.end_date as "endDate", e.all_day as "allDay",
              e.timezone, e.status, e.organizer, e.attendees, e.recurrence,
              e.recurring_event_id as "recurringEventId", e.original_start as "originalStart",
              e.sync_state as "syncState", e.sync_error as "syncError", e.updated_at as "updatedAt",
              c.name as "calendarName", c.color as "calendarColor",
              o.provider, o.last_sync_at as "lastSyncAt", cn.account_email as account
         from calendar_events e
         join calendars c on c.id=e.calendar_id and c.owner_user_id=e.owner_user_id
         left join calendar_sync_origins o on o.calendar_id=e.calendar_id and o.owner_user_id=e.owner_user_id
         left join connections cn on cn.id=o.connection_id
        where e.id=$1 and e.owner_user_id=$2 and e.deleted_at is null`,
      [param(req, 'id'), req.user!.id],
    );
    if (!event) throw new HttpError(404, 'event not found');
    return res.json({ event });
  }));
  r.get('/sources', handle(async (req, res) => {
    const [count] = await ctx.db.query<{ n: number }>(`select count(*)::int n from calendar_sources where owner_user_id=$1`, [req.user!.id]);
    const discoveryErrors = (count?.n ?? 0) === 0 || req.query.refresh === 'true' ? await discover(ctx, req.user!.id) : [];
    const sources = await ctx.db.query(
      `select s.id, s.connection_id as "connectionId", s.provider_calendar_id as "providerCalendarId",
              s.name, s.color, s.is_primary as "primary", s.selected, s.writable,
              s.is_write_default as "writeDefault",
              c.provider, c.account_email as account
         from calendar_sources s join connections c on c.id=s.connection_id
        where s.owner_user_id=$1 order by c.provider, c.account_email nulls last, s.is_primary desc, s.name`,
      [req.user!.id],
    );
    return res.json({ sources, discoveryErrors });
  }));
  r.put('/sources/:id', handle(async (req, res) => {
    const sourceId = param(req, 'id');
    const wantsDefault = req.body?.writeDefault === true;
    const selected = req.body?.selected;
    const rows = wantsDefault
      ? await ctx.db.query<{ id: string }>(
        `update calendar_sources set selected=true
          where id=$1 and owner_user_id=$2 and writable returning id`, [sourceId, req.user!.id],
      )
      : await ctx.db.query<{ id: string }>(
        `update calendar_sources set selected=$3 where id=$1 and owner_user_id=$2 returning id`,
        [sourceId, req.user!.id, selected === true],
      );
    if (!rows.length) throw new HttpError(404, 'calendar not found');
    if (wantsDefault) {
      await ctx.db.query(`update calendar_sources set is_write_default=false where owner_user_id=$1 and is_write_default`,[req.user!.id]);
      await ctx.db.query(`update calendar_sources set is_write_default=true where id=$1 and owner_user_id=$2`,[sourceId,req.user!.id]);
    }
    if (!wantsDefault) {
      const [nextDefault]=await ctx.db.query<{id:string}>(`select id from calendar_sources where owner_user_id=$1 and selected and writable order by is_write_default desc,is_primary desc,last_discovered_at desc,id limit 1`,[req.user!.id]);
      await ctx.db.query(`update calendar_sources set is_write_default=false where owner_user_id=$1 and is_write_default`,[req.user!.id]);
      if(nextDefault)await ctx.db.query(`update calendar_sources set is_write_default=true where id=$1 and owner_user_id=$2`,[nextDefault.id,req.user!.id]);
      if (selected === true) {
        const [source] = await ctx.db.query<{connection_id:string;provider_calendar_id:string;name:string;writable:boolean;provider:CalendarProvider}>(
          `select s.connection_id,s.provider_calendar_id,s.name,s.writable,c.provider from calendar_sources s
            join connections c on c.id=s.connection_id where s.id=$1 and s.owner_user_id=$2`, [sourceId, req.user!.id],
        );
        if (source) {
          const masterKey=key(ctx);
          const origin=await ensureInternalCalendar(ctx.db,{ownerUserId:req.user!.id,connectionId:source.connection_id,provider:source.provider,providerCalendarId:source.provider_calendar_id,name:source.name,writable:source.writable});
          await syncCalendarOrigin(ctx.db,origin.id,{masterKey,fetchImpl:ctx.fetchImpl});
        }
      }
    }
    await ctx.db.query(`update calendars set is_default=false where owner_user_id=$1 and is_default`, [req.user!.id]);
    await ctx.db.query(
      `update calendars c set is_default=true from calendar_sync_origins o
        join calendar_sources s on s.connection_id=o.connection_id and s.provider_calendar_id=o.provider_calendar_id
       where c.id=o.calendar_id and s.owner_user_id=$1 and s.is_write_default`, [req.user!.id],
    );
    return res.json({ ok: true });
  }));
  r.get('/events', handle(async (req, res) => {
    const start = new Date(String(req.query.start ?? '')); const end = new Date(String(req.query.end ?? ''));
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || end.getTime()-start.getTime()>92*86400000) throw new HttpError(400, 'choose a valid range of at most 92 days');
    const sources = await ctx.db.query<{ id:string; connection_id:string; provider_calendar_id:string; name:string; color:string|null; provider:OAuthProvider; account:string|null }>(
      `select s.id,s.connection_id,s.provider_calendar_id,s.name,s.color,c.provider,c.account_email account
       from calendar_sources s join connections c on c.id=s.connection_id
       where s.owner_user_id=$1 and s.selected=true order by s.name`, [req.user!.id]);
    const events: unknown[] = []; const sourceErrors: Array<{ sourceId:string; error:string }> = [];
    for (const source of sources) {
      try {
        if (!(await calendarAccess(ctx.db, source.connection_id))) throw new HttpError(403, 'Calendar access is disabled.');
        const connection = await getConnection(ctx.db, source.connection_id); if (!connection || connection.status !== 'active') throw new HttpError(403, 'Calendar account is unavailable.');
        const client = await loadClient(ctx.db, key(ctx), source.provider);
        const accessToken = await accessTokenFor(ctx.db, key(ctx), { connection, client }, { fetchImpl: ctx.fetchImpl });
        const found = await listEvents(source.provider, { accessToken, calendarId: source.provider_calendar_id, timeMin:start.toISOString(), timeMax:end.toISOString(), limit:1000 }, { fetchImpl:ctx.fetchImpl });
        events.push(...found.map(event => ({ ...event, eventId:event.sourceId, sourceId:source.id, sourceName:source.name, connectionId:source.connection_id, providerCalendarId:source.provider_calendar_id, sourceColor:source.color, provider:source.provider, account:source.account })));
      } catch { sourceErrors.push({ sourceId: source.id, error: `Calendar ${source.name} could not be loaded. Check its account connection and permissions, or choose a shorter range.` }); }
    }
    events.sort((a:any,b:any)=>String(a.start??'').localeCompare(String(b.start??'')));
    return res.json({ events, sourceErrors });
  }));
  r.get('/events/:sourceId/:eventId', handle(async (req, res) => {
    const [source] = await ctx.db.query<{ connection_id:string; provider_calendar_id:string; provider:OAuthProvider; name:string; color:string|null; account:string|null }>(
      `select s.connection_id,s.provider_calendar_id,s.name,s.color,c.provider,c.account_email account from calendar_sources s join connections c on c.id=s.connection_id where s.id=$1 and s.owner_user_id=$2`, [param(req,'sourceId'), req.user!.id]);
    if (!source || !(await calendarAccess(ctx.db,source.connection_id))) throw new HttpError(404,'event not found');
    const connection=await getConnection(ctx.db,source.connection_id); if(!connection || connection.status !== 'active') throw new HttpError(404,'event not found');
    const client=await loadClient(ctx.db,key(ctx),source.provider); const accessToken=await accessTokenFor(ctx.db,key(ctx),{connection,client},{fetchImpl:ctx.fetchImpl});
    const event=await getEvent(source.provider,{accessToken,calendarId:source.provider_calendar_id,id:param(req,'eventId')},{fetchImpl:ctx.fetchImpl});
    if(!event) throw new HttpError(404,'event not found'); return res.json({event:{...event,eventId:event.sourceId,sourceId:param(req,'sourceId'),connectionId:source.connection_id,providerCalendarId:source.provider_calendar_id,sourceName:source.name,sourceColor:source.color,provider:source.provider,account:source.account}});
  }));
  return r;
}
