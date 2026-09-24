import { createHash, randomUUID } from 'node:crypto';
import { json, type Db, type MasterKey } from '@josi-ce/core';
import { accessTokenFor, can, getConnection } from './connections.js';
import { loadClient } from './oauthClients.js';
import { ConnectorError, type ErrorCategory, type FetchOptions } from './providers.js';
import { providerRequest, raiseProviderError } from './providers/http.js';

export type CalendarProvider = 'google' | 'microsoft';
export type CalendarSyncState = 'synced' | 'pending' | 'failed' | 'conflict';
export interface CalendarEventInput {
  title?: string | null; description?: string | null; location?: string | null;
  start?: string; end?: string; allDay?: boolean; timezone?: string;
  attendees?: string[]; recurrence?: string[]; status?: string;
}
export interface CalendarEventRow {
  id: string; owner_user_id: string; calendar_id: string; title: string | null;
  description: string | null; location: string | null; starts_at: string | null;
  ends_at: string | null; start_date: string | null; end_date: string | null;
  all_day: boolean; timezone: string; status: string; organizer: string | null;
  attendees: Array<{ email: string; response_status?: string }>;
  recurrence: string[]; recurring_event_id: string | null; recurring_provider_event_id: string | null;
  original_start: string | null; sync_state: CalendarSyncState; sync_error: string | null;
  local_revision: number; deleted_at: string | null; updated_at: string;
}
interface Origin { id:string; calendar_id:string; connection_id:string; owner_user_id:string; provider:CalendarProvider; provider_calendar_id:string; sync_cursor:string|null; sync_mode:'import_only'|'two_way'; status:string }
interface Link { event_id:string; provider_event_id:string; remote_etag:string|null; remote_fingerprint:string|null; local_fingerprint:string|null }

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
export const calendarFingerprint = (e: Partial<CalendarEventRow>) => hash({
  title:e.title ?? null, description:e.description ?? null, location:e.location ?? null,
  start:e.all_day ? e.start_date : e.starts_at, end:e.all_day ? e.end_date : e.ends_at,
  allDay:!!e.all_day, timezone:e.timezone ?? 'UTC', status:e.status ?? 'confirmed',
  attendees:e.attendees ?? [], recurrence:e.recurrence ?? [], deleted:!!e.deleted_at,
});

function parsed(input: CalendarEventInput) {
  const allDay = input.allDay === true;
  const start = String(input.start ?? ''); const end = String(input.end ?? '');
  if (!start || !end) throw new Error('calendar event needs a start and end');
  if (allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end <= start) throw new Error('all-day event dates are invalid');
  } else {
    const a = new Date(start); const b = new Date(end);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b <= a) throw new Error('calendar event times are invalid');
  }
  return { allDay, start, end };
}

