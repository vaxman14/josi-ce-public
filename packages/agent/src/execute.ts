import { EmailTemplateError, freezeEmailTemplate } from '@josi-ce/mail';
// Executing one assistant tool call, wherever it was asked for.
//
// Extracted from `assistantAgent.ts` unchanged in behaviour, because it now
// has TWO callers with the same obligations: the in-process agent loop, and
// the MCP server that exposes these same tools to a subscription CLI's own
// agent loop. One implementation means one place where ownership is checked
// and one place where "not yours" and "does not exist" stay the same sentence.
//
// The step-up gate is NOT in here, deliberately. Both callers must consult
// `checkStepUp` BEFORE calling this, each with its own session key — the gate
// is about who is holding the session, which only the caller knows. Keeping it
// at the call sites also keeps this function honest about what it is: the
// action, not the permission.
import {
  ReminderError, activeCollectingAction, attachCollectingAction, cancelReminder, createReminder, createTask, enqueue, getTemplate, getTask, listRemindersFor,
  listTasksFor, listTemplates, missingSlots, reminderTimezoneFor, setSlots, transition, updateReminder,
  authorizeActionByUserPolicy, mergeActionTask, needsApproval, prepareAction,
  type Db,
} from '@josi-ce/core';
import { citationLabel, folderSyncHealthFor, searchDocuments, type FolderSyncHealth } from '@josi-ce/storage';
import { executeWorkspaceTool, WORKSPACE_TOOLS } from './workspaceTools.js';
import { connectionsWithCapability } from '@josi-ce/connectors';
import { providerStatus } from './providerStatus.js';
import { DATA_TOOL_FAMILY, executeDataTool, selectedCalendars, writeActionCapabilities, type ConnectorAccess } from './dataTools.js';
import { executeCustomApiTool, isCustomApiTool } from './customApiTools.js';
import { executeWorkflowTool, WORKFLOW_TOOL_NAMES } from './workflowTools.js';
import { executeObsidianTool, DEVELOPER_INTEGRATION_TOOL, executeDeveloperIntegrationTool, executeDeveloperResourceTool } from './developerIntegrationTools.js';
import { resolveCalendarTimeIntent, validateAbsoluteCalendarRange, type CalendarTimeResolution } from './calendarTimeIntent.js';
import { effectiveTimeContext } from './timeContext.js';
import { formatCalendarRange } from './calendarPresentation.js';

async function actionSummary(db:Db,userId:string,domain:string,operation:string,slots:Record<string,unknown>):Promise<string>{
  if(domain==='email')return `Send email\nTo: ${String(slots.recipient)}${Array.isArray(slots.cc) && slots.cc.length ? `\nCc: ${slots.cc.join(', ')}` : ''}\nSubject: ${String(slots.subject)}\nBody: ${String(slots.body??slots.body_brief)}`;
  if(domain==='calendar'){
    const source=slots.calendar_source as {calendar_name?:unknown}|undefined;
    const {locale,timeZone}=await effectiveTimeContext(db,userId);
    return `${operation==='update'?'Update':'Create'} calendar event\nCalendar: ${String(source?.calendar_name??'Selected calendar')}\nTitle: ${String(slots.title)}\n${formatCalendarRange(slots.start,slots.end,{locale,timeZone})}`;
  }
  return `${operation==='update'?'Update':'Create'} contact\nName: ${String(slots.name)}`;
}

function addMinutesToOffsetTimestamp(start:unknown,minutes:number):string|null{
  if(typeof start!=='string')return null;
  const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(start);
  const instant=Date.parse(start);
  if(!match||!Number.isFinite(instant))return null;
  if(match[2]==='Z')return new Date(instant+minutes*60_000).toISOString().replace('.000Z','Z');
  const sign=match[2][0]==='-'?-1:1;
  const offset=sign*(Number(match[2].slice(1,3))*60+Number(match[2].slice(4,6)));
  const local=new Date(instant+minutes*60_000+offset*60_000).toISOString().slice(0,19);
  return `${local}${match[2]}`;
}

