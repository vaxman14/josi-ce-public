// What the worker actually does with a claimed job.
//
// Kept separate from `main.ts` so it can be tested without starting a process,
// a pool, or a timer — the engine's equivalent was only ever exercised through
// the running worker, which meant its failure paths were not exercised at all.
//
// Phase 5 ships the machinery, not the executors. `task.wake` therefore has
// nothing to attempt for work that needs a calendar or a mailbox, and says so
// by leaving the task alone rather than failing it. A task marked failed
// because Phase 7 has not happened yet would read, to the person waiting on it,
// exactly like Josi tried and could not.
import {
  addMessage, approvalHash, claimJobs, claimReadyTask, completeJob, consumeApproval, enqueue,
  expireApprovals, expireHolds, failJob, getTask, tickSchedules,
  claimDurableTurn, completeDurableTurn, durableTurnHasEffects, durableTurnHasIncompleteEffects, failDurableTurn, renewDurableTurnLease, renewJobLease, processPushBatch, processPushReceipts, deliverReminderPersisted, json,
  expirePreparedActionApprovals, settleActionForTask, transition, type Db, type Job, type MasterKey,
} from '@josi-ce/core';
import {
  accessTokenFor, can, connectionsWithCapability, createInternalEvent, dueCalendarOrigins, dueCloudMappings, dueOrigins, expireCustomApiCalls,
  ensureInternalCalendar, loadClient, markAttempted, markCalendarAttempted, markSyncScheduled, provisionCalendarOrigins,
  processCalendarOutbox, syncCalendarOrigin, syncCloudMapping, syncOrigin, updateInternalEvent,
} from '@josi-ce/connectors';

// Write-action tasks (send a message, schedule an appointment, add a contact)
// only ever meant Google and Microsoft — Dropbox, Box and Nextcloud are
// storage-only providers with no mailbox, calendar or address book to write
// to. Narrower than the connectors package's own `Provider` on purpose, the
// same choice packages/agent/src/dataTools.ts makes for the same reason.
type WriteProvider = 'google' | 'microsoft';
import {
  TelegramBotApi, listLinksFor, loadConfig, openToken, prepareOutbound, sendChunk,
} from '@josi-ce/channels';
import { mailPolicy, renderedEmailMime, verifyFrozenEmail } from '@josi-ce/mail';
import { effectiveTimeContext, formatCalendarRange, runAssistantTurn } from '@josi-ce/agent';
import { IMAGE_MEDIA_TYPES, readAttachment } from '@josi-ce/storage';
import { capabilitiesOf, loadStoredProvider } from '@josi-ce/llm';
import { extname } from 'node:path';

/** What the worker needs beyond the database.
 *
 * Optional, and absent in most of the suite: a job kind that needs the master
 * key says so by failing, which is visible, rather than by quietly doing
 * nothing. */
export interface WorkerContext {
  masterKey?: MasterKey | null;
  /** Injected by the tests so no suite contacts a provider. */
  connectorFetch?: typeof fetch;
  /** Injected by the tests so no suite contacts api.telegram.org. */
  telegramFetch?: typeof fetch;
  llmFetch?: typeof fetch;
  llmResolve?: (hostname:string)=>Promise<string[]>;
  customApiFetch?: typeof fetch;
  outboundResolve?: (hostname:string)=>Promise<string[]>;
  /** Explicit seam: suites omit it, so tests can never contact Expo. */
  pushFetch?: typeof fetch;
  workerId?: string;
}

export interface JobOutcome {
  claimed: number;
  done: number;
  failed: number;
}

const DURABLE_CALENDAR_CONTINUITY_TOOLS = new Set(['query_calendar', 'get_event', 'draft_calendar_event']);
function durableHistoryContent(message: { direction: 'in' | 'out'; body: string; meta: Record<string, unknown> }): string {
  if (message.direction !== 'out' || !Array.isArray(message.meta?.calendar_receipts) || !message.meta.calendar_receipts.length) return message.body;
  return `${message.body}\n\n[Verified calendar receipts from this prior turn. Preserve the named event, event_id, source_id, account, and calendar in follow-up actions; do not transfer a requested edit to another event.]\n${JSON.stringify(message.meta.calendar_receipts).slice(0, 12_000)}`;
}

