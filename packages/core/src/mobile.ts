import { createHash, randomUUID } from 'node:crypto';
import { json, type Db } from './db.js';
import { asSecret, openSealed, seal } from './sealing.js';
import type { MasterKey } from './masterKey.js';

export type TurnStatus='queued'|'running'|'completed'|'failed';
export interface DurableTurn { id:string;owner_user_id:string;accepted_session_id:string;thread_id:string;client_message_id:string;attempt_of:string|null;inbound_message_id:string;reply_to_message_id:string|null;attachment_ids:string[];status:TurnStatus;assistant_message_id:string|null;tool_receipts:unknown[];error_code:string|null;error_retryable:boolean|null;created_at:string;updated_at:string; }
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
export class MobileError extends Error { constructor(readonly code:string,message:string){super(message);} }

/** A single PostgreSQL statement is the acceptance transaction: attachment and
 * reply receipts are owner/thread-bound, then the inbound message, turn and
 * queue row become visible together. A duplicate key returns the original turn
 * and creates no second message/job. */
export async function submitDurableTurn(db:Db,args:{ownerUserId:string;sessionId?:string;threadId:string;clientMessageId:string;message:string;replyToMessageId?:string|null;attachmentIds?:string[];attemptOf?:string|null}):Promise<{turn:DurableTurn;duplicate:boolean}>{
  const suppliedAttachmentIds=args.attachmentIds??[];
  const attachmentIds=[...new Set(suppliedAttachmentIds)].sort();
  const message=args.message.trim();
  if(!args.clientMessageId||Buffer.byteLength(args.clientMessageId,'utf8')>128)throw new MobileError('invalid_idempotency_key','A client_message_id of at most 128 bytes is required.');
  if(!message&&!attachmentIds.length)throw new MobileError('empty_turn','Say something or attach a file.');
  if(attachmentIds.length!==suppliedAttachmentIds.length||attachmentIds.length>10||attachmentIds.some(id=>!uuid.test(id)))throw new MobileError('invalid_attachments','Choose at most ten distinct, valid attachment receipts.');
  if(args.replyToMessageId&&!uuid.test(args.replyToMessageId))throw new MobileError('invalid_reply_target','Choose a valid reply target.');
  if(args.attemptOf&&!uuid.test(args.attemptOf))throw new MobileError('invalid_attempt','Choose a valid prior attempt.');
  const [liveSession]=await db.query<{id:string}>(`select id from sessions where id=coalesce($2::uuid,id) and user_id=$1 and revoked_at is null and expires_at>now() order by created_at desc limit 1`,[args.ownerUserId,args.sessionId??null]);
  if(!liveSession)throw new MobileError('session_expired','Sign in again before submitting a turn.');
  const requestHash=digest({message,replyToMessageId:args.replyToMessageId??null,attachmentIds,attemptOf:args.attemptOf??null});
  let rows:Array<DurableTurn&{duplicate:boolean;request_hash:string}>;
  try{rows=await db.query<DurableTurn&{duplicate:boolean;request_hash:string}>(`
    with owned as (
      select id from threads where id=$2 and owner_user_id=$1 and status='open'
    ), valid_attachments as (
      select coalesce(array_agg(a.id order by a.id),array[]::uuid[]) ids,count(*)::int n
      from chat_attachments a join owned t on t.id=a.thread_id
      where a.owner_user_id=$1 and a.storage_state='ready' and a.id=any($6::uuid[])
    ), valid_reply as (
      select case when $5::uuid is null then true else exists(
        select 1 from messages m join owned t on t.id=m.thread_id where m.id=$5
      ) end ok
    ), valid_attempt as (
      select case when $7::uuid is null then true else exists(
        select 1 from assistant_turns x where x.id=$7 and x.owner_user_id=$1 and x.thread_id=$2 and x.status='failed' and x.error_retryable=true
      ) end ok
    ), existing as (
      select * from assistant_turns where owner_user_id=$1 and thread_id=$2 and client_message_id=$3
    ), inbound as (
      insert into messages(thread_id,direction,channel,body,meta)
      select $2,'in','native',$4,jsonb_build_object('attachments',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename,'contentType',a.content_type,'analysis',jsonb_build_object('status',a.analysis_status,'code',a.analysis_code)) order by a.id) from chat_attachments a where a.id=any($6::uuid[])),jsonb_build_array()))
      where exists(select 1 from owned) and not exists(select 1 from existing)
        and (select n from valid_attachments)=cardinality($6::uuid[]) and (select ok from valid_reply) and (select ok from valid_attempt)
      returning id
    ), pinned as (
      update chat_attachments set referenced_at=coalesce(referenced_at,now()) where id=any($6::uuid[]) and exists(select 1 from inbound) returning id
    ), inserted as (
      insert into assistant_turns(owner_user_id,accepted_session_id,thread_id,client_message_id,attempt_of,inbound_message_id,reply_to_message_id,attachment_ids,request_hash)
      select $1,$9,$2,$3,$7,id,$5,$6,$8 from inbound returning *
    ), queued as (
      insert into job_queue(kind,payload) select 'assistant.turn',jsonb_build_object('turnId',id) from inserted on conflict do nothing
    ), touched as (
      update threads set last_activity_at=now() where id=$2 and exists(select 1 from inserted) returning id
    )
    select e.*,true duplicate,e.request_hash from existing e
    union all select i.*,false duplicate,i.request_hash from inserted i`,
    [args.ownerUserId,args.threadId,args.clientMessageId,message||'Sent an attachment',args.replyToMessageId??null,attachmentIds,args.attemptOf??null,requestHash,liveSession.id]);}
  catch(err){
    // Concurrent first submissions can race at the unique key. The losing
    // statement is rolled back in full (including its message); return the
    // committed winner rather than surfacing an uncertain-response failure.
    if(/assistant_turn_capacity/i.test(String((err as Error).message)))throw new MobileError('turn_queue_full','Too many turns are already queued or running. Reconcile them before retrying.');
    if(!/assistant_turns_owner_user_id_thread_id_client_message_id_key|duplicate key/i.test(String((err as Error).message)))throw err;
    rows=await db.query<DurableTurn&{duplicate:boolean;request_hash:string}>(`select t.*,true duplicate from assistant_turns t where owner_user_id=$1 and thread_id=$2 and client_message_id=$3`,[args.ownerUserId,args.threadId,args.clientMessageId]);
  }
  if(!rows.length)throw new MobileError('invalid_receipt_binding','Thread, attachment, reply, or prior-attempt receipt is unavailable.');
  if(rows[0].request_hash!==requestHash)throw new MobileError('idempotency_conflict','That client_message_id was already used for a different request.');
  return {turn:rows[0],duplicate:rows[0].duplicate};
}