export interface ToolExecutionContext {
  /** Whose work this is. Everything created belongs to them. Never a value
   * from a request body — the HTTP caller takes it from the session, the MCP
   * server from the context file the provider wrote. */
  userId: string;
  /** The conversation the work came from, when there is one to link. */
  threadId: string | null;
  /** The inbound message that caused this tool call. It namespaces partial
   * action state to a real conversation turn rather than model history. */
  turnId?: string | null;
  /** How the connected-data tools reach sealed tokens. Absent for callers
   * that cannot open secrets; those tools then refuse honestly rather than
   * crash. The task and reminder tools never touch it. */
  connectors?: ConnectorAccess | null;
  /** Authenticated latest user turn and its clock seam. Calendar relative
   * dates are rebuilt from these server-side instead of trusting model math. */
  latestUserText?: string;
  effectiveNow?: Date;
}

export async function executeAssistantTool(
  db: Db,
  ctx: ToolExecutionContext,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { userId } = ctx;
  if (WORKSPACE_TOOLS.some(t=>t.def.name===name)) return executeWorkspaceTool(db,userId,name,input);
  if (name === 'get_provider_status') return providerStatus(db, userId);

  // Connected-data reads live in their own module; every one of them
  // re-checks the person's capability switches at this moment, not at the
  // moment the tool was offered.
  if (DATA_TOOL_FAMILY.has(name)) {
    return executeDataTool(db, { userId, access: ctx.connectors ?? null }, name, input);
  }

  // Custom APIs live in their own module for the same reason: the allowlist is
  // re-resolved at THIS moment rather than trusted from when the tool was
  // offered, and a write or a delete becomes a pending approval instead of a
  // request. Both callers of this function get that behaviour without having to
  // remember it.
  if (isCustomApiTool(name)) {
    return executeCustomApiTool(
      db,
      { userId, threadId: ctx.threadId, access: ctx.connectors ?? null },
      name,
      input,
    );
  }
  if (WORKFLOW_TOOL_NAMES.has(name)) {
    if (!ctx.connectors) return { ok: false, message: 'Native workflow credentials are unavailable.' };
    return executeWorkflowTool(db, { userId, threadId: ctx.threadId, masterKey: ctx.connectors.masterKey }, name, input);
  }
  if(name==='list_obsidian_vaults'||name==='read_obsidian_note')return executeObsidianTool(db,userId,name,input);
  if(name===DEVELOPER_INTEGRATION_TOOL)return executeDeveloperIntegrationTool(db,userId);
  if(name==='list_native_resources'){
    if(!ctx.connectors)return {ok:false,message:'Native integration credentials are unavailable.'};
    return executeDeveloperResourceTool(db,userId,input,{masterKey:ctx.connectors.masterKey,fetchImpl:ctx.connectors.fetchImpl});
  }

  switch (name) {
    case 'draft_email':
    case 'draft_calendar_event':
    case 'draft_contact_update': {
      const templateKey = name === 'draft_email' ? 'send_message' : name === 'draft_calendar_event' ? 'schedule_appointment' : 'update_contact';
      if (!ctx.threadId) return {ok:false,error:'conversation_required',message:'Prepare consequential actions inside a conversation.'};
      const domain = name === 'draft_email' ? 'email' : name === 'draft_calendar_event' ? 'calendar' : 'contacts';
      const operation = name === 'draft_email' ? 'send' : (input.event_id ? 'update' : 'create');
      let action = await activeCollectingAction(db,{ownerUserId:userId,threadId:ctx.threadId,domain,operation,sourceTurnId:ctx.turnId});
      let task = action ? await getTask(db,action.task_id) : null;
      let draftSlots = Object.fromEntries(Object.entries(input).filter(([,value])=>value!==undefined));
      const requestedDuration=input.duration_minutes;
      if(name==='draft_calendar_event'&&requestedDuration!==undefined
        &&(typeof requestedDuration!=='number'||!Number.isInteger(requestedDuration)||requestedDuration<1||requestedDuration>24*60)){
        return {ok:false,error:'bad_calendar_duration',message:'Event duration must be a whole number of minutes from 1 to 1440.'};
      }
      delete draftSlots.duration_minutes;
      let calendarTime: CalendarTimeResolution = {kind:'none'};
      if(name==='draft_calendar_event'){
        calendarTime=await resolveCalendarTimeIntent(db,{
          userId,latestUserText:ctx.latestUserText,effectiveNow:ctx.effectiveNow,
          existingIntent:task?.slots.calendar_time_intent,
        });
        if(calendarTime.kind==='resolved')draftSlots={...draftSlots,start:calendarTime.start,end:calendarTime.end,calendar_time_intent:calendarTime.intent};
        else if(calendarTime.kind==='incomplete'){
          delete draftSlots.start;delete draftSlots.end;
          draftSlots={...draftSlots,calendar_time_intent:calendarTime.intent};
        }
        if(calendarTime.kind==='none'&&typeof requestedDuration==='number'){
          const end=addMinutesToOffsetTimestamp(draftSlots.start??task?.slots.start,requestedDuration);
          if(end)draftSlots={...draftSlots,end};
        }
      }
      if (name === 'draft_email') {
        const allowed = new Set(['recipient', 'subject', 'body', 'cc', 'template_id', 'template_name', 'merge_values']);
        if (Object.keys(input).some(key => !allowed.has(key))) return {ok:false,message:'Unsupported email draft field. Raw HTML is not accepted.'};
        if (input.template_id !== undefined && input.template_name !== undefined) return {ok:false,message:'Supply exactly one template_id or template_name.'};
        const combined = {...task?.slots, ...draftSlots};
        if (input.template_id !== undefined) delete combined.template_name;
        if (input.template_name !== undefined) delete combined.template_id;
        if (combined.template_id !== undefined || combined.template_name !== undefined) {
          try {
            const address = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
            if (combined.recipient !== undefined && (typeof combined.recipient !== 'string' || !address.test(combined.recipient))) throw new EmailTemplateError('Enter one valid recipient address.');
            if (combined.cc !== undefined && (!Array.isArray(combined.cc) || combined.cc.length > 20 || combined.cc.some(value => typeof value !== 'string' || !address.test(value)))) throw new EmailTemplateError('CC must contain at most 20 valid email addresses.');
            const frozen = await freezeEmailTemplate(db, userId, {id:combined.template_id, name:combined.template_name}, String(combined.recipient ?? ''), combined.merge_values);
            if ((input.subject !== undefined && input.subject !== frozen.subject) || (input.body !== undefined && input.body !== frozen.text)) throw new EmailTemplateError('Subject and body come from the selected template. Edit the saved template, or draft without a template.');
            draftSlots = {...draftSlots, template_id:frozen.templateId, template_name:undefined, rendered_email:frozen, subject:frozen.subject, body:frozen.text};
          } catch (error) {
            if (error instanceof EmailTemplateError) return {ok:false,error:'email_template',message:error.message};
            throw error;
          }
        }
      }
      if(!action){
        const [prepared]=await db.query<import('@josi-ce/core').AssistantActionState>(`select * from assistant_action_states
          where owner_user_id=$1 and thread_id=$2 and domain=$3 and operation=$4 and status='prepared'
          order by created_at desc limit 1`,[userId,ctx.threadId,domain,operation]);
        if(prepared){
          const previous=await getTask(db,prepared.task_id);
          const unchanged=Object.entries(draftSlots).every(([key,value])=>JSON.stringify(previous.slots[key])===JSON.stringify(value));
          if(unchanged)return {ok:true,task_id:previous.id,state:'prepared',approval_id:prepared.approval_id,summary:await actionSummary(db,userId,domain,operation,previous.slots),message:'This exact action is already prepared and waiting for approval.'};
          await db.query(`update assistant_action_states set status='superseded' where id=$1 and status='prepared'`,[prepared.id]);
          if(prepared.approval_id)await db.query(`update approvals set status='expired' where id=$1 and status='pending'`,[prepared.approval_id]);
          if(previous.state==='awaiting_approval')await transition(db,previous.id,'cancelled',{actor:'user',actorUserId:userId});
        }
        task=await createTask(db,{ownerUserId:userId,templateKey,slots:{},threadId:ctx.threadId});
        action=await attachCollectingAction(db,{ownerUserId:userId,threadId:ctx.threadId,domain,operation,taskId:task.id,sourceTurnId:ctx.turnId});
      }
      if(name==='draft_email'&&draftSlots.body!==undefined)draftSlots.body_brief=draftSlots.body;
      if (name === 'draft_calendar_event') {
        if(calendarTime.kind==='invalid')return {ok:false,error:calendarTime.error,message:calendarTime.message};
        if (input.event_id !== undefined) {
          const receipt = await executeDataTool(db,{userId,access:ctx.connectors ?? null},'get_event',{event_id:input.event_id}) as {ok:boolean;event?:Record<string,unknown>};
          if (!receipt.ok || !receipt.event) return receipt;
          const event=receipt.event;
          if (input.source_id !== undefined && input.source_id !== event.source_id) return {ok:false,error:'source_mismatch',message:'The event belongs to a different calendar. Use its original source.'};
          draftSlots={...draftSlots,calendar_source:{source_id:event.source_id,provider:event.provider,account_id:event.account_id,account:event.account,calendar_id:event.calendar_id,calendar_name:event.calendar_name,event_id:event.event_id}};
        } else {
          const hint=String(input.calendar??'').trim().toLowerCase();
          const requestedSourceId=typeof input.source_id==='string'&&input.source_id ? input.source_id : undefined;
          const genericHint=/^(?:the )?(?:main|primary|default)(?: one| calendar)?$/.test(hint);
          const selected=await selectedCalendars(db,userId);
          let sources=selected;
          if(hint&&genericHint){
            // Generic intent is authoritative: a model-carried source id may
            // refer to a superseded pre-reconciliation task or deleted source.
            sources=selected.filter(source=>source.is_write_default);
          }else if(requestedSourceId){
            const exact=selected.filter(source=>source.id===requestedSourceId);
            sources=exact.length ? exact
              : hint ? selected.filter(source=>source.name.trim().toLowerCase()===hint)
                : selected.filter(source=>source.is_write_default);
          }else if(!hint){
            sources=selected.filter(source=>source.is_write_default);
          }else{
            sources=selected.filter(source=>source.name.trim().toLowerCase()===hint);
          }
          // `calendar_source` below is the only durable source identity for a
          // draft. Never preserve the raw model argument after resolution.
          delete draftSlots.source_id;
          if(sources.length!==1){
            task=await mergeActionTask(db,action,draftSlots,['source_id']);
            return {ok:false,error:'select_calendar',task_id:task.id,state:'collecting',
              choices:sources.map(source=>({source_id:source.id,calendar_name:source.name,write_default:source.is_write_default})),
              message:'Choose one exact writable calendar, or set a default write calendar on the Calendar page.'};
          }
          const source=sources[0];
          if(!source.writable)return {ok:false,error:'source_read_only',message:'That calendar is read-only. Choose a writable calendar.'};
          const allowed=await connectionsWithCapability(db,{ownerUserId:userId,capability:`${source.provider}.calendar.write`});
          if(!allowed.some(connection=>connection.id===source.connection_id)) return {ok:false,error:'source_unavailable',message:'That exact calendar account is unavailable or its permission was withdrawn.'};
          draftSlots={...draftSlots,calendar_source:{source_id:source.id,provider:source.provider,account_id:source.connection_id,account:source.account,calendar_id:source.provider_calendar_id,calendar_name:source.name}};
        }
        const candidateStart=draftSlots.start??task?.slots.start;
        const candidateEnd=draftSlots.end??task?.slots.end;
        const badRange=validateAbsoluteCalendarRange(candidateStart,candidateEnd);
        if(badRange)return {ok:false,error:'bad_calendar_time',message:badRange};
        if(!input.event_id&&draftSlots.calendar_source&&typeof candidateStart==='string'&&typeof candidateEnd==='string'){
          const source=draftSlots.calendar_source as {source_id:string};
          const start=String(candidateStart);const end=String(candidateEnd);
          const availability=await executeDataTool(db,{userId,access:ctx.connectors??null},'query_calendar',{source_id:source.source_id,start,end}) as {ok?:boolean;events?:Array<{event_id?:unknown;title?:unknown;start?:unknown;end?:unknown}>;message?:string};
          if(!availability.ok)return {ok:false,error:'availability_unavailable',message:availability.message??'Calendar availability could not be verified. Nothing was prepared.'};
          draftSlots={...draftSlots,calendar_intent:'create_separate_event',calendar_availability:{verified:true,conflicts:(availability.events??[]).map(event=>({event_id:event.event_id,title:event.title,start:event.start,end:event.end}))}};
        }
      }
      delete draftSlots.calendar;
      if(domain==='calendar')delete draftSlots.source_id;
      task=await mergeActionTask(db,action,draftSlots,domain==='calendar'?['source_id']:[]);
      if(calendarTime.kind==='incomplete')return {ok:true,task_id:task.id,state:'collecting',missing_slots:['end'],message:calendarTime.message};
      const template=await getTemplate(db,templateKey);
      const required = domain==='email' ? ['recipient','subject','body']
        : domain==='calendar' ? ['title','start','end','calendar_source']
        : template.contract.slots.required;
      const missing=required.filter(key=>task.slots[key]===undefined||task.slots[key]===null||task.slots[key]==='');
      if(missing.length)return {ok:true,task_id:task.id,state:'collecting',missing_slots:missing,message:`Keep this ${domain} draft and ask only for: ${missing.join(', ')}.`};
      const summary=await actionSummary(db,userId,domain,operation,task.slots);
      const actionClass=name==='draft_email'?'email_send':name==='draft_calendar_event'?'calendar_write':'contacts_write';
      if(!await needsApproval(db,{userId,actionClass,action:operation})){
        await authorizeActionByUserPolicy(db,{actionStateId:action.id,actionClass,action:operation});
        return {ok:true,task_id:task.id,state:'approved',authorization:'user_policy',summary,
          message:'Queued under your automatic approval preference. No approval request was created.'};
      }
      const prepared=await prepareAction(db,{actionState:action,task,summary,actionClass,action:operation});
      return {ok:true,task_id:task.id,state:'prepared',approval_id:prepared.approval.id,expires_at:prepared.approval.expires_at,action:operation,action_class:actionClass,summary,
        message:'Prepared but not carried out. Display the exact summary and ask for an explicit yes or no.'};
    }
    case 'list_task_types': {
      const templates = await listTemplates(db);
      const available = await writeActionCapabilities(db, userId);
      return {
        ok: true,
        types: templates.map((t) => ({
          key: t.key,
          name: t.name,
          required_slots: t.contract.slots.required,
          // Stated per type, so the model cannot claim one kind of work is
          // possible because another one was.
          can_be_carried_out: t.requiresCapability === null || available.has(t.requiresCapability),
          waiting_on: t.requiresCapability && !available.has(t.requiresCapability) ? t.requiresCapability : null,
        })),
      };
    }

    case 'create_task': {
      const templateKey = String(input.template_key ?? '');
      const template = await getTemplate(db, templateKey);
      const slots = (input.slots as Record<string, unknown>) ?? {};
      const task = await createTask(db, {
        ownerUserId: userId,
        templateKey,
        slots,
        threadId: ctx.threadId ?? undefined,
      });
      const missing = missingSlots(template.contract, task.slots);
      if (!missing.length) {
        // The person asked for it directly; that is the approval.
        await transition(db, task.id, 'ready', { actor: 'user', actorUserId: userId });
        if (template.requiresCapability === null) {
          await enqueue(db, { kind: 'task.wake', payload: { taskId: task.id } });
        }
      }
      return {
        ok: true,
        task_id: task.id,
        state: missing.length ? 'drafting' : 'ready',
        missing_slots: missing,
        // Never let "ready" be read as "done".
        will_be_carried_out: template.requiresCapability === null,
        waiting_on: template.requiresCapability,
      };
    }

    case 'update_task_slots': {
      const taskId = String(input.task_id ?? '');
      const owned = await ownTask(db, taskId, userId);
      if (!owned) return NOT_YOURS;
      const task = await setSlots(db, taskId, (input.slots as Record<string, unknown>) ?? {}, {
        actor: 'user', actorUserId: userId,
      });
      const template = await getTemplate(db, task.template_key);
      const missing = missingSlots(template.contract, task.slots);
      if (!missing.length && task.state === 'drafting') {
        await transition(db, task.id, 'ready', { actor: 'user', actorUserId: userId });
        if (template.requiresCapability === null) {
          await enqueue(db, { kind: 'task.wake', payload: { taskId: task.id } });
        }
      }
      return { ok: true, task_id: task.id, missing_slots: missing, state: missing.length ? task.state : 'ready' };
    }

    case 'approve_task': {
      const taskId = String(input.task_id ?? '');
      if (!(await ownTask(db, taskId, userId))) return NOT_YOURS;
      const t = await transition(db, taskId, 'ready', { actor: 'user', actorUserId: userId });
      await enqueue(db, { kind: 'task.wake', payload: { taskId: t.id } });
      return { ok: true, task_id: t.id, state: t.state };
    }

    case 'cancel_task': {
      const taskId = String(input.task_id ?? '');
      if (!(await ownTask(db, taskId, userId))) return NOT_YOURS;
      const t = await transition(db, taskId, 'cancelled', { actor: 'user', actorUserId: userId });
      return { ok: true, task_id: t.id, state: t.state };
    }

    case 'list_open_tasks': {
      const tasks = await listTasksFor(db, { ownerUserId: userId, limit: 20 });
      return {
        ok: true,
        tasks: tasks.map((t) => ({
          task_id: t.id, template: t.template_key, state: t.state, slots: t.slots,
          attempts: t.attempt_count,
        })),
      };
    }

    case 'schedule_reminder': {
      let message = String(input.message ?? '').trim();
      const dueAt = reminderDueAt(input);
      if (!dueAt) {
        return {
          ok: false, error: 'bad_time',
          message: 'Say when: pass in_minutes (a positive number) or due_at (an ISO 8601 time in the future).',
        };
      }
      let calendarSource: Record<string, unknown> | undefined;
      if (input.calendar_event_id !== undefined) {
        const receipt = await executeDataTool(db, {userId, access:ctx.connectors ?? null}, 'get_event', {event_id:input.calendar_event_id}) as {ok:boolean;event?:Record<string,unknown>};
        if (!receipt.ok || !receipt.event) return receipt;
        const event=receipt.event;
        calendarSource={event_id:event.event_id,source_id:event.source_id,provider:event.provider,account_id:event.account_id,account:event.account,calendar_id:event.calendar_id,calendar_name:event.calendar_name,provider_event_id:event.provider_event_id};
        // Keep provenance in durable reminder content; delivery and list_reminders
        // both preserve it, without storing provider credentials or event bodies.
        message += `\nCalendar source: ${JSON.stringify(calendarSource)}`;
      }
      let reminder;
      try {
        const timezone = await reminderTimezoneFor(db, userId, typeof input.timezone === 'string' ? input.timezone : undefined);
        reminder = await createReminder(db, {
          ownerUserId: userId, threadId: ctx.threadId, body: message, dueAt, timezone,
        });
      } catch (err) {
        // A refusal the model can relay in the person's own terms. Anything
        // else is a real fault and belongs to the caller's error path.
        if (err instanceof ReminderError) return { ok: false, error: 'bad_reminder', message: err.message };
        throw err;
      }
      return {
        ok: true,
        reminder_id: reminder.id,
        ...(calendarSource ? {calendar_source:calendarSource}:{}),
        due_at: reminder.due_at,
        timezone: reminder.timezone,
        revision: Number(reminder.revision),
        // Stated so the model does not promise more than delivery: the message
        // comes back, it is not an autonomous action.
        will_be_delivered: 'Josi will send this message back to the user at that time.',
      };
    }

    case 'search_documents': {
      const query = String(input.query ?? '').trim();
      if (!query) return { ok: false, error: 'bad_query', message: 'Say what to search for.' };
      // Owner-scoped by construction: `searchDocuments` requires the owner and
      // every query inside it is keyed on it. There is no argument the model
      // could pass that widens this beyond the person asking.
      const hits = await searchDocuments(db, { ownerUserId: userId, query, limit: 8 });
      const health = await folderSyncHealthFor(db, userId);
      const degradedNote = degradedFoldersNote(health);
      if (!hits.length) {
        const [indexed] = await db.query<{ n: number }>(
          `select count(*)::int as n
           from documents d
           join folder_mappings m on m.id = d.mapping_id
           left join sync_state s on s.mapping_id = m.id
           where d.owner_user_id = $1 and d.state = 'indexed'
             and (m.provider = 'local' or s.mapping_id is null or s.last_sync_at is not null)`,
          [userId],
        );
        return {
          ok: true,
          hits: [],
          // Two different honest sentences: "nothing matched" and "there is
          // nothing to search" send the person to different fixes. A third
          // clause, when it applies: some of what SHOULD have been searched
          // never made it in, so "nothing matched" is not the same claim as
          // "there was nothing to find" (2026-09 storage-sync diagnostic fix).
          message: [
            (indexed?.n ?? 0) > 0
              ? `No indexed document matched that. ${indexed.n} document(s) are indexed and searchable.`
              : 'No documents are indexed yet. Connect a folder on the Connections page and turn on indexing first.',
            degradedNote,
          ].filter(Boolean).join(' '),
          ...(degradedNote ? { degraded_folders: health.filter(isDegraded).map(describeFolderHealth) } : {}),
        };
      }
      return {
        ok: true,
        hits: hits.map((h) => ({
          citation: citationLabel(h),
          snippet: h.snippet,
          document_id: h.documentId,
        })),
        // Present even on a successful search with real hits: those hits are
        // real, but they are drawn only from whatever DID sync, and a person
        // who asked about "my documents" is asking about all of them, not just
        // the fraction one working connection happened to index. Silence here
        // is exactly the shape of the original bug — a confident answer built
        // from a partial, unstated subset of the truth.
        ...(degradedNote ? {
          note: degradedNote,
          degraded_folders: health.filter(isDegraded).map(describeFolderHealth),
        } : {}),
      };
    }

    case 'list_documents': {
      const limit = Math.max(1, Math.min(Number(input.limit) || 50, 100));
      const documents = await db.query<{
        id: string; filename: string; state: string; skip_reason: string | null; folder: string;
      }>(
        `select d.id, d.filename, d.state, d.skip_reason, m.display_path as folder
         from documents d join folder_mappings m on m.id = d.mapping_id
         left join sync_state s on s.mapping_id = m.id
         where d.owner_user_id = $1
           and (m.provider = 'local' or s.mapping_id is null or s.last_sync_at is not null)
         order by d.updated_at desc limit $2`,
        [userId, limit],
      );
      // The 2026-09 storage-sync diagnostic fix: `documents` on its own says
      // nothing about whether the folder behind each row is actually keeping
      // up. A folder that has never completed a sync contributes ZERO rows
      // here — it is invisible by omission, not listed as empty — so a person
      // with three connected folders and one working one would see a short,
      // plausible-looking list and have no way to know two thirds of their
      // storage was never read at all. `folder_sync_health` makes that explicit
      // instead of silent.
      const health = await folderSyncHealthFor(db, userId);
      return {
        ok: true,
        documents,
        folder_sync_health: health.map(describeFolderHealth),
        ...(degradedFoldersNote(health) ? { note: degradedFoldersNote(health) } : {}),
      };
    }

    case 'update_reminder': {
      const reminderId = String(input.reminder_id ?? '');
      const dueAt = input.due_at !== undefined || input.in_minutes !== undefined ? reminderDueAt(input) : undefined;
      if ((input.due_at !== undefined || input.in_minutes !== undefined) && !dueAt) {
        return { ok: false, error: 'bad_time', message: 'Choose a valid future due_at or positive in_minutes.' };
      }
      try {
        const timezone = input.timezone === undefined
          ? undefined
          : await reminderTimezoneFor(db, userId, typeof input.timezone === 'string' ? input.timezone : undefined);
        const reminder = await updateReminder(db, {
          ownerUserId: userId, reminderId,
          ...(input.message === undefined ? {} : { body: String(input.message) }),
          ...(dueAt ? { dueAt } : {}),
          ...(timezone ? { timezone } : {}),
        });
        if (!reminder) return { ok: false, error: 'not_found', message: 'There is no scheduled reminder with that id.' };
        return { ok: true, reminder_id: reminder.id, status: reminder.status, due_at: reminder.due_at,
          timezone: reminder.timezone, revision: Number(reminder.revision) };
      } catch (err) {
        if (err instanceof ReminderError) return { ok: false, error: 'bad_reminder', message: err.message };
        throw err;
      }
    }

    case 'list_reminders': {
      const reminders = await listRemindersFor(db, { ownerUserId: userId });
      return {
        ok: true,
        reminders: reminders.map((r) => ({
          reminder_id: r.id, message: r.body, due_at: r.due_at, timezone: r.timezone,
          revision: Number(r.revision), status: r.status,
        })),
      };
    }

    case 'cancel_reminder': {
      const reminderId = String(input.reminder_id ?? '');
      const cancelled = await cancelReminder(db, { ownerUserId: userId, reminderId });
      // Same sentence for "someone else's", "never existed" and "already
      // settled" — the reasoning behind NOT_YOURS, applied to reminders.
      if (!cancelled) return { ok: false, error: 'not_found', message: 'There is no scheduled reminder with that id.' };
      return { ok: true, reminder_id: cancelled.id, status: cancelled.status,
        revision: Number(cancelled.revision) };
    }

    default:
      return { ok: false, error: 'unknown_tool', message: `no tool named ${name}` };
  }
}