export async function ensureInternalCalendar(db: Db, args:{ownerUserId:string;connectionId:string;provider:CalendarProvider;providerCalendarId?:string;name?:string;writable?:boolean}):Promise<Origin> {
  const connection = await getConnection(db,args.connectionId);
  if (!connection || connection.owner_user_id !== args.ownerUserId || connection.provider !== args.provider) throw new Error('calendar connection does not belong to this user');
  const providerCalendarId=args.providerCalendarId ?? 'primary';
  await db.query(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name,is_primary,selected,writable,is_write_default)
    values($1,$2,$3,$4,
      $5 and not exists(select 1 from calendar_sources where connection_id=$2 and is_primary and provider_calendar_id<>'primary'),
      true,coalesce($6,$5),
      coalesce($6,$5) and not exists(select 1 from calendar_sources where owner_user_id=$1 and is_write_default))
    on conflict(connection_id,provider_calendar_id) do update set
      name=coalesce($7,calendar_sources.name),
      writable=case when $6::boolean is null then calendar_sources.writable else $6 end,
      last_discovered_at=now()`,
    [args.ownerUserId,args.connectionId,providerCalendarId,args.name??(providerCalendarId==='primary'?'Primary calendar':providerCalendarId),providerCalendarId==='primary',args.writable??null,args.name??null]);
  const [existing]=await db.query<Origin>(`select * from calendar_sync_origins where connection_id=$1 and provider_calendar_id=$2`,[args.connectionId,providerCalendarId]);
  if(existing) return existing;
  const [source]=await db.query<{name:string;is_write_default:boolean}>(`select name,is_write_default from calendar_sources where connection_id=$1 and provider_calendar_id=$2`,[args.connectionId,providerCalendarId]);
  // Create non-default first. An upgraded database may still have its old
  // internal default while reconciliation has moved the explicit write default
  // to a newly selected provider source. Inserting the new row as default would
  // violate calendars_one_default before its origin can be provisioned.
  const [calendar]=await db.query<{id:string}>(`insert into calendars(owner_user_id,name,is_default)
    values($1,$2,false) returning id`,[args.ownerUserId,args.name ?? source?.name ?? `${args.provider === 'google' ? 'Google' : 'Outlook'} calendar`]);
  const [origin]=await db.query<Origin>(`insert into calendar_sync_origins(calendar_id,connection_id,owner_user_id,provider,provider_account_id,provider_calendar_id)
    values($1,$2,$3,$4,$5,$6) returning *`,[calendar.id,args.connectionId,args.ownerUserId,args.provider,connection.provider_account_id,providerCalendarId]);
  if(source?.is_write_default===true){
    await db.query(`update calendars set is_default=false where owner_user_id=$1 and is_default`,[args.ownerUserId]);
    await db.query(`update calendars set is_default=true where id=$1 and owner_user_id=$2`,[calendar.id,args.ownerUserId]);
  }
  return origin;
}

async function enqueueOutbox(db:Db, origin:Origin,eventId:string,operation:'create'|'update'|'delete',etag:string|null=null){
  const key=`${origin.id}:${eventId}:${operation}:${randomUUID()}`;
  await db.query(`insert into calendar_outbox(owner_user_id,origin_id,event_id,operation,idempotency_key,expected_remote_etag)
    values($1,$2,$3,$4,$5,$6)
    on conflict(origin_id,event_id) where status in ('queued','running','failed') do update set
      operation=case when excluded.operation='delete' then 'delete' when calendar_outbox.operation='create' then 'create' else excluded.operation end,
      idempotency_key=excluded.idempotency_key, expected_remote_etag=excluded.expected_remote_etag,status='queued',run_at=now(),last_error_category=null`,
    [origin.owner_user_id,origin.id,eventId,operation,key,etag]);
}

export async function createInternalEvent(db:Db,args:{ownerUserId:string;originId:string;event:CalendarEventInput}):Promise<CalendarEventRow>{
  const [origin]=await db.query<Origin>(`select * from calendar_sync_origins where id=$1 and owner_user_id=$2`,[args.originId,args.ownerUserId]);
  if(!origin) throw new Error('calendar not found'); const p=parsed(args.event);
  const [row]=await db.query<CalendarEventRow>(`insert into calendar_events(owner_user_id,calendar_id,title,description,location,starts_at,ends_at,start_date,end_date,all_day,timezone,status,attendees,recurrence)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,[
    args.ownerUserId,origin.calendar_id,args.event.title ?? null,args.event.description ?? null,args.event.location ?? null,
    p.allDay?null:new Date(p.start).toISOString(),p.allDay?null:new Date(p.end).toISOString(),p.allDay?p.start:null,p.allDay?p.end:null,p.allDay,args.event.timezone??'UTC',args.event.status??'confirmed',
    json((args.event.attendees??[]).map(email=>({email}))),json(args.event.recurrence??[])]);
  await enqueueOutbox(db,origin,row.id,'create'); return row;
}