export interface TurnCursor { updated_at:string; id:string }
export function encodeTurnCursor(turn:Pick<DurableTurn,'updated_at'|'id'>):string{return Buffer.from(JSON.stringify({updated_at:turn.updated_at,id:turn.id})).toString('base64url');}
export function decodeTurnCursor(value:string):TurnCursor{try{const parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as TurnCursor;if(!parsed.updated_at||Number.isNaN(Date.parse(parsed.updated_at))||!uuid.test(parsed.id))throw new Error();return parsed;}catch{throw new MobileError('invalid_reconciliation_cursor','Choose a valid reconciliation cursor.');}}
export async function listDurableTurns(db:Db,args:{ownerUserId:string;threadId:string;cursor?:string|null;turnId?:string|null}):Promise<DurableTurn[]>{
  const cursor=args.cursor?decodeTurnCursor(args.cursor):null;
  if(args.turnId&&!uuid.test(args.turnId))throw new MobileError('invalid_turn_id','Choose a valid turn id.');
  if(args.turnId)return db.query<DurableTurn>(`select * from assistant_turns where owner_user_id=$1 and thread_id=$2 and id=$3`,[args.ownerUserId,args.threadId,args.turnId]);
  if(cursor)return db.query<DurableTurn>(`select * from assistant_turns where owner_user_id=$1 and thread_id=$2 and (updated_at,id)>($3::timestamptz,$4::uuid) order by updated_at,id limit 200`,[args.ownerUserId,args.threadId,cursor.updated_at,cursor.id]);
  return db.query<DurableTurn>(`select * from (select * from assistant_turns where owner_user_id=$1 and thread_id=$2 order by updated_at desc,id desc limit 200) recent order by updated_at,id`,[args.ownerUserId,args.threadId]);
}
export async function claimDurableTurn(db:Db,turnId:string,leaseSeconds=300):Promise<(DurableTurn&{lease_token:string})|null>{
  const token=randomUUID();
  // An expired running lease is an ambiguous provider boundary: the old
  // process may have reached a model or tool immediately before dying. Never
  // replay it automatically. Terminally reconcile it as retryable and require
  // a new, explicitly linked attempt. This trades transparent replay for the
  // stronger no-duplicate-consequential-action guarantee.
  const [row]=await db.query<DurableTurn&{lease_token:string}>(`with target as (
    select owner_user_id,thread_id from assistant_turns where id=$1
  ), revoked as (
    update assistant_turns t set status='failed',error_code='session_expired',error_retryable=false,completed_at=now()
      where t.status='queued' and (t.owner_user_id,t.thread_id)=(select owner_user_id,thread_id from target)
        and not exists(select 1 from sessions s join users u on u.id=s.user_id where s.id=t.accepted_session_id and s.user_id=t.owner_user_id and s.revoked_at is null and s.expires_at>now() and u.status='active')
      returning id
  ), interrupted as (
    update assistant_turns t set status='failed',lease_token=null,lease_expires_at=null,
      error_code=case when exists(select 1 from assistant_turn_effects e where e.turn_id=t.id) then 'effect_outcome_unknown' else 'worker_interrupted' end,
      error_retryable=not exists(select 1 from assistant_turn_effects e where e.turn_id=t.id),completed_at=now()
      where id=$1 and status='running' and lease_expires_at<now() returning id
  ) update assistant_turns t set status='running',lease_token=$2,lease_expires_at=now()+($3*interval '1 second'),started_at=coalesce(started_at,now()),error_code=null,error_retryable=null
    where t.id=$1 and t.status='queued' and not exists(select 1 from interrupted) and not exists(select 1 from revoked where id=t.id)
      and not exists(select 1 from assistant_turns x where x.thread_id=t.thread_id and x.id<>t.id and x.status='running' and x.lease_expires_at>=now())
      and not exists(select 1 from assistant_turns x where x.thread_id=t.thread_id and x.id<>t.id and x.status in ('queued','running') and (x.created_at,x.id)<(t.created_at,t.id)) returning t.*`,[turnId,token,leaseSeconds]);
  return row??null;
}
export async function renewDurableTurnLease(db:Db,args:{turnId:string;leaseToken:string;leaseSeconds?:number}):Promise<boolean>{
  const rows=await db.query(`update assistant_turns set lease_expires_at=now()+($3*interval '1 second') where id=$1 and status='running' and lease_token=$2 returning id`,[args.turnId,args.leaseToken,args.leaseSeconds??300]);
  return !!rows.length;
}
const GENERIC_PUSH_BODY='Open Josi to view this update.';
const EMPTY_REPLY_PUSH_BODY='Your reply is ready.';
// Bound visible length and UTF-8 bytes while leaving ample room in Expo's
// payload envelope; grapheme segmentation avoids splitting displayed emoji.
const PUSH_PREVIEW_MAX_GRAPHEMES=180;
const PUSH_PREVIEW_MAX_BYTES=720;
function notificationPreview(reply:string):string{
  const plain=reply
    .replace(/```[^\n]*\n?([\s\S]*?)```/g,'$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm,'')
    .replace(/[*_~`]+/g,'')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,' ')
    .replace(/\s+/gu,' ')
    .trim();
  if(!plain)return EMPTY_REPLY_PUSH_BODY;
  const graphemes=Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(plain),part=>part.segment);
  if(graphemes.length<=PUSH_PREVIEW_MAX_GRAPHEMES&&Buffer.byteLength(plain,'utf8')<=PUSH_PREVIEW_MAX_BYTES)return plain;
  const kept:string[]=[];let bytes=Buffer.byteLength('…','utf8');
  for(const grapheme of graphemes){const next=Buffer.byteLength(grapheme,'utf8');if(kept.length>=PUSH_PREVIEW_MAX_GRAPHEMES-1||bytes+next>PUSH_PREVIEW_MAX_BYTES)break;kept.push(grapheme);bytes+=next;}
  return `${kept.join('').trimEnd()}…`;
}
export async function completeDurableTurn(db:Db,args:{turnId:string;leaseToken:string;reply:string;toolReceipts:unknown[];replyMeta?:Record<string,unknown>;approvalNeeded?:boolean;presentedTaskIds?:string[]}):Promise<string|null>{
  const category=args.approvalNeeded?'approval':'assistant',body=args.approvalNeeded?'Your approval is needed.':notificationPreview(args.reply);
  // Create the assistant-completion outbox row even while the app is in the
  // foreground. Dispatch rechecks app state under the device-registration
  // fence, so a foreground -> background transition cannot lose the event.
  const [row]=await db.query<{assistant_message_id:string}>(`with eligible as (select id,thread_id,owner_user_id from assistant_turns where id=$1 and status='running' and lease_token=$2 for update), message as (insert into messages(thread_id,direction,channel,body,meta) select thread_id,'out','native',$4,jsonb_build_object('turn_id',id)||$8 from eligible returning id,thread_id), linked as (update assistant_turns t set status='completed',completed_at=now(),lease_expires_at=null,tool_receipts=$3,assistant_message_id=m.id from message m where t.id=$1 and t.status='running' and t.lease_token=$2 returning t.assistant_message_id,t.owner_user_id,t.thread_id,t.id), presented as (update assistant_action_states a set presented_turn_id=l.assistant_message_id from linked l where a.owner_user_id=l.owner_user_id and a.thread_id=l.thread_id and a.task_id=any($7::uuid[]) and a.status in ('collecting','prepared')), notified as (insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body) select l.owner_user_id,d.id,'turn:'||l.id,$5,'turn',l.id,'Josi',$6 from linked l join mobile_devices d on d.owner_user_id=l.owner_user_id and d.revoked_at is null and coalesce((d.categories->>$5)::boolean,true) where $5<>'approval' on conflict(device_id,event_key) do nothing) select assistant_message_id from linked`,[args.turnId,args.leaseToken,json(args.toolReceipts),args.reply,category,body,args.presentedTaskIds??[],json(args.replyMeta??{})]);
  return row?.assistant_message_id??null;
}
export async function failDurableTurn(db:Db,args:{turnId:string;leaseToken:string;code:string;retryable:boolean}):Promise<boolean>{
  const rows=await db.query(`update assistant_turns set status='failed',lease_expires_at=null,error_code=$3,error_retryable=$4,completed_at=now() where id=$1 and status='running' and lease_token=$2 returning id`,[args.turnId,args.leaseToken,args.code,args.retryable]);return !!rows.length;
}

export class DurableEffectAmbiguousError extends Error { constructor(){super('A consequential tool effect has an unknown outcome and cannot be repeated safely.');} }
export async function beginDurableToolEffect(db:Db,args:{turnId:string;leaseToken:string;effectKey:string;toolName:string}):Promise<{state:'started'|'completed';receipt?:unknown}>{
  const inserted=await db.query<{state:'started';receipt:unknown}>(`insert into assistant_turn_effects(turn_id,effect_key,tool_name)
    select id,$3,$4 from assistant_turns where id=$1 and status='running' and lease_token=$2
    on conflict(turn_id,effect_key) do nothing returning state,receipt`,[args.turnId,args.leaseToken,args.effectKey,args.toolName]);
  if(inserted.length)return {state:'started'};
  const [existing]=await db.query<{state:'started'|'completed';receipt:unknown}>(`select e.state,e.receipt from assistant_turn_effects e join assistant_turns t on t.id=e.turn_id where e.turn_id=$1 and e.effect_key=$3 and t.status='running' and t.lease_token=$2`,[args.turnId,args.leaseToken,args.effectKey]);
  if(!existing||existing.state==='started')throw new DurableEffectAmbiguousError();
  return {state:'completed',receipt:existing.receipt};
}
export async function completeDurableToolEffect(db:Db,args:{turnId:string;leaseToken:string;effectKey:string;receipt:unknown}):Promise<boolean>{
  const rows=await db.query(`update assistant_turn_effects e set state='completed',receipt=$4,completed_at=now() from assistant_turns t where e.turn_id=$1 and e.effect_key=$3 and t.id=e.turn_id and t.status='running' and t.lease_token=$2 and e.state='started' returning e.id`,[args.turnId,args.leaseToken,args.effectKey,json(args.receipt)]);return !!rows.length;
}
export async function durableTurnHasEffects(db:Db,turnId:string):Promise<boolean>{return !!(await db.query(`select 1 from assistant_turn_effects where turn_id=$1 limit 1`,[turnId])).length;}
export async function durableTurnHasIncompleteEffects(db:Db,turnId:string):Promise<boolean>{return !!(await db.query(`select 1 from assistant_turn_effects where turn_id=$1 and state='started' limit 1`,[turnId])).length;}

export interface DeviceInput {deviceIdentity:string;platform:'ios'|'android';expoToken:string;appState:'foreground'|'background'|'inactive';privacyLocked:boolean;categories?:Record<string,boolean>;quietStart?:string|null;quietEnd?:string|null;timezone:string;ownerBinding?:string|null;}
export async function upsertMobileDevice(db:Db,key:MasterKey,ownerUserId:string,input:DeviceInput){
  if(!uuid.test(input.deviceIdentity))throw new MobileError('invalid_device','A stable, opaque installation UUID is required.');
  if(!['ios','android'].includes(input.platform))throw new MobileError('invalid_platform','Platform must be ios or android.');
  if(!['foreground','background','inactive'].includes(input.appState))throw new MobileError('invalid_app_state','Choose a valid app state.');
  if(!/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(input.expoToken))throw new MobileError('invalid_expo_token','A valid Expo push token is required.');
  if((!!input.quietStart!==!!input.quietEnd)||(input.quietStart&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.quietStart))||(input.quietEnd&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.quietEnd)))throw new MobileError('invalid_quiet_hours','Quiet hours require both start and end in HH:MM.');
  try{new Intl.DateTimeFormat('en-US',{timeZone:input.timezone}).format();}catch{throw new MobileError('invalid_timezone','A valid IANA timezone is required.');}
  const supplied=input.categories??{};const categories=Object.fromEntries(['assistant','approval','reminder','calendar'].map(name=>[name,typeof supplied[name]==='boolean'?supplied[name]:true]));
  const fp=digest(input.expoToken);const enc=seal(key,{token:asSecret(input.expoToken)});
  // A token belongs to one current device/account binding. The database
  // function serializes account switches and token moves with registration.
  if(!db.transaction)throw new Error('mobile device registration requires transaction support');
  return db.transaction(async tx=>{
    const [row]=await tx.query<{id:string}>(`select register_mobile_device($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) id`,[ownerUserId,input.deviceIdentity,input.platform,enc,fp,input.appState,input.privacyLocked,json(categories),input.quietStart??null,input.quietEnd??null,input.timezone]);
    await tx.query(`update mobile_devices set owner_binding=$2 where id=$1`,[row.id,input.ownerBinding??null]);
    return row;
  });
}
export async function revokeMobileDevice(db:Db,ownerUserId:string,id:string){
  if(!db.transaction)throw new Error('mobile device revocation requires transaction support');
  return db.transaction(async tx=>{
    // Share the dispatch/registration fence so a revoke either suppresses the
    // row before Expo sees it or waits until the already-started send has a
    // truthful durable outcome. Expo cannot recall a request already accepted.
    await tx.query(`select pg_advisory_xact_lock(hashtext('josi_mobile_device_registration'))`);
    const rows=await tx.query<{id:string}>(`update mobile_devices set revoked_at=now() where id=$1 and owner_user_id=$2 and revoked_at is null returning id`,[id,ownerUserId]);
    if(rows.length)await tx.query(`update push_deliveries set status='suppressed',lease_token=null,last_error_code='device_revoked' where device_id=$1 and owner_user_id=$2 and status in('queued','retry')`,[id,ownerUserId]);
    return !!rows.length;
  });
}

export function localMinutes(now:Date,timeZone:string):number{const parts=new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);return Number(parts.find(x=>x.type==='hour')!.value)*60+Number(parts.find(x=>x.type==='minute')!.value);}
export function quietNow(now:Date,timeZone:string,start:string|null,end:string|null):boolean{if(!start||!end||start===end)return false;const parse=(x:string)=>Number(x.slice(0,2))*60+Number(x.slice(3,5));const n=localMinutes(now,timeZone),s=parse(start),e=parse(end);return s<e?n>=s&&n<e:n>=s||n<e;}

export interface PushFetchResult{sent:number;ticketed:number;retried:number;deferred:number;suppressed:number;}
const FOREGROUND_GRACE_MS=10*60*1000;
const FOREGROUND_RECHECK_SECONDS=30;
function coalesceCategory(categories:unknown,category:string):boolean{return !categories||typeof categories!=='object'||(categories as Record<string,unknown>)[category]!==false;}
const EXPO_ERROR_CODES=new Set(['DeviceNotRegistered','MessageTooBig','MessageRateExceeded','MismatchSenderId','InvalidCredentials']);
const PERMANENT_EXPO_ERRORS=new Set(['DeviceNotRegistered','MessageTooBig','MismatchSenderId','InvalidCredentials']);
function expoErrorCode(value:unknown,fallback:string):string{return typeof value==='string'&&EXPO_ERROR_CODES.has(value)?value:fallback;}
function retryableHttpStatus(status:number):boolean{return status===408||status===425||status===429||status>=500;}
async function boundedFetch(fetchImpl:typeof fetch,url:string,init:RequestInit,timeoutMs=10_000):Promise<Response>{const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref?.();try{return await fetchImpl(url,{...init,signal:controller.signal});}finally{clearTimeout(timer);}}
function retryAfterSeconds(response:Response):number|undefined{const raw=response.headers.get('retry-after');if(!raw)return;const seconds=Number(raw);if(Number.isFinite(seconds))return Math.max(1,Math.min(3600,Math.ceil(seconds)));const at=Date.parse(raw);return Number.isNaN(at)?undefined:Math.max(1,Math.min(3600,Math.ceil((at-Date.now())/1000)));}
export async function processPushBatch(db:Db,key:MasterKey,fetchImpl:typeof fetch,now=new Date(),limit=50):Promise<PushFetchResult>{
  const lease=randomUUID();
  const rows=await db.query<any>(`update push_deliveries p set status='sending',lease_token=$3,attempts=attempts+1 from (select id from push_deliveries where ((status in ('queued','retry') and next_attempt_at<=$1) or (status='sending' and updated_at<$1-interval '10 minutes')) order by created_at for update skip locked limit $2) q where p.id=q.id returning p.*`,[now,Math.min(100,Math.max(1,limit)),lease]);
  let sent=0,ticketed=0,retried=0,deferred=0,suppressed=0;
  if(!db.transaction)throw new Error('push dispatch requires transaction support');
  for(let i=0;i<rows.length;i+=100){const group=rows.slice(i,i+100);
    await db.transaction(async tx=>{
      // Registration takes the same transaction-scoped lock. Holding it from
      // the final device/token read through the Expo HTTP boundary means an
      // account switch or app-state update either finishes before this check
      // or waits until this dispatch has been durably classified.
      await tx.query(`select pg_advisory_xact_lock(hashtext('josi_mobile_device_registration'))`);
      const deliverable=[] as any[];
      for(const p of group){const [d]=await tx.query<any>(`select * from mobile_devices where id=$1 and owner_user_id=$2 and revoked_at is null`,[p.device_id,p.owner_user_id]);const enabled=d&&coalesceCategory(d.categories,p.category);if(!d||!enabled||(!p.explicit_reminder&&quietNow(now,d.timezone,d.quiet_start,d.quiet_end))){await tx.query(`update push_deliveries set status='suppressed',lease_token=null,last_error_code=$3 where id=$1 and lease_token=$2`,[p.id,lease,!d?'device_unavailable':!enabled?'category_disabled':'quiet_hours']);suppressed++;continue;}const createdAt=new Date(p.created_at),foregroundExpired=createdAt.getTime()+FOREGROUND_GRACE_MS<=now.getTime();if(!p.explicit_reminder&&foregroundExpired&&(d.app_state==='foreground'||p.last_error_code==='foreground')){await tx.query(`update push_deliveries set status='suppressed',lease_token=null,last_error_code='foreground_expired' where id=$1 and lease_token=$2`,[p.id,lease]);suppressed++;continue;}if(p.route_type==='reminder'&&!d.owner_binding){await tx.query(`update push_deliveries set status='suppressed',lease_token=null,last_error_code='owner_binding_unavailable' where id=$1 and lease_token=$2`,[p.id,lease]);suppressed++;continue;}if(!p.explicit_reminder&&d.app_state==='foreground'){await tx.query(`update push_deliveries set status='retry',lease_token=null,attempts=greatest(0,attempts-1),next_attempt_at=least($3::timestamptz+($4*interval '1 second'),$5::timestamptz),last_error_code='foreground' where id=$1 and lease_token=$2`,[p.id,lease,now,FOREGROUND_RECHECK_SECONDS,new Date(createdAt.getTime()+FOREGROUND_GRACE_MS)]);deferred++;continue;}try{const token=openSealed<{token:string}>(key,d.expo_token_enc).token;const fenced=await tx.query(`update push_deliveries set sent_token_fingerprint=$3 where id=$1 and lease_token=$2 and exists(select 1 from mobile_devices where id=$4 and owner_user_id=$5 and revoked_at is null and token_fingerprint=$3) returning id`,[p.id,lease,d.token_fingerprint,d.id,p.owner_user_id]);if(fenced.length)deliverable.push({p,d,fingerprint:d.token_fingerprint,msg:{to:token,sound:'default',title:'Josi',body:d.privacy_locked?GENERIC_PUSH_BODY:p.body,data:{route:p.route_type,id:p.route_id,...(p.route_thread_id?{threadId:p.route_thread_id}:{}),...(p.route_type==='reminder'?{owner:d.owner_binding,revision:Number(String(p.event_key).split(':').at(-1))}:{})}}});else suppressed++;}catch{await retryPush(tx,p.id,p.attempts,'token_unavailable',lease);retried++;}}
      if(!deliverable.length)return;let response:Response;try{response=await boundedFetch(fetchImpl,'https://exp.host/--/api/v2/push/send',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','Accept-Encoding':'gzip, deflate'},body:JSON.stringify(deliverable.map(x=>x.msg))});sent+=deliverable.length;}catch{for(const {p} of deliverable){await retryPush(tx,p.id,p.attempts,'network',lease);retried++;}return;}if(retryableHttpStatus(response.status)){const delay=retryAfterSeconds(response);for(const {p} of deliverable){await retryPush(tx,p.id,p.attempts,`http_${response.status}`,lease,delay);retried++;}return;}if(!response.ok){for(const {p} of deliverable)await tx.query(`update push_deliveries set status='failed',lease_token=null,last_error_code=$3 where id=$1 and lease_token=$2`,[p.id,lease,`http_${response.status}`]);return;}let payload:{data?:Array<{status:string;id?:string;details?:{error?:string}}>};try{payload=await response.json() as typeof payload;}catch{for(const {p} of deliverable){await retryPush(tx,p.id,p.attempts,'invalid_response',lease);retried++;}return;}for(let j=0;j<deliverable.length;j++){const {p,d,fingerprint}=deliverable[j],t=payload.data?.[j];if(t?.status==='ok'&&t.id){await tx.query(`update push_deliveries set status='ticketed',lease_token=null,ticket_id=$3,next_attempt_at=now()+interval '15 minutes' where id=$1 and lease_token=$2`,[p.id,lease,t.id]);ticketed++;}else if(t?.details?.error==='DeviceNotRegistered'){await tx.query(`update mobile_devices set revoked_at=now() where id=$1 and token_fingerprint=$2`,[d.id,fingerprint]);await tx.query(`update push_deliveries set status='failed',lease_token=null,last_error_code='DeviceNotRegistered' where id=$1 and lease_token=$2`,[p.id,lease]);}else{const code=expoErrorCode(t?.details?.error,'ticket_error');if(PERMANENT_EXPO_ERRORS.has(code))await tx.query(`update push_deliveries set status='failed',lease_token=null,last_error_code=$3 where id=$1 and lease_token=$2`,[p.id,lease,code]);else{await retryPush(tx,p.id,p.attempts,code,lease);retried++;}}}
    });
  }
  return{sent,ticketed,retried,deferred,suppressed};
}
async function retryPush(db:Db,id:string,attempts:number,code:string,lease:string,delaySeconds?:number){const terminal=attempts>=5;await db.query(`update push_deliveries set status=$3,lease_token=null,next_attempt_at=now()+(coalesce($6,least(3600,power(2,$4)*15))*interval '1 second'),last_error_code=$5 where id=$1 and lease_token=$2`,[id,lease,terminal?'failed':'retry',attempts,code,delaySeconds??null]);}
async function retryReceipt(db:Db,row:any,code:string,lease:string){const terminal=row.receipt_attempts>=5;await db.query(`update push_deliveries set status=$3,lease_token=null,next_attempt_at=now()+(least(3600,power(2,$4)*30)*interval '1 second'),last_error_code=$5 where id=$1 and lease_token=$2`,[row.id,lease,terminal?'failed':'ticketed',row.receipt_attempts,code]);}
export async function processPushReceipts(db:Db,fetchImpl:typeof fetch,limit=100){const lease=randomUUID();const rows=await db.query<any>(`update push_deliveries p set status='checking',lease_token=$2,receipt_attempts=receipt_attempts+1 from (select id from push_deliveries where (status='ticketed' and next_attempt_at<=now()) or (status='checking' and updated_at<now()-interval '10 minutes') order by created_at for update skip locked limit $1) q where p.id=q.id returning p.*`,[Math.min(100,Math.max(1,limit)),lease]);if(!rows.length)return{checked:0,providerAccepted:0};let response:Response;try{response=await boundedFetch(fetchImpl,'https://exp.host/--/api/v2/push/getReceipts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:rows.map(r=>r.ticket_id)})});}catch{for(const row of rows)await retryReceipt(db,row,'receipt_network',lease);return{checked:rows.length,providerAccepted:0};}if(!response.ok){for(const row of rows){if(retryableHttpStatus(response.status))await retryReceipt(db,row,`receipt_http_${response.status}`,lease);else await db.query(`update push_deliveries set status='failed',lease_token=null,last_error_code=$3 where id=$1 and lease_token=$2`,[row.id,lease,`receipt_http_${response.status}`]);}return{checked:rows.length,providerAccepted:0};}let data:any;try{data=((await response.json()) as any).data??{};}catch{for(const row of rows)await retryReceipt(db,row,'invalid_receipt_response',lease);return{checked:rows.length,providerAccepted:0};}let providerAccepted=0;for(const row of rows){const receipt=data[row.ticket_id];if(!receipt){await retryReceipt(db,row,'receipt_pending',lease);continue;}if(receipt.status==='ok'){const changed=await db.query(`update push_deliveries set status='provider_accepted',lease_token=null,receipt_checked_at=now() where id=$1 and lease_token=$2 returning id`,[row.id,lease]);if(changed.length)providerAccepted++;}else if(receipt.details?.error==='DeviceNotRegistered'){await db.query(`update mobile_devices set revoked_at=now() where id=$1 and token_fingerprint=$2`,[row.device_id,row.sent_token_fingerprint]);await db.query(`update push_deliveries set status='failed',lease_token=null,last_error_code='DeviceNotRegistered',receipt_checked_at=now() where id=$1 and lease_token=$2`,[row.id,lease]);}else{const code=expoErrorCode(receipt.details?.error,'receipt_error');if(code==='MessageRateExceeded')await retryPush(db,row.id,row.attempts,code,lease);else await db.query(`update push_deliveries set status='failed',lease_token=null,last_error_code=$3,receipt_checked_at=now() where id=$1 and lease_token=$2`,[row.id,lease,code]);}}return{checked:rows.length,providerAccepted};}