/** Same wording whether the task belongs to someone else or does not exist.
 *
 * A model that learns "that one is not yours" can be steered into enumerating
 * a colleague's task ids — the same reason the HTTP layer answers 404 rather
 * than 403. */
const NOT_YOURS = { ok: false, error: 'not_found', message: 'There is no task with that id.' };

// ------------------------------------------------ document sync honesty
//
// The 2026-09 storage-sync diagnostic fix. `search_documents` and
// `list_documents` used to answer purely from `documents` — whatever rows
// happened to have reached 'indexed' — with no way to say when a chunk of a
// person's connected storage had never been read at all. A folder that never
// completes a sync contributes no rows and raises no error; it is invisible
// by omission. The result, lived through on this installation across a real
// conversation: the same question, "check my docs", got a different-shaped
// answer every time depending on which retry had most recently succeeded or
// failed, each one delivered as if it were the complete, settled picture.
//
// A mapping counts as degraded here in exactly the cases the OWNER should
// hear about: it has never once finished a sync, or its most recent attempts
// are failing. A mapping that is healthy right now but failed once last week
// and has since recovered (0 consecutive_failures) does not qualify —
// `consecutive_failures` resets to 0 on the next clean sync, so a nonzero
// value here always means "failing as of this moment", not "has a history".
function isDegraded(folder: FolderSyncHealth): boolean {
  return folder.neverSynced || folder.consecutiveFailures > 0 || folder.status === 'paused';
}