/** Job kinds this worker understands. An unknown kind fails the job rather
 * than silently completing it: a job nobody handles is a bug, and marking it
 * done would hide it forever. */
export async function runJob(db: Db, job: Job, ctx: WorkerContext = {}): Promise<void> {
  switch (job.kind) {
    case 'assistant.turn': {
      const turnId=String((job.payload as {turnId?:unknown}).turnId??'');
      if(!turnId)throw new Error('assistant.turn without a turnId');
      if(!ctx.masterKey)throw new Error('assistant.turn needs the installation master key');
      const turn=await claimDurableTurn(db,turnId);
      // A later turn waits until the thread's earlier turn settles. Completed
      // and failed turns make a duplicate queue row harmless.
      if(!turn){const [state]=await db.query<{status:string}>(`select status from assistant_turns where id=$1`,[turnId]);if(state?.status==='queued')throw new Error('assistant thread has an earlier turn');return;}
      const leaseHeartbeat=setInterval(()=>{void renewDurableTurnLease(db,{turnId,leaseToken:turn.lease_token}).then(ok=>ok&&ctx.workerId?renewJobLease(db,job.id,ctx.workerId):ok).catch(()=>undefined);},60_000);
      leaseHeartbeat.unref?.();
      try{
        const [inbound]=await db.query<{id:string;body:string;created_at:string}>(`select id,body,created_at from messages where id=$1 and thread_id=$2 and direction='in'`,[turn.inbound_message_id,turn.thread_id]);
        if(!inbound)throw new Error('durable inbound message is unavailable');
        const preceding=await db.query<{direction:'in'|'out';body:string;meta:Record<string,unknown>}>(`select direction,body,meta from messages where thread_id=$1 and id<>$2 and created_at<=$3 order by created_at desc,id desc limit 40`,[turn.thread_id,inbound.id,inbound.created_at]);
        const history=preceding.reverse().map(m=>({role:m.direction==='in'?('user' as const):('assistant' as const),content:durableHistoryContent(m)}));
        const attachments=turn.attachment_ids.length?await db.query<{id:string;filename:string;extracted_text:string|null;analysis_status:string;analysis_code:string|null}>(`select id,filename,extracted_text,analysis_status,analysis_code from chat_attachments where id=any($1::uuid[]) and owner_user_id=$2 and thread_id=$3 and storage_state='ready' order by id`,[turn.attachment_ids,turn.owner_user_id,turn.thread_id]):[];
        const mediaType=(name:string)=>IMAGE_MEDIA_TYPES[extname(name).replace(/^\./,'').toLowerCase()];
        const textAttachments=attachments.filter(a=>!mediaType(a.filename));
        const context=textAttachments.map(a=>a.extracted_text?`Attached file ${a.filename}:\n${a.extracted_text}`:a.analysis_status==='unavailable'?`Attached file ${a.filename}; analysis unavailable (${a.analysis_code??'analysis_unavailable'}).`:`Attached file ${a.filename}; no readable text was extracted.`).join('\n\n');
        const provider=await loadStoredProvider(db,'primary');
        const images=capabilitiesOf(provider)?.vision===true?await Promise.all(attachments.filter(a=>mediaType(a.filename)).map(async a=>({mediaType:mediaType(a.filename),base64:(await readAttachment(a.id)).toString('base64')}))):undefined;
        const result=await runAssistantTurn({db,registry:{db,masterKey:ctx.masterKey,fetchImpl:ctx.llmFetch,resolve:ctx.llmResolve},userId:turn.owner_user_id,threadId:turn.thread_id,history,inbound:[inbound.body,context].filter(Boolean).join('\n\n'),inboundMessageId:inbound.id,durableTurnId:turn.id,durableLeaseToken:turn.lease_token,replyToMessageId:turn.reply_to_message_id,requireApprovalReplyTarget:true,images,connectorFetch:ctx.connectorFetch,customApiFetch:ctx.customApiFetch,outboundResolve:ctx.outboundResolve,channel:'native',sessionKey:turn.accepted_session_id});
        if(await durableTurnHasIncompleteEffects(db,turnId)){await failDurableTurn(db,{turnId,leaseToken:turn.lease_token,code:'effect_outcome_unknown',retryable:false});return;}
        if(result.mediaRequest)await db.query(`update messages set meta=meta||$2 where id=$1 and thread_id=$3`,[inbound.id,json({media_request:result.mediaRequest}),turn.thread_id]);
        if(result.refusal){const crossed=await durableTurnHasEffects(db,turnId);await failDurableTurn(db,{turnId,leaseToken:turn.lease_token,code:crossed?'effect_then_provider_error':result.refusal.reason,retryable:!crossed&&result.refusal.retryable===true});return;}
        const approvalNeeded=result.actions.some(a=>a.result&&typeof a.result==='object'&&String((a.result as any).state)==='prepared');
        const taskIds=result.actions.map(a=>a.result).filter((v):v is {state:string;task_id:string}=>!!v&&typeof v==='object'&&['collecting','prepared'].includes(String((v as any).state))&&typeof (v as any).task_id==='string').map(v=>v.task_id);
        const calendarReceipts=result.actions.filter(a=>DURABLE_CALENDAR_CONTINUITY_TOOLS.has(a.tool)).slice(-6);
        const replyMeta:Record<string,unknown>={};
        const nativeApproval=result.actions.map(a=>a.result).find((value):value is {state:string;approval_id:string;summary:string;action?:string;action_class?:string;expires_at?:string|null}=>
          !!value&&typeof value==='object'&&String((value as any).state)==='prepared'&&typeof (value as any).approval_id==='string'&&typeof (value as any).summary==='string');
        if(nativeApproval)replyMeta.nativeApproval={approvalId:nativeApproval.approval_id,summary:nativeApproval.summary,action:nativeApproval.action??'approve',actionClass:nativeApproval.action_class??'',expiresAt:nativeApproval.expires_at??null,requiresDeviceAuth:true,status:'pending'};
        if(calendarReceipts.length)replyMeta.calendar_receipts=calendarReceipts;
        const actionStatusDomain=result.actions.find(a=>a.tool==='assistant_action_state'&&a.result&&typeof a.result==='object')?.result as {domain?:unknown}|undefined;
        if(actionStatusDomain?.domain==='email'||actionStatusDomain?.domain==='calendar')replyMeta.action_status_domain=actionStatusDomain.domain;
        if(result.retry)replyMeta.retry=result.retry;
        if(result.mediaResult)replyMeta.media_result=result.mediaResult;
        await completeDurableTurn(db,{turnId,leaseToken:turn.lease_token,reply:result.reply,toolReceipts:result.actions,replyMeta,approvalNeeded,presentedTaskIds:taskIds});
      }catch{const crossed=await durableTurnHasEffects(db,turnId);await failDurableTurn(db,{turnId,leaseToken:turn.lease_token,code:crossed?'effect_outcome_unknown':'turn_execution_failed',retryable:!crossed});}
      finally{clearInterval(leaseHeartbeat);}
      return;
    }

    case 'task.wake': {
      const taskId = String((job.payload as { taskId?: unknown }).taskId ?? '');
      if (!taskId) throw new Error('task.wake without a taskId');
      // Throws if the task is gone, which retries and then goes dead — visible,
      // rather than a wake that quietly did nothing.
      const pending = await getTask(db, taskId);
      if (pending.state !== 'ready') return;
      const [preparedAction]=await db.query<{approval_id:string|null;authorization_kind:'approval'|'user_policy';payload_hash:string|null}>(`select approval_id,authorization_kind,payload_hash from assistant_action_states where task_id=$1`,[pending.id]);
      // Legacy ready tasks still wait for a capability. A conversational action
      // was explicitly approved, so a withdrawn/unavailable provider must
      // settle it as an authoritative domain failure rather than leave it
      // looking queued forever.
      if (!preparedAction && ['send_message', 'schedule_appointment', 'update_contact'].includes(pending.template_key)
          && !(await taskWriteEnabled(db, pending))) return;
      if (!ctx.masterKey) throw new Error('task.wake needs the installation master key');
      // Compare-and-set is the exactly-once local claim. Duplicate queue rows,
      // retries, and concurrent workers can observe ready, but only one changes
      // it to attempting and reaches the provider.
      const task=await claimReadyTask(db,taskId);
      if(!task)return;
      try {
        if (task.slots.rendered_email && !preparedAction) throw new Error('Template email requires an exact prepared approval.');
        if(preparedAction){
          if(preparedAction.authorization_kind==='approval'){
            if(!preparedAction.approval_id)throw new Error('The prepared action has no approval.');
            const approval=await consumeApproval(db,{approvalId:preparedAction.approval_id,payload:task.slots});
            if(!approval.ok){
              if(approval.reason==='expired')await db.query(`update assistant_action_states set status='expired' where task_id=$1 and status='approved'`,[task.id]);
              throw new Error(`The prepared action approval is not usable (${approval.reason}).`);
            }
          }else if(preparedAction.authorization_kind!=='user_policy'){
            throw new Error('The prepared action has no valid authorization.');
          }else if(preparedAction.payload_hash!==approvalHash(task.slots)){
            throw new Error('The user-policy-authorized action payload changed after authorization.');
          }
          await db.query(`update assistant_action_states set status='executing' where task_id=$1 and status='approved'`,[task.id]);
        }
        await executeWriteTask(db, task, ctx);
        await transition(db, task.id, 'confirmed', { actor: 'system' });
        await settleActionForTask(db,task.id,'succeeded');
        await reportCalendarTaskOutcome(db,task,true).catch(()=>undefined);
      } catch (err) {
        await transition(db, task.id, 'failed', { actor: 'system', reason: safeTaskError(err) });
        await settleActionForTask(db,task.id,'failed');
        await reportCalendarTaskOutcome(db,task,false,err).catch(()=>undefined);
      }
      return;
    }

    case 'holds.expire': {
      await expireHolds(db);
      return;
    }

    case 'approvals.expire': {
      await expirePreparedActionApprovals(db);
      await expireApprovals(db);
      await expireCustomApiCalls(db);
      return;
    }

    // ---------------------------------------------------- contact sync
    //
    // Two kinds, and the split is deliberate. `contacts.sync_due` FANS OUT: it
    // finds origins whose own interval has elapsed and enqueues one job each,
    // syncing nothing itself. So one slow or rate-limited provider delays its
    // own account and nobody else's, and a worker that dies mid-run costs one
    // origin its turn rather than everybody's.
    case 'contacts.sync_due': {
      const due = await dueOrigins(db);
      for (const origin of due) {
        // Stamped BEFORE the job runs. A crash must not leave the origin
        // looking never-attempted, or the next tick picks it straight back up
        // and the crash repeats as fast as the worker can loop.
        await markAttempted(db, origin.id);
        await enqueue(db, { kind: 'contacts.sync', payload: { originId: origin.id } });
      }
      return;
    }

    case 'contacts.sync': {
      const originId = String((job.payload as { originId?: unknown }).originId ?? '');
      if (!originId) throw new Error('contacts.sync without an originId');
      if (!ctx.masterKey) {
        // The tokens are sealed with it. Failing is honest; skipping would
        // leave an origin that never syncs and never says why.
        throw new Error('contacts.sync needs the installation master key');
      }
      // `syncOrigin` resolves the owner from the ORIGIN, never from this
      // payload, so a forged job id cannot reach another person's contacts —
      // it can only sync an origin that already exists, for its own owner.
      //
      // It returns rather than throws for anything the operator can act on: a
      // revoked connection or a removed scope is a status on the origin, not a
      // dead job nobody sees.
      await syncOrigin(db, originId, {
        masterKey: ctx.masterKey,
        fetchImpl: ctx.connectorFetch,
      });
      return;
    }

    case 'calendar.sync_due': {
      await provisionCalendarOrigins(db);
      for (const origin of await dueCalendarOrigins(db)) {
        await markCalendarAttempted(db, origin.id);
        await enqueue(db, { kind: 'calendar.sync', payload: { originId: origin.id } });
      }
      return;
    }

    case 'calendar.sync': {
      const originId = String((job.payload as { originId?: unknown }).originId ?? '');
      if (!originId) throw new Error('calendar.sync without an originId');
      if (!ctx.masterKey) throw new Error('calendar.sync needs the installation master key');
      await syncCalendarOrigin(db, originId, { masterKey: ctx.masterKey, fetchImpl: ctx.connectorFetch });
      return;
    }

    case 'calendar.outbox_due': {
      if (!ctx.masterKey) throw new Error('calendar.outbox_due needs the installation master key');
      await processCalendarOutbox(db, { masterKey: ctx.masterKey, fetchImpl: ctx.connectorFetch });
      return;
    }

    // ---------------------------------------------------- cloud storage sync
    //
    // The same fan-out split as contact sync, for the same reasons: one due
    // schedule enqueues one job per due mapping, so one slow provider delays
    // its own folder and nobody else's.
    case 'storage.sync_due': {
      const due = await dueCloudMappings(db);
      for (const mapping of due) {
        // Stamped BEFORE the job runs — a crash mid-sync must cost this
        // mapping its turn, not repeat as fast as the worker can loop.
        await markSyncScheduled(db, mapping.id);
        await enqueue(db, { kind: 'storage.sync', payload: { mappingId: mapping.id } });
      }
      return;
    }

    case 'storage.sync': {
      const mappingId = String((job.payload as { mappingId?: unknown }).mappingId ?? '');
      if (!mappingId) throw new Error('storage.sync without a mappingId');
      if (!ctx.masterKey) {
        throw new Error('storage.sync needs the installation master key');
      }
      // `syncCloudMapping` resolves the owner from the MAPPING, never from
      // this payload — a forged job id can only sync a folder that already
      // exists, for its own owner, through its owner's own connection. It
      // returns rather than throws for anything the owner can act on — which
      // used to mean this job handler's own success/fail counter (the
      // "N done, 0 failed" line the process log prints) could not tell the
      // difference between a mapping that synced and one that failed and got
      // paused. Both looked identical: the call resolved, the handler
      // returned, the job was marked done. A failed result is still not
      // rethrown — doing so would turn an owner-actionable state (expired
      // token, missing scope) into a retried job the queue keeps re-running —
      // but it is now logged, so a failing sync is visible in the same place a
      // throwing one always was.
      const result = await syncCloudMapping(db, mappingId, {
        masterKey: ctx.masterKey,
        fetchImpl: ctx.connectorFetch,
      });
      if (result.status === 'failed') {
        console.error(
          `[storage.sync] mapping ${mappingId} did not sync: category=${result.errorCategory}`,
        );
      }
      return;
    }

    case 'reminder.deliver': {
      const reminderId = String((job.payload as { reminderId?: unknown }).reminderId ?? '');
      const revision = Number((job.payload as { revision?: unknown }).revision);
      if (!reminderId || !Number.isSafeInteger(revision) || revision < 1) throw new Error('reminder.deliver without a valid reminder revision');
      await deliverReminder(db, reminderId, revision, ctx);
      return;
    }

    default:
      throw new Error(`no handler for job kind ${job.kind}`);
  }
}