export async function updateInternalEvent(db:Db,args:{ownerUserId:string;eventId:string;changes:CalendarEventInput}):Promise<CalendarEventRow>{
  const [current]=await db.query<CalendarEventRow & {origin_id:string;remote_etag:string|null}>(`select e.*,o.id origin_id,l.remote_etag from calendar_events e join calendar_sync_origins o on o.calendar_id=e.calendar_id left join calendar_event_links l on l.event_id=e.id and l.origin_id=o.id where e.id=$1 and e.owner_user_id=$2 and e.deleted_at is null`,[args.eventId,args.ownerUserId]);
  if(!current) throw new Error('calendar event not found');
  const start=args.changes.start ?? (current.all_day?current.start_date!:current.starts_at!); const end=args.changes.end ?? (current.all_day?current.end_date!:current.ends_at!);
  const p=parsed({...args.changes,start,end,allDay:args.changes.allDay ?? current.all_day});
  const [row]=await db.query<CalendarEventRow>(`update calendar_events set title=$3,description=$4,location=$5,starts_at=$6,ends_at=$7,start_date=$8,end_date=$9,all_day=$10,timezone=$11,status=$12,attendees=$13,recurrence=$14,local_revision=local_revision+1,sync_state='pending',sync_error=null where id=$1 and owner_user_id=$2 returning *`,[
    args.eventId,args.ownerUserId,args.changes.title??current.title,args.changes.description??current.description,args.changes.location??current.location,p.allDay?null:new Date(p.start).toISOString(),p.allDay?null:new Date(p.end).toISOString(),p.allDay?p.start:null,p.allDay?p.end:null,p.allDay,args.changes.timezone??current.timezone,args.changes.status??current.status,json(args.changes.attendees?args.changes.attendees.map(email=>({email})):current.attendees),json(args.changes.recurrence??current.recurrence)]);
  const [origin]=await db.query<Origin>(`select * from calendar_sync_origins where id=$1`,[current.origin_id]); await enqueueOutbox(db,origin,row.id,current.remote_etag?'update':'create',current.remote_etag); return row;
}

export async function deleteInternalEvent(db:Db,args:{ownerUserId:string;eventId:string}):Promise<void>{
  const [row]=await db.query<{origin_id:string;remote_etag:string|null}>(`select o.id origin_id,l.remote_etag from calendar_events e join calendar_sync_origins o on o.calendar_id=e.calendar_id left join calendar_event_links l on l.event_id=e.id and l.origin_id=o.id where e.id=$1 and e.owner_user_id=$2 and e.deleted_at is null`,[args.eventId,args.ownerUserId]);
  if(!row) throw new Error('calendar event not found'); await db.query(`update calendar_events set deleted_at=now(),sync_state='pending',local_revision=local_revision+1 where id=$1`,[args.eventId]);
  const [origin]=await db.query<Origin>(`select * from calendar_sync_origins where id=$1`,[row.origin_id]); await enqueueOutbox(db,origin,args.eventId,'delete',row.remote_etag);
}

export async function listInternalEvents(db:Db,args:{ownerUserId:string;start:string;end:string}):Promise<CalendarEventRow[]>{
  return db.query<CalendarEventRow>(`select * from calendar_events where owner_user_id=$1 and deleted_at is null and ((not all_day and starts_at<$3 and ends_at>$2) or (all_day and start_date<$3::date and end_date>$2::date)) order by coalesce(starts_at,start_date::timestamptz),id`,[args.ownerUserId,args.start,args.end]);
}
export async function getInternalEvent(db:Db,args:{ownerUserId:string;eventId:string}){const [r]=await db.query<CalendarEventRow>(`select * from calendar_events where id=$1 and owner_user_id=$2 and deleted_at is null`,[args.eventId,args.ownerUserId]);return r??null;}

function googleBody(e:CalendarEventRow,includeId=false){return {...(includeId?{id:e.id.replace(/-/g,'')}:{}),summary:e.title,description:e.description,location:e.location,status:e.status,attendees:e.attendees,recurrence:e.recurrence,
  start:e.all_day?{date:e.start_date}:{dateTime:e.starts_at,timeZone:e.timezone},end:e.all_day?{date:e.end_date}:{dateTime:e.ends_at,timeZone:e.timezone}};}