/** One honest sentence per degraded folder, in the same category vocabulary
 * `sync_state.last_error_category` already uses elsewhere — never a provider's
 * own error text (Rule 4 in storageSync.ts), just enough for the person to
 * know what to do: wait, reconnect, or check the Connections page. */
function describeFolderHealth(folder: FolderSyncHealth): {
  folder: string; provider: string; status: string; ok: boolean; detail: string;
} {
  if (!isDegraded(folder)) {
    return { folder: folder.displayPath, provider: folder.provider, status: folder.status, ok: true, detail: 'syncing normally' };
  }
  let detail: string;
  if (folder.neverSynced) {
    detail = folder.lastErrorCategory
      ? `has never completed a sync (last attempt failed: ${folder.lastErrorCategory})`
      : 'has never completed a sync yet';
  } else if (folder.status === 'paused') {
    detail = `paused after repeated sync failures (${folder.lastErrorCategory ?? 'unknown reason'}) — reconnect on the Connections page`;
  } else {
    detail = `sync is currently failing (${folder.lastErrorCategory ?? 'unknown reason'}, ${folder.consecutiveFailures} attempt(s) in a row)`;
  }
  return { folder: folder.displayPath, provider: folder.provider, status: folder.status, ok: false, detail };
}

/** The single-sentence summary attached to a tool result when at least one
 * connected folder is degraded. Empty string — not attached at all — when
 * every folder is healthy, so a working installation is not nagged on every
 * turn about a state that resolved itself. */