type WritableTask = Awaited<ReturnType<typeof getTask>>;

function textSlot(task: WritableTask, key: string): string { return String(task.slots[key] ?? '').trim(); }
function listSlot(task: WritableTask, key: string): string[] {
  const value = task.slots[key]; return Array.isArray(value) ? value.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 20) : [];
}

function mailAddress(value: string): string {
  const clean = value.replace(/[\r\n]/g, '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error('A valid email address is required.');
  return clean;
}

function mailHeader(value: string): string { return value.replace(/[\r\n]+/g, ' ').trim(); }

function googlePersonPath(value: string): string {
  if (!/^people\/[A-Za-z0-9._-]+$/.test(value)) throw new Error('That Google contact identifier is not valid.');
  return value;
}

export function calendarEventUrl(provider: WriteProvider, calendarId: string, eventId = ''): string {
  const encodedCalendar = encodeURIComponent(calendarId);
  const encodedEvent = eventId ? `/${encodeURIComponent(eventId)}` : '';
  return provider === 'google'
    ? `https://www.googleapis.com/calendar/v3/calendars/${encodedCalendar}/events${encodedEvent}`
    : `https://graph.microsoft.com/v1.0/me/calendars/${encodedCalendar}/events${encodedEvent}`;
}

async function taskWriteEnabled(db: Db, task: WritableTask): Promise<boolean> {
  const family = task.template_key === 'send_message' ? 'mail' : task.template_key === 'schedule_appointment' ? 'calendar' : 'contacts';
  const keys: Record<string, Record<WriteProvider, string>> = {
    mail: { google: 'google.mail.send', microsoft: 'microsoft.mail.send' },
    calendar: { google: 'google.calendar.write', microsoft: 'microsoft.calendar.write' },
    contacts: { google: 'google.contacts.write', microsoft: 'microsoft.contacts.write' },
  };
  for (const provider of ['google', 'microsoft'] as WriteProvider[]) {
    if ((await can(db, { ownerUserId: task.owner_user_id, capability: keys[family][provider] })).allowed) return true;
  }
  return false;
}

async function writeSession(db: Db, task: WritableTask, family: 'mail' | 'calendar' | 'contacts', ctx: WorkerContext,
  requested?: { provider?: unknown; account_id?: unknown }) {
  const keys: Record<typeof family, Record<WriteProvider, string>> = {
    mail: { google: 'google.mail.send', microsoft: 'microsoft.mail.send' },
    calendar: { google: 'google.calendar.write', microsoft: 'microsoft.calendar.write' },
    contacts: { google: 'google.contacts.write', microsoft: 'microsoft.contacts.write' },
  };
  for (const provider of ['google', 'microsoft'] as WriteProvider[]) {
    if (requested?.provider !== undefined && requested.provider !== provider) continue;
    if (!(await can(db, { ownerUserId: task.owner_user_id, capability: keys[family][provider] })).allowed) continue;
    const connections = await connectionsWithCapability(db, { ownerUserId: task.owner_user_id, capability: keys[family][provider] });
    const connection = requested?.account_id === undefined
      ? connections[0]
      : connections.find((candidate) => candidate.id === requested.account_id);
    if (!connection) continue;
    const client = await loadClient(db, ctx.masterKey!, provider);
    const accessToken = await accessTokenFor(db, ctx.masterKey!, { connection, client }, { fetchImpl: ctx.connectorFetch });
    return { provider, accessToken };
  }
  throw new Error(`Enable ${family} write access on the Connections page first.`);
}

async function providerFetch(ctx: WorkerContext, url: string, accessToken: string, init: RequestInit) {
  const response = await (ctx.connectorFetch ?? fetch)(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`The connected provider refused the write (${response.status}).`);
}

async function executeWriteTask(db: Db, task: WritableTask, ctx: WorkerContext): Promise<void> {
  if (task.template_key === 'send_message') {
    const session = await writeSession(db, task, 'mail', ctx); const to = mailAddress(textSlot(task, 'recipient')); const cc = listSlot(task, 'cc').map(mailAddress);
    if (task.slots.rendered_email) {
      const frozen = verifyFrozenEmail(task.slots.rendered_email);
      if (frozen.values.recipient !== to || task.slots.subject !== frozen.subject || task.slots.body !== frozen.text) throw new Error('The approved email fields do not match.');
      const raw = renderedEmailMime(frozen, to, cc);
      if (session.provider === 'google') {
        await providerFetch(ctx, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', session.accessToken,
          {method:'POST',body:JSON.stringify({raw:Buffer.from(raw).toString('base64url')})});
      } else {
        await providerFetch(ctx, 'https://graph.microsoft.com/v1.0/me/sendMail', session.accessToken,
          {method:'POST',headers:{'Content-Type':'text/plain'},body:Buffer.from(raw).toString('base64')});
      }
      return;
    }
    if (task.slots.template_id || task.slots.template_name) throw new Error('Template email must have an approved rendered snapshot.');
    const bodyText = textSlot(task, 'body') || textSlot(task, 'body_brief');
    if (session.provider === 'google') {
      const raw = [`To: ${to}`, ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []), `Subject: ${mailHeader(textSlot(task, 'subject'))}`, 'Content-Type: text/plain; charset=utf-8', '', bodyText].join('\r\n');
      await providerFetch(ctx, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', session.accessToken,
        { method: 'POST', body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }) });
    } else await providerFetch(ctx, 'https://graph.microsoft.com/v1.0/me/sendMail', session.accessToken,
      { method: 'POST', body: JSON.stringify({ message: { subject: textSlot(task, 'subject'), body: { contentType: 'Text', content: bodyText },
        toRecipients: [{ emailAddress: { address: to } }], ccRecipients: cc.map((address) => ({ emailAddress: { address } })) } }) });
    return;
  }
  if (task.template_key === 'schedule_appointment') {
    const source = task.slots.calendar_source && typeof task.slots.calendar_source === 'object'
      ? task.slots.calendar_source as { provider?: unknown; account_id?: unknown; calendar_id?: unknown }
      : undefined;
    if (!source || typeof source.calendar_id !== 'string' || !source.calendar_id) {
      throw new Error('The approved task has no exact calendar source. Draft it again and choose a calendar.');
    }
    const provider = source.provider === 'google' || source.provider === 'microsoft' ? source.provider : null;
    if (!provider) throw new Error('The approved task has an invalid calendar provider.');
    const connections = await connectionsWithCapability(db, { ownerUserId: task.owner_user_id, capability: `${provider}.calendar.write` });
    const connection = connections.find((candidate) => candidate.id === source.account_id);
    if (!connection) throw new Error('The selected calendar account is unavailable or permission was lost.');
    const event = { title: textSlot(task, 'title'), description: textSlot(task, 'description'), location: textSlot(task, 'location'),
      start: textSlot(task, 'start'), end: textSlot(task, 'end'), attendees: listSlot(task, 'attendees') };
    const eventId = textSlot(task, 'event_id');
    if (eventId && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(eventId)) {
      await updateInternalEvent(db, { ownerUserId: task.owner_user_id, eventId, changes: event });
    } else {
      const origin = await ensureInternalCalendar(db, { ownerUserId: task.owner_user_id, connectionId: connection.id, provider, providerCalendarId: source.calendar_id });
      await createInternalEvent(db, { ownerUserId: task.owner_user_id, originId: origin.id, event });
    }
    return;
  }
  if (task.template_key === 'update_contact') {
    const session = await writeSession(db, task, 'contacts', ctx); const contactId = textSlot(task, 'contact_id');
    const url = session.provider === 'google'
      ? contactId ? `https://people.googleapis.com/v1/${googlePersonPath(contactId)}:updateContact?updatePersonFields=names,emailAddresses,phoneNumbers,biographies` : 'https://people.googleapis.com/v1/people:createContact'
      : `https://graph.microsoft.com/v1.0/me/contacts${contactId ? `/${encodeURIComponent(contactId)}` : ''}`;
    const body = session.provider === 'google'
      ? { names: [{ displayName: textSlot(task, 'name') }], emailAddresses: textSlot(task, 'email') ? [{ value: textSlot(task, 'email') }] : [], phoneNumbers: textSlot(task, 'phone') ? [{ value: textSlot(task, 'phone') }] : [], biographies: textSlot(task, 'notes') ? [{ value: textSlot(task, 'notes') }] : [] }
      : { displayName: textSlot(task, 'name'), emailAddresses: textSlot(task, 'email') ? [{ address: textSlot(task, 'email'), name: textSlot(task, 'name') }] : [], businessPhones: textSlot(task, 'phone') ? [textSlot(task, 'phone')] : [], personalNotes: textSlot(task, 'notes') };
    await providerFetch(ctx, url, session.accessToken, { method: contactId ? 'PATCH' : 'POST', body: JSON.stringify(body) }); return;
  }
  throw new Error('No executor exists for this task type.');
}