async function session(db:Db,origin:Origin,key:MasterKey,fetchImpl?:typeof fetch){
  const connection=await getConnection(db,origin.connection_id); if(!connection) throw new Error('calendar connection is gone');
  const capability=`${origin.provider}.calendar.write`; if(!(await can(db,{ownerUserId:origin.owner_user_id,capability})).allowed) throw new ConnectorError('calendar write access is disabled',{category:'insufficient_scope'});
  const client=await loadClient(db,key,origin.provider); const accessToken=await accessTokenFor(db,key,{connection,client},{fetchImpl}); return accessToken;
}

export async function processCalendarOutbox(db:Db,args:{masterKey:MasterKey;fetchImpl?:typeof fetch;limit?:number}){
  const rows=await db.query<any>(`update calendar_outbox set status='running',attempts=attempts+1 where id in(select id from calendar_outbox where status in('queued','failed') and run_at<=now() order by run_at for update skip locked limit $1) returning *`,[args.limit??20]);
  for(const item of rows){
    try{
      const [origin]=await db.query<Origin>(`select * from calendar_sync_origins where id=$1`,[item.origin_id]); const [event]=await db.query<CalendarEventRow>(`select * from calendar_events where id=$1 and owner_user_id=$2`,[item.event_id,item.owner_user_id]);
      if(!origin||!event) throw new Error('calendar outbox reference is gone'); const token=await session(db,origin,args.masterKey,args.fetchImpl);
      const [link]=await db.query<Link>(`select * from calendar_event_links where origin_id=$1 and event_id=$2`,[origin.id,event.id]);
      if(origin.provider!=='google') throw new ConnectorError('Outlook calendar sync is not enabled yet',{category:'provider_error'});
      const base=`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(origin.provider_calendar_id)}/events`;
      const remoteId=link?.provider_event_id; const headers:any={Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Goog-Request-Id':item.idempotency_key}; if(item.expected_remote_etag) headers['If-Match']=item.expected_remote_etag;
      const method=item.operation==='create'?'POST':item.operation==='delete'?'DELETE':'PATCH'; const url=remoteId?`${base}/${encodeURIComponent(remoteId)}`:base;
      let result=await providerRequest(url,{method,headers,...(method==='DELETE'?{}:{body:JSON.stringify(googleBody(event,item.operation==='create'))})},{fetchImpl:args.fetchImpl});
      if(item.operation==='create'&&result.status===409){
        const stableId=event.id.replace(/-/g,'');
        result=await providerRequest(`${base}/${stableId}`,{headers:{Authorization:`Bearer ${token}`}},{fetchImpl:args.fetchImpl});
      }
      if(result.status===412){await db.query(`update calendar_events set sync_state='conflict',conflict_state='local_remote_changed' where id=$1`,[event.id]);await db.query(`update calendar_outbox set status='conflict',last_error_category='conflict' where id=$1`,[item.id]);continue;}
      if(result.status<200||result.status>=300){if(item.operation==='delete'&&result.status===410){}else raiseProviderError(result.status,result.body);}
      if(item.operation==='delete'){await db.query(`insert into calendar_tombstones(owner_user_id,origin_id,event_id,provider_event_id,deleted_side) values($1,$2,$3,$4,'local') on conflict do nothing`,[event.owner_user_id,origin.id,event.id,remoteId]);}
      else {const body:any=result.body??{}; const id=String(body.id??remoteId??''); const etag=typeof body.etag==='string'?body.etag:null; const fp=calendarFingerprint(event); await db.query(`insert into calendar_event_links(origin_id,event_id,provider_event_id,ical_uid,remote_etag,remote_revision,remote_updated_at,remote_fingerprint,local_fingerprint,last_synced_at) values($1,$2,$3,$4,$5,$6,$7,$8,$8,now()) on conflict(origin_id,event_id) do update set provider_event_id=excluded.provider_event_id,ical_uid=excluded.ical_uid,remote_etag=excluded.remote_etag,remote_revision=excluded.remote_revision,remote_updated_at=excluded.remote_updated_at,remote_fingerprint=excluded.remote_fingerprint,local_fingerprint=excluded.local_fingerprint,last_synced_at=now()`,[origin.id,event.id,id,body.iCalUID??null,etag,body.sequence==null?null:String(body.sequence),body.updated??null,fp]); await db.query(`update calendar_events set sync_state='synced',sync_error=null,conflict_state=null where id=$1`,[event.id]);}
      await db.query(`update calendar_outbox set status='done',last_error_category=null where id=$1`,[item.id]);
    }catch(err){const cat=err instanceof ConnectorError?err.category:'provider_error';await db.query(`update calendar_outbox set status='failed',last_error_category=$2,run_at=now()+make_interval(secs=>least(3600,30*power(2,attempts))) where id=$1`,[item.id,cat]);await db.query(`update calendar_events set sync_state='failed',sync_error=$2 where id=$1`,[item.event_id,cat]);}
  } return rows.length;
}

export async function dueCalendarOrigins(db:Db,limit=20){return db.query<{id:string}>(`select id from calendar_sync_origins where status in('idle','error') and (last_attempt_at is null or last_attempt_at<now()-make_interval(secs=>sync_interval_seconds)) order by last_attempt_at nulls first limit $1`,[limit]);}
export async function markCalendarAttempted(db:Db,id:string){await db.query(`update calendar_sync_origins set last_attempt_at=now() where id=$1`,[id]);}

/** Backfills existing connected calendars without making a conversation wait
 * for a provider call. Safe on every scheduler tick; the origin key is unique. */
export async function provisionCalendarOrigins(db:Db):Promise<number>{
  const rows=await db.query<{owner_user_id:string;connection_id:string;provider:CalendarProvider;provider_calendar_id:string;name:string;writable:boolean}>(`select s.owner_user_id,s.connection_id,c.provider,s.provider_calendar_id,s.name,s.writable
    from calendar_sources s join connections c on c.id=s.connection_id join connection_capabilities cc on cc.connection_id=c.id
    where c.provider in('google','microsoft') and c.status='active' and cc.enabled
      and cc.capability in('google.calendar.read','google.calendar.write','microsoft.calendar.read','microsoft.calendar.write')
      and s.selected
      and not exists(select 1 from calendar_sync_origins o where o.connection_id=s.connection_id and o.provider_calendar_id=s.provider_calendar_id)
    group by s.owner_user_id,s.connection_id,c.provider,s.provider_calendar_id,s.name,s.writable`);
  for(const row of rows)await ensureInternalCalendar(db,{ownerUserId:row.owner_user_id,connectionId:row.connection_id,provider:row.provider,providerCalendarId:row.provider_calendar_id,name:row.name,writable:row.writable});
  return rows.length;
}

export async function enqueueCalendarWebhook(db:Db,args:{channelId:string;resourceId:string}):Promise<boolean>{
  const [origin]=await db.query<{id:string}>(`select id from calendar_sync_origins where webhook_channel_id=$1 and webhook_resource_id=$2 and status<>'disconnected'`,[args.channelId,args.resourceId]);
  if(!origin)return false;
  const [existing]=await db.query<{id:number}>(`select id from job_queue where kind='calendar.sync' and status in('queued','running') and payload->>'originId'=$1 limit 1`,[origin.id]);
  if(!existing)await db.query(`insert into job_queue(kind,payload) values('calendar.sync',$1)`,[json({originId:origin.id})]);
  return true;
}

async function ensureGoogleWatch(db:Db,origin:Origin,token:string,fetchImpl?:typeof fetch){
  const [config]=await db.query<{domain:string}>(`select domain from deployment_config where id=true and domain is not null`);
  if(!config?.domain)return;
  const [fresh]=await db.query<{webhook_expires_at:string|null}>(`select webhook_expires_at from calendar_sync_origins where id=$1`,[origin.id]);
  if(fresh?.webhook_expires_at && new Date(fresh.webhook_expires_at).getTime()>Date.now()+86_400_000)return;
  const channelId=randomUUID();const address=`https://${config.domain.replace(/^https?:\/\//,'').replace(/\/$/,'')}/calendar/google/webhook`;
  const res=await providerRequest(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(origin.provider_calendar_id)}/events/watch`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({id:channelId,type:'web_hook',address})},{fetchImpl});
  if(res.status<200||res.status>=300)raiseProviderError(res.status,res.body);const body:any=res.body??{};
  await db.query(`update calendar_sync_origins set webhook_channel_id=$2,webhook_resource_id=$3,webhook_expires_at=$4 where id=$1`,[origin.id,channelId,String(body.resourceId??''),body.expiration?new Date(Number(body.expiration)).toISOString():new Date(Date.now()+6*86_400_000).toISOString()]);
}

export async function syncCalendarOrigin(db:Db,originId:string,args:{masterKey:MasterKey;fetchImpl?:typeof fetch}){
  const [origin]=await db.query<Origin>(`select * from calendar_sync_origins where id=$1`,[originId]); if(!origin||!['idle','error','syncing'].includes(origin.status))return;
  if(origin.provider!=='google')return; await db.query(`update calendar_sync_origins set status='syncing' where id=$1`,[origin.id]);
  try{
    const connection=await getConnection(db,origin.connection_id);if(!connection)throw new Error('calendar connection is gone');const client=await loadClient(db,args.masterKey,'google');const token=await accessTokenFor(db,args.masterKey,{connection,client},{fetchImpl:args.fetchImpl});
    let page:string|null=null;let cursor:string|null=origin.sync_cursor;
    do{const q=new URLSearchParams({showDeleted:'true',singleEvents:'true',maxResults:'2500'});if(cursor)q.set('syncToken',cursor);if(page)q.set('pageToken',page);const res=await providerRequest(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(origin.provider_calendar_id)}/events?${q}`,{headers:{Authorization:`Bearer ${token}`}},{fetchImpl:args.fetchImpl});
      if(res.status===410&&cursor){await db.query(`update calendar_sync_origins set sync_cursor=null,status='idle' where id=$1`,[origin.id]);return syncCalendarOrigin(db,origin.id,args);}if(res.status<200||res.status>=300)raiseProviderError(res.status,res.body);const body:any=res.body??{};for(const remote of body.items??[])await applyRemote(db,origin,remote);page=body.nextPageToken??null;if(!page&&body.nextSyncToken)cursor=body.nextSyncToken;
    }while(page);
    await ensureGoogleWatch(db,origin,token,args.fetchImpl);
    await db.query(`update calendar_sync_origins set status='idle',sync_cursor=$2,last_sync_at=now(),last_error_category=null where id=$1`,[origin.id,cursor]);
  }catch(err){const category:ErrorCategory=err instanceof ConnectorError?err.category:'provider_error';await db.query(`update calendar_sync_origins set status='error',last_error_category=$2 where id=$1`,[origin.id,category]);}
}