function degradedFoldersNote(health: FolderSyncHealth[]): string {
  const bad = health.filter(isDegraded);
  if (!bad.length) return '';
  const total = health.length;
  if (bad.length === total) {
    return total === 1
      ? `Heads up: your connected folder (${bad[0]!.displayPath}) has not synced successfully — nothing from it is searchable yet.`
      : `Heads up: none of your ${total} connected folders have synced successfully — nothing from them is searchable yet.`;
  }
  const names = bad.map((f) => f.displayPath).join(', ');
  return `Heads up: ${bad.length} of ${total} connected folders have not synced successfully (${names}) — what follows only reflects the folder(s) that did.`;
}

/** The model may say "in five minutes" or name an exact time; both become a
 * Date or nothing. Nothing means the tool answers with instructions rather
 * than guessing a time on the user's behalf. */
function reminderDueAt(input: Record<string, unknown>): Date | null {
  const minutes = Number(input.in_minutes);
  if (Number.isFinite(minutes) && minutes > 0) {
    return new Date(Date.now() + Math.round(minutes * 60_000));
  }
  const at = String(input.due_at ?? '').trim();
  if (at) {
    const parsed = new Date(at);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

async function ownTask(db: Db, taskId: string, userId: string): Promise<boolean> {
  if (!/^[0-9a-fA-F-]{36}$/.test(taskId)) return false;
  const rows = await db.query<{ id: string }>(
    `select id from tasks where id = $1 and owner_user_id = $2`,
    [taskId, userId],
  );
  return rows.length > 0;
}