function safeTaskError(err: unknown): string {
  const message = err instanceof Error ? err.message : 'The action failed.';
  return message.slice(0, 300);
}

async function reportCalendarTaskOutcome(db:Db,task:WritableTask,succeeded:boolean,error?:unknown):Promise<void>{
  if(task.template_key!=='schedule_appointment'||!task.thread_id)return;
  const source=task.slots.calendar_source&&typeof task.slots.calendar_source==='object'
    ? task.slots.calendar_source as {calendar_name?:unknown;calendar_id?:unknown}:{};
  const calendar=typeof source.calendar_name==='string'&&source.calendar_name.trim()
    ? source.calendar_name.trim()
    : typeof source.calendar_id==='string'&&source.calendar_id.trim()?source.calendar_id.trim():'the selected calendar';
  const title=textSlot(task,'title')||'Untitled event';
  const {locale,timeZone}=await effectiveTimeContext(db,task.owner_user_id);
  const body=succeeded
    ? `Saved “${title}” in Josi for ${calendar}.\n${formatCalendarRange(task.slots.start,task.slots.end,{locale,timeZone})}\nIt is queued to sync with the connected calendar.`
    : `The calendar action could not be completed. ${safeTaskError(error)}`;
  await addMessage(db,{threadId:task.thread_id,direction:'out',body,meta:{action_status_domain:'calendar',task_result:{taskId:task.id,status:succeeded?'succeeded':'failed'}}});
}