async function applyRemote(db:Db,origin:Origin,r:any){
  const remoteId=String(r.id??'');if(!remoteId)return;const [link]=await db.query<Link>(`select * from calendar_event_links where origin_id=$1 and provider_event_id=$2`,[origin.id,remoteId]);
  if(r.status==='cancelled'){
    if(link){await db.query(`update calendar_events set deleted_at=coalesce(deleted_at,now()),sync_state='synced' where id=$1`,[link.event_id]);await db.query(`insert into calendar_tombstones(owner_user_id,origin_id,event_id,provider_event_id,deleted_side) values($1,$2,$3,$4,'remote') on conflict do nothing`,[origin.owner_user_id,origin.id,link.event_id,remoteId]);}return;
  }
  const allDay=!!r.start?.date;
  const [parentLink]=r.recurringEventId
    ? await db.query<{event_id:string}>(`select event_id from calendar_event_links where origin_id=$1 and provider_event_id=$2`,[origin.id,String(r.recurringEventId)]) : [];
  const shaped:any={title:r.summary??null,description:r.description??null,location:r.location??null,all_day:allDay,starts_at:allDay?null:r.start?.dateTime??null,ends_at:allDay?null:r.end?.dateTime??null,start_date:allDay?r.start?.date:null,end_date:allDay?r.end?.date:null,timezone:r.start?.timeZone??'UTC',status:r.status??'confirmed',organizer:r.organizer?.email??null,attendees:(r.attendees??[]).map((a:any)=>({email:a.email,response_status:a.responseStatus})),recurrence:r.recurrence??[],recurring_event_id:parentLink?.event_id??null,recurring_provider_event_id:r.recurringEventId?String(r.recurringEventId):null,original_start:r.originalStartTime?.dateTime??r.originalStartTime?.date??null,deleted_at:null};const remoteFp=calendarFingerprint(shaped);
  if(link){const [local]=await db.query<CalendarEventRow>(`select * from calendar_events where id=$1`,[link.event_id]);const localFp=local?calendarFingerprint(local):null;const remoteChanged=link.remote_fingerprint!==null&&remoteFp!==link.remote_fingerprint;const localChanged=link.local_fingerprint!==null&&localFp!==link.local_fingerprint;if(remoteChanged&&localChanged){await db.query(`update calendar_events set sync_state='conflict',conflict_state='local_remote_changed' where id=$1`,[link.event_id]);return;}await db.query(`update calendar_events set title=$2,description=$3,location=$4,starts_at=$5,ends_at=$6,start_date=$7,end_date=$8,all_day=$9,timezone=$10,status=$11,organizer=$12,attendees=$13,recurrence=$14,recurring_event_id=$15,recurring_provider_event_id=$16,original_start=$17,sync_state='synced',sync_error=null,deleted_at=null where id=$1`,[link.event_id,shaped.title,shaped.description,shaped.location,shaped.starts_at,shaped.ends_at,shaped.start_date,shaped.end_date,shaped.all_day,shaped.timezone,shaped.status,shaped.organizer,json(shaped.attendees),json(shaped.recurrence),shaped.recurring_event_id,shaped.recurring_provider_event_id,shaped.original_start]);await db.query(`update calendar_event_links set remote_etag=$2,remote_revision=$3,remote_updated_at=$4,remote_fingerprint=$5,local_fingerprint=$5,last_synced_at=now() where origin_id=$1 and provider_event_id=$6`,[origin.id,r.etag??null,r.sequence==null?null:String(r.sequence),r.updated??null,remoteFp,remoteId]);return;}
  const [tomb]=await db.query<{id:string}>(`select id from calendar_tombstones where origin_id=$1 and provider_event_id=$2`,[origin.id,remoteId]);if(tomb)return;const [event]=await db.query<{id:string}>(`insert into calendar_events(owner_user_id,calendar_id,title,description,location,starts_at,ends_at,start_date,end_date,all_day,timezone,status,organizer,attendees,recurrence,recurring_event_id,recurring_provider_event_id,original_start,sync_state) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'synced') returning id`,[origin.owner_user_id,origin.calendar_id,shaped.title,shaped.description,shaped.location,shaped.starts_at,shaped.ends_at,shaped.start_date,shaped.end_date,shaped.all_day,shaped.timezone,shaped.status,shaped.organizer,json(shaped.attendees),json(shaped.recurrence),shaped.recurring_event_id,shaped.recurring_provider_event_id,shaped.original_start]);await db.query(`insert into calendar_event_links(origin_id,event_id,provider_event_id,ical_uid,remote_etag,remote_revision,remote_updated_at,remote_fingerprint,local_fingerprint,last_synced_at) values($1,$2,$3,$4,$5,$6,$7,$8,$8,now())`,[origin.id,event.id,remoteId,r.iCalUID??null,r.etag??null,r.sequence==null?null:String(r.sequence),r.updated??null,remoteFp]);
}