/** Deliver one due reminder. Chat persistence and native push outbox creation
 * share one database statement; Telegram remains best-effort after that
 * authoritative local delivery. */
async function deliverReminder(db: Db, reminderId: string, revision: number, ctx: WorkerContext): Promise<void> {
  const [pending]=await db.query<{body:string}>(`select body from reminders where id=$1 and revision=$2 and status='scheduled' and due_at<=now()`,[reminderId,revision]);
  if(!pending)return;
  const text=`Reminder: ${pending.body}`;
  const calendarReminder=text.includes('\nCalendar source:');
  const reminder=await deliverReminderPersisted(db,{reminderId,revision,text,category:calendarReminder?'calendar':'reminder',pushBody:calendarReminder?text.split('\nCalendar source:')[0]:text});
  if(!reminder)return;

  await deliverReminderToTelegram(db, reminder.owner_user_id, text, ctx).catch(() => {
    // sendChunk already records the failed attempt and its category; a dead
    // chat has already revoked its own link. Nothing useful is left to do.
  });
}

async function deliverReminderToTelegram(
  db: Db,
  userId: string,
  text: string,
  ctx: WorkerContext,
): Promise<void> {
  if (!ctx.masterKey) return;   // the token is sealed with it; without it there is no channel
  const config = await loadConfig(db);
  if (!config?.enabled || !config.bot_token_enc) return;

  const links = (await listLinksFor(db, userId)).filter((l) => l.status === 'active');
  if (!links.length) return;

  const api = new TelegramBotApi({
    token: openToken(ctx.masterKey, config),
    fetchImpl: ctx.telegramFetch,
  });
  const policy = await mailPolicy(db);
  const chunks = prepareOutbound({ body: text, disclosure: policy.disclosure.replace('{user}', 'you') });
  for (const link of links) {
    for (const chunk of chunks) {
      await sendChunk({ db, api }, {
        chatId: Number(link.chat_id), text: chunk, userId, kind: 'notice',
      });
    }
  }
}

/** One pass: promote due schedules, then drain what is claimable. */
export async function processQueue(
  db: Db,
  workerId: string,
  limit = 5,
  ctx: WorkerContext = {},
): Promise<JobOutcome> {
  ctx={...ctx,workerId};
  await tickSchedules(db);
  const jobs = await claimJobs(db, workerId, limit);
  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await runJob(db, job, ctx);
      await completeJob(db, job.id,workerId);
      done++;
    } catch (err) {
      // Our own message, never a provider body — `last_error` is readable by
      // anything with database access, so it must not become a side channel for
      // content.
      await failJob(db, job.id, (err as Error).message,workerId);
      failed++;
    }
  }
  if(ctx.masterKey&&ctx.pushFetch){
    await processPushBatch(db,ctx.masterKey,ctx.pushFetch);
    await processPushReceipts(db,ctx.pushFetch);
  }
  return { claimed: jobs.length, done, failed };
}
