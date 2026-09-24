// One turn of a conversation with Josi.
//
// Adapted from the engine's `ownerAgent.ts`. The loop shape is the same —
// call the model, run whatever tools it asked for, feed the results back, up to
// a hop limit — because that part is sound and rewriting it would only find new
// bugs. What changed is everything about who is asking and what stops them.
//
//   engine                              CE
//   ------                              --
//   one verified owner per tenant       every member is a principal for their
//                                       own work; nobody is a principal for
//                                       anyone else's
//   PIN word, because caller ID is      step-up re-auth, because the threat is
//   spoofable                           a held session, not a spoofed number
//   provider hardcoded to Anthropic     Phase 4's registry: capabilities, caps,
//                                       Local-only, fallback
//   tools offered if a connector        tools offered if the capability was
//   object was passed in                PROVEN by the probe
//   full text of every exchange into    lengths only; the words stay in
//   the event log                       `messages`, behind the thread's owner
//
// The last two are the ones worth reading twice. A model that was never proven
// to call tools is not offered any, because offering them produces a confident
// description of work that never happened.
import { randomUUID } from 'node:crypto';
import {
  appendEvent, checkChildAccess, checkStepUp,
  listTemplates, recordChildActivity, resolveConversationalAction,
  type ActivityChannel, type Db,
} from '@josi-ce/core';
import {
  capabilitiesOf, chat, featureAvailable, loadStoredProvider,
  type ChatImage, type ChatMessage, type Capabilities, type RegistryOptions, type ToolResult,
} from '@josi-ce/llm';
import {
  CAUTION_ORDER, assembleSystemContext, extractDurableFacts, loadAll,
  narrowPolicy, relevantMemories, suggestMemory, type Memory,
} from '@josi-ce/persona';
import { isMutatingTool, runDurableEffect } from './durableEffects.js';
import {
  ARTIFACT_CLAIM_GUARD_FALLBACK, ARTIFACT_CLAIM_GUARD_REPROMPT,
  CLAIM_GUARD_FALLBACK, CLAIM_GUARD_REPROMPT, claimsArtifactCompletion,
  claimsCompletedAction, hasArtifactReceipt,
} from './claimGuard.js';
import {
  DATA_CLAIM_GUARD_FALLBACK, DATA_CLAIM_GUARD_REPROMPT, DATA_CLAIM_TOOLS, checkDataClaims,
  NARRATED_SEARCH_GUARD_FALLBACK, NARRATED_SEARCH_GUARD_REPROMPT, checkNarratedSearchWithoutTool,
  type DataToolReceipt,
} from './dataClaimGuard.js';
import { customApiToolAvailability, type CustomApiAvailability } from './customApiTools.js';
import { workflowToolAvailability } from './workflowTools.js';
import { developerIntegrationToolAvailability } from './developerIntegrationTools.js';
import { dataToolAvailability, writeActionCapabilities, type DataToolAvailability } from './dataTools.js';
import { executeAssistantTool } from './execute.js';
import { workspaceToolNames } from './workspaceTools.js';
import { TASK_TOOLS, TOOL_SPECS_BY_NAME } from './tools.js';
import { presentToolBackedReply } from './presentation.js';
import { effectiveTimeContext } from './timeContext.js';
import {
  GENERIC_RETRY, immediatelyPrecedingRetryTarget, retryReply, retryTargetFor,
  type AssistantRetryTarget,
} from './retry.js';
import {
  IMAGE_GENERATION_UNAVAILABLE, auditUnsupportedImageIntent, classifyImageIntent,
  immediatePriorMediaResult, isImmediateMediaStatusFollowup,
  type MediaRequestMeta, type MediaResultMeta,
} from './mediaCapability.js';

/** Recall over the user's own history, injected by the caller. A function
 * rather than a package dependency: the agent does not care whether recall is
 * Postgres full-text, pgvector, or off. Phase 9 supplies it; until then it is
 * absent and the agent says so rather than inventing. */
export type RecallLookup = (query: string) => Promise<string>;

export interface AgentTurnResult {
  reply: string;
  actions: Array<{ tool: string; result: unknown }>;
  /** Exact repeatable read represented by this assistant turn. Callers persist
   * it in the outbound message metadata; generic retry never parses prose. */
  retry?: AssistantRetryTarget;
  /** Which memories shaped this turn, so a person can see why it said what it
   * did rather than being quietly profiled. */
  memoriesUsed?: Array<{ id: string; content: string }>;
  /** What the turn proposed to remember, and what became of it. */
  learned?: LearnOutcome;
  /** True when `args.images` had at least one entry and the active model was
   * NOT proven to have vision, so they were left off the model call entirely.
   * The system prompt already tells the model to say this plainly when asked
   * about an attachment; this field lets the CALLER (the route, a future UI)
   * know the same thing happened, without parsing the reply text for it. */
  imagesDroppedNoVision?: boolean;
  /** Typed, content-free media state for durable immediate follow-up binding.
   * Callers persist request metadata on the inbound message and result metadata
   * on the outbound message; neither field contains the person's prompt. */
  mediaRequest?: MediaRequestMeta;
  mediaResult?: MediaResultMeta;
  /** Set when the turn could not run at all. The caller shows this instead of a
   * reply — it is never dressed up as something Josi said. */
  refusal?: {
    reason: 'no_model' | 'not_probed' | 'cannot_chat' | 'capped' | 'provider_error' | 'restricted';
    message: string;
    /** Provider-declared retryability; durable callers must not infer this
     * from the broad provider_error category. */
    retryable?: boolean;
  };
}

export interface TurnArgs {
  db: Db;
  registry: RegistryOptions;
  /** Whose turn this is. Everything the agent creates belongs to them, and
   * whose personalization is loaded. Never a value from a request body. */
  userId: string;
  threadId: string;
  /** Persisted inbound message id for action-state turn scoping. */
  inboundMessageId?: string;
  /** Durable worker fence for consequential tool effects. Both values are
   * server-derived and never accepted from a client request. */
  durableTurnId?: string;
  durableLeaseToken?: string;
  /** Durable queued channels require yes/no to target the presented approval
   * message; synchronous legacy channels rely on immediate adjacency. */
  replyToMessageId?: string|null;
  requireApprovalReplyTarget?: boolean;
  history: ChatMessage[];
  inbound: string;
  /** Images attached to THIS turn, already read off disk as bytes by the
   * route. Attached to the model's user message ONLY when the active model
   * was PROVEN to have vision (see `capabilities.vision` below) — otherwise
   * they are dropped from the model call entirely and the caller is expected
   * to have already said so honestly, rather than this loop inventing a
   * description from bytes the model never saw. */
  images?: ChatImage[];
  recall?: RecallLookup;
  /** Fetch used for connected-provider calls (Gmail, Graph…). Injected by the
   * tests; unset in production, where the real fetch is used. Deliberately
   * separate from the registry's fetchImpl — that one talks to the MODEL. */
  connectorFetch?: typeof fetch;
  customApiFetch?: typeof fetch;
  outboundResolve?: (hostname: string) => Promise<string[]>;
  /** Which channel this turn arrived on. Only used to record a managed child's
   * minute honestly — "45 minutes with Josi" should not read as "45 minutes in
   * the web app" when half of it was Telegram. */
  channel?: ActivityChannel;
  /** What a step-up unlock is scoped to. Defaults to the thread, so verifying
   * in one conversation does not silently unlock another. */
  sessionKey?: string;
  maxHops?: number;
  /** Test seam for deterministic local-date and DST behavior. */
  now?: Date;
}

const HOP_LIMIT = 6;

function systemPrompt(args: {
  capabilities: Capabilities;
  templateNames: string[];
  hasRecall: boolean;
  unavailable: string[];
  data?: DataToolAvailability;
  customApis?: string[];
  imagesAttached?: boolean;
  temporalContext: string;
}): string {
  return [
    'You are Josi, an assistant working for one person inside a small shared workspace.',
    'You are talking to that person. Everything you create belongs to them and nobody else in the workspace sees it unless they share it.',
    'Be brief and direct: lead with the answer, no filler, no preamble.',
    'Plain text only — no markdown, no asterisks, no headings.',
    'You do work through tasks. Fill every required slot BEFORE anything is attempted; if a required slot is missing, ask for it. Never start work with a hole in it.',
    'For any claim about connected providers, storage availability or indexing, call get_provider_status this turn. Email availability is stricter: call check_email_availability and claim availability only when its live provider request succeeds; connection metadata is never live proof. Use evidence internally, but never show receipts, observation timestamps, account metadata, internal identifiers, or raw status records. Summarize only the useful human-facing answer and source/provider name. Never infer runtime state from prior chat.',
    'Never invent a name, number, address or time. If you do not know something, ask or say you do not know.',
    `${args.temporalContext} Ask only for scheduling details that are genuinely missing, such as duration when no end time or duration was given.`,
    'For calendar follow-ups, preserve the exact named subject and verified event receipt from the prior turn. “Move/push the EDD call” modifies the EDD event, never the newly proposed event. Keep the existing event on its original calendar and inherit the verified/default calendar for a new event instead of asking again when the receipt already identifies it.',
    args.templateNames.length
      ? `The kinds of work you can start: ${args.templateNames.join(', ')}.`
      : 'No kinds of work are enabled on this installation, so you cannot start a task.',
    // The honest half. Phase 5 ships the task machinery but nothing that
    // executes against a calendar or a mailbox, so a task can be perfectly
    // formed and still have nothing able to carry it out. Saying so is the
    // difference between "waiting" and a silent failure the user finds later.
    args.unavailable.length
      ? `These are not connected yet, so work that needs them will be prepared and then WAIT rather than happen: ${args.unavailable.join(', ')}. Say that plainly — do not imply anything has been sent, booked or delivered.`
      : '',
    args.capabilities.toolCalling
      ? ''
      : 'You cannot call tools on this installation, so you can talk but cannot create or change anything. Say so if asked to do something.',
    // Connected data, stated honestly in both directions. What is ON is a
    // real ability backed by a tool; what is OFF is named with the exact
    // switch that fixes it, so "can you read my email" never gets a guess.
    args.capabilities.toolCalling && args.data?.granted.length
      ? `You have READ access to this person's connected ${args.data.granted.join(', ')} through your tools. Use a connected-data tool only when the person explicitly asks about their email, calendar, contacts, files, or documents, or is clearly continuing such a request. Ordinary conversation, greetings, and bare words such as "test" are NOT search requests. Never turn them into searches. When a data lookup is requested, answer from the real data; never invent a message, event, person, file, or document. Report empty results as empty.`
      : '',
    args.capabilities.toolCalling && args.data?.denied.length
      ? `You currently have no access to: ${args.data.denied.map((d) => d.what).join(', ')}. If asked about one of these, say so and pass on the fix: ${args.data.denied.map((d) => `${d.what} — ${d.hint}`).join(' ')}`
      : '',
    args.capabilities.toolCalling && args.customApis?.length
      ? `An administrator has connected these external services and chosen exactly which actions you may use on each: ${args.customApis.join(', ')}. Use call_custom_api only for those actions. You cannot reach any other address. Actions that change or delete something wait for the person to approve on their Approvals page; never say they are done before approval and execution.`
      : '',
    args.hasRecall
      ? 'You can search this person\'s own history. Do that before saying you do not know.'
      : '',
    // Vision, stated exactly as honestly as tool calling and connected data
    // above: ON means the picture genuinely reached the model as image bytes
    // this turn, and OFF means it did not, full stop — there is no OCR text or
    // any other stand-in for it to describe. Guessing at a photo's contents
    // from its filename or from silence would be the same fabrication this
    // fix exists to remove.
    args.imagesAttached
      ? (args.capabilities.vision
        ? 'An image was attached to this message and you can see it — describe or answer about what is actually in it.'
        : 'An image was attached to this message, but this model has not been shown to understand images, so you were NOT shown it and have no idea what it contains. Say plainly that you cannot see images with the current model — do not guess, and do not describe a filename or file type as if it were the picture\'s content.')
      : '',
    'Never ask for, repeat, or accept a password in conversation. If a tool requires secure reauthentication, direct the person to the protected reauthentication control in Settings and do not attempt the action again on your own.',
  ].filter(Boolean).join(' ');
}

export async function runAssistantTurn(args: TurnArgs): Promise<AgentTurnResult> {
  const { db, userId } = args;
  const actions: AgentTurnResult['actions'] = [];
  let retry: AssistantRetryTarget | undefined;
  const sessionKey = args.sessionKey ?? args.threadId;

  // ---- is this person allowed to be talking to Josi at all? --------------
  //
  // FIRST, before the model, the tools, the prompt or a single token. This is
  // the one place every channel passes through — web, Telegram, WhatsApp,
  // Slack, Signal — so a managed child's agreed hours and daily limit are
  // enforced here rather than once per route. A route that forgot to ask (and
  // the web one does ask, first, so a person gets a 403 instead of a refusal
  // dressed as an answer) still cannot get past this.
  //
  // Everyone who is not a managed child of a bought module is allowed by one
  // indexed query, which is the answer on essentially every turn.
  const childAccess = await checkChildAccess(db, { userId });
  if (!childAccess.allowed) {
    return {
      reply: '', actions,
      refusal: {
        reason: 'restricted',
        message: childAccess.opensAgain
          ? `${childAccess.message} Josi is back at ${childAccess.opensAgain}.`
          : (childAccess.message ?? 'Josi is not available on this account right now.'),
      },
    };
  }
  // Counted at the START of a turn: the minute somebody spoke is the minute
  // that was used, whatever the model does next. A turn that fails on a
  // provider error still happened.
  if (childAccess.managed) {
    await recordChildActivity(db, { childUserId: userId, channel: args.channel ?? 'web' });
  }

  // Unsupported media requests and their immediate status follow-ups are
  // resolved before generic retry or any model/tool routing, so they cannot
  // drift into an older calendar or workspace domain.
  const imageIntent = classifyImageIntent(args.inbound);
  let priorMedia = null as Awaited<ReturnType<typeof immediatePriorMediaResult>>;
  if (!imageIntent && isImmediateMediaStatusFollowup(args.inbound)) {
    priorMedia = await immediatePriorMediaResult(db, {
      ownerUserId: userId,
      threadId: args.threadId,
      currentInboundMessageId: args.inboundMessageId,
    });
  }
  if (imageIntent || priorMedia) {
    const intent = imageIntent ?? 'status';
    const requestId = priorMedia?.result.request_id ?? randomUUID();
    const mediaRequest: MediaRequestMeta = {
      v: 1, id: randomUUID(), media: 'image', intent,
      ...(priorMedia ? { refers_to: requestId } : {}),
    };
    const mediaResult: MediaResultMeta = {
      v: 1, request_id: priorMedia ? requestId : mediaRequest.id,
      media: 'image', intent, status: 'unavailable',
      error: 'image_generation_unavailable',
    };
    await auditUnsupportedImageIntent(db, { ownerUserId: userId, threadId: args.threadId, intent });
    return { reply: IMAGE_GENERATION_UNAVAILABLE, actions, mediaRequest, mediaResult };
  }

  // Generic retry is resolved before either action-state prose or the model.
  // It may repeat only the exact typed read stored on the immediately preceding
  // assistant message. No metadata means no target: old approvals, succeeded
  // writes and nouns in conversation history are deliberately invisible here.
  if (GENERIC_RETRY.test(args.inbound.trim())) {
    const target = await immediatelyPrecedingRetryTarget(db, {
      ownerUserId: userId,
      threadId: args.threadId,
      currentInboundMessageId: args.inboundMessageId,
    });
    if (!target) return { reply: 'What exactly would you like me to retry?', actions };
    let result: unknown;
    try {
      const decision = await checkStepUp(db, { userId, sessionKey, action: target.tool });
      result = decision.allowed
        ? await execTool(args, target.tool, target.input)
        : { ok: false, error: decision.reason, message: decision.message };
    } catch {
      result = { ok: false, error: 'failed' };
    }
    actions.push({ tool: target.tool, result });
    return { reply: retryReply(target, result), actions, retry: target };
  }

  // Short approvals, denials and execution-status questions are resolved from
  // durable action state before a model is consulted. A bare "yes" can only
  // bind to one action prepared in the immediately preceding presented turn;
  // provider names and old calendar subjects in model history are irrelevant.
  const resolveAction=()=>resolveConversationalAction(db,{ownerUserId:userId,threadId:args.threadId,inbound:args.inbound,replyToMessageId:args.replyToMessageId,requireReplyTarget:args.requireApprovalReplyTarget});
  const mayDecideAction=/^(?:yes|yes please|please do|do it|send it|approve|confirmed?|no|no thanks|don't|do not|cancel|deny)\s*[.!]?$/i.test(args.inbound.trim());
  const deterministic=args.durableTurnId&&args.durableLeaseToken&&mayDecideAction
    ? await runDurableEffect(args.db,{turnId:args.durableTurnId,leaseToken:args.durableLeaseToken},'assistant_action_resolution',{inbound:args.inbound,replyToMessageId:args.replyToMessageId??null},resolveAction)
    : await resolveAction();
  if(deterministic.handled){
    return {reply:deterministic.reply??'',actions:deterministic.action?[{tool:'assistant_action_state',result:{ok:true,domain:deterministic.action.domain,status:deterministic.action.status,task_id:deterministic.action.task_id}}]:[]};
  }

  // ---- can we run at all? ------------------------------------------------
  // Asked before anything is spent, and answered honestly. A missing or
  // unproven model is not an error to bury in a reply.
  const stored = await loadStoredProvider(db, 'primary');
  if (!stored) {
    return {
      reply: '', actions,
      refusal: { reason: 'no_model', message: 'No model is configured for this installation yet. An administrator sets that up in the admin section.' },
    };
  }
  const capabilities = capabilitiesOf(stored);
  if (!capabilities || !stored.activated_at) {
    return {
      reply: '', actions,
      refusal: { reason: 'not_probed', message: 'The configured model has not been tested yet, so Josi will not use it. An administrator can run the test from the admin section.' },
    };
  }
  if (!featureAvailable('assistant_chat', capabilities)) {
    return {
      reply: '', actions,
      refusal: { reason: 'cannot_chat', message: 'The configured model could not hold a basic conversation when it was tested, so Josi cannot answer with it.' },
    };
  }

  // ---- what may be offered ----------------------------------------------
  // Tools only if the model was PROVEN to call them. Not "probably supports",
  // not inferred from the model name.
  const templates = await listTemplates(db);
  let writeCapabilities = new Set<string>();
  if (capabilities.toolCalling) {
    try { writeCapabilities = await writeActionCapabilities(db, userId); }
    catch (err) { console.error('write capability availability check failed', (err as Error).message); }
  }
  const unavailable = [...new Set(templates.map((t) => t.requiresCapability)
    .filter((capability): capability is string => !!capability && !writeCapabilities.has(capability)))];

  // Which connected-data tools THIS person's switches allow, right now. The
  // offering is per turn: flip a switch off between turns and the tool is
  // gone from the next list; execution re-checks anyway for the same turn.
  let data: DataToolAvailability = { specs: [], granted: [], denied: [] };
  if (capabilities.toolCalling) {
    try {
      data = await dataToolAvailability(db, userId);
    } catch (err) {
      // Availability is a bonus; a broken connections table must not cost the
      // person their conversation. The tools are simply not offered.
      console.error('data tool availability check failed', (err as Error).message);
    }
  }
  let customApis: CustomApiAvailability = { specs: [], connectionNames: [] };
  let workflowTools = [] as import('./tools.js').ToolSpec[];
  let developerIntegrationTools = [] as import('./tools.js').ToolSpec[];
  if (capabilities.toolCalling) {
    try {
      customApis = await customApiToolAvailability(db);
    } catch (err) {
      console.error('custom api tool availability check failed', (err as Error).message);
    }
  }
  if (capabilities.toolCalling) {
    try { workflowTools = await workflowToolAvailability(db); }
    catch (err) { console.error('native workflow availability check failed', (err as Error).message); }
    try { developerIntegrationTools = await developerIntegrationToolAvailability(db,userId); }
    catch (err) { console.error('native integration availability check failed', (err as Error).message); }
  }
  const workspaceNames = capabilities.toolCalling ? await workspaceToolNames(db,userId) : new Set<string>();
  // `approve_task` is only meaningful when this owner already has a generic
  // task waiting on them. Offering it on an ordinary request lets a model
  // confuse "please create this calendar event" with approval of an unrelated
  // task, which then trips the protected step-up gate before the real calendar
  // draft is even prepared.
  const [approvableTask] = capabilities.toolCalling
    ? await db.query<{ present: boolean }>(`select true as present from tasks
        where owner_user_id=$1 and state in ('awaiting_approval','awaiting_owner') limit 1`, [userId])
    : [];
  const availableTaskTools = TASK_TOOLS.filter((t) =>
    (!t.def.name.startsWith('workspace_') || workspaceNames.has(t.def.name))
    && (t.def.name !== 'approve_task' || !!approvableTask)
    && (!t.requiresCapability || writeCapabilities.has(t.requiresCapability)));
  const tools = capabilities.toolCalling
    ? [...availableTaskTools, ...data.specs, ...customApis.specs, ...workflowTools, ...developerIntegrationTools].map((t) => t.def)
    : undefined;
  const offeredToolNames = new Set(tools?.map((tool) => tool.name) ?? []);

  let recalled = '';
  if (args.recall) {
    // Best effort: a recall outage must not cost someone their turn.
    try {
      recalled = await args.recall(args.inbound);
    } catch (err) {
      console.error('recall lookup failed', (err as Error).message);
    }
  }

  // The immutable core. Built exactly as before — capabilities, tools, recall
  // and the hard-coded safety lines are unchanged, and personalization is
  // appended to it rather than replacing any of it.
  const imagesAttached = !!args.images?.length;
  const temporal = await effectiveTimeContext(db, userId, args.now ?? new Date());
  const core = systemPrompt({
    capabilities,
    templateNames: templates.map((t) => t.key),
    hasRecall: !!args.recall && !!recalled,
    unavailable,
    data,
    customApis: customApis.connectionNames,
    imagesAttached,
    temporalContext: temporal.prompt,
  }) + (recalled ? `\n\nFrom this person's own history:\n${recalled}` : '');

  // The person's own layers, in the order the plan fixes. A failure here costs
  // personality, never the turn: an assistant that refuses to answer because a
  // profile could not be read is worse than one that answers plainly.
  let system = core;
  let memoriesUsed: Array<{ id: string; content: string }> = [];
  try {
    const layers = await loadAll(db, userId);
    const { effective } = narrowPolicy(layers.agents_admin, layers.agents_user, CAUTION_ORDER);
    const memories = await relevantMemories(db, { ownerUserId: userId, request: args.inbound });
    memoriesUsed = memories.map((m: Memory) => ({ id: m.id, content: m.content }));

    system = assembleSystemContext({
      core,
      adminPolicy: layers.agents_admin,
      userPolicy: effective,
      soul: layers.soul,
      user: layers.user,
      memories: memories.map((m: Memory) => ({ content: m.content, provenance: m.provenance })),
    }).text;
  } catch (err) {
    console.error('personalization unavailable for this turn', (err as Error).message);
  }

  // The request stays where it belongs: one user message, not repeated in the
  // system context. Duplicating it makes a model weight it twice and makes the
  // transcript a lie about what was asked.
  //
  // Images ride on that SAME user message, and ONLY when the active model was
  // PROVEN to have vision. An unproven or disproven model gets no `images` on
  // the request at all — the route that called us is expected to have already
  // told the person plainly that this model cannot see attachments, rather
  // than this loop silently dropping bytes and letting a reply imply it looked.
  const images: ChatImage[] | undefined = capabilities.vision ? args.images : undefined;
  const imagesDroppedNoVision = imagesAttached && !capabilities.vision;
  const messages: ChatMessage[] = [
    ...args.history,
    { role: 'user', content: args.inbound, ...(images?.length ? { images } : {}) },
  ];

  // Claims require receipts (round-2 item 12). One corrective re-prompt is
  // allowed per turn; a model that fabricates twice gets its reply replaced.
  let claimGuardReprompted = false;
  let artifactClaimGuardAudited = false;
  // Data claims require receipts too (item 41b). A SEPARATE one-reprompt
  // budget from the action guard above — a turn could conceivably trip both
  // in sequence (fabricate a tool call's existence, get corrected, then
  // fabricate a detail about the tool it actually ran), and each failure mode
  // gets its own honest correction rather than sharing a budget that could
  // starve the second check.
  let dataClaimGuardReprompted = false;
  // A reply can narrate having run a search with ZERO tool calls in the turn
  // at all (the 2026-09-04 incident) — a THIRD, separate budget again. This
  // is the most clear-cut violation of the three (there is no receipt
  // whatsoever to be wrong about) so it is checked first, below.
  let narratedSearchGuardReprompted = false;

  for (let hop = 0; hop < (args.maxHops ?? HOP_LIMIT); hop++) {
    let outcome;
    try {
      outcome = await chat(
        args.registry,
        {
          messages, system, tools, maxTokens: 1024,
          // For providers that execute tools OUT of process (the subscription
          // CLI harness): who is asking travels with the request, so the MCP
          // server enforces the same step-up gate this loop enforces below.
          // From the session, never from a request body.
          toolContext: {
            userId, sessionKey, threadId: args.threadId,
            durableTurnId: args.durableTurnId ?? null,
            durableLeaseToken: args.durableLeaseToken ?? null,
            latestUserText: args.inbound,
            effectiveNow: (args.now ?? new Date()).toISOString(),
          },
        },
        { userId, purpose: 'assistant_chat' },
      );
    } catch (err) {
      // Caps, Local-only, a dead provider. The message from the registry is
      // written for a person; it is relayed, not reinterpreted.
      return {
        reply: '', actions,
        refusal: {
          reason: (err as { needsReconfiguration?: boolean }).needsReconfiguration ? 'capped' : 'provider_error',
          message: (err as Error).message,
          retryable: (err as { retryable?: boolean }).retryable === true,
        },
      };
    }

    const res = outcome.response;

    // Calls a harness provider's model already ran, out of process, against
    // Josi's own MCP server — which gated and executed them. Recorded here so
    // the person can see what acted on their behalf; NOT executed again, which
    // is why they are kept apart from `toolCalls` in the seam.
    for (const call of res.executedToolCalls ?? []) {
      actions.push({ tool: call.name, result: call.result });
      // Assignment (rather than "last retryable") is intentional: if a write
      // follows a read, the immediately preceding operation is the write and
      // this turn must carry no generic-retry target.
      retry = retryTargetFor(call.name, call.input);
    }

    if (!res.toolCalls.length) {
      // ---- narrated search/read with ZERO tool calls this turn ----------
      // Checked FIRST and separately from the two guards below: a reply that
      // confidently describes running a search and reports specific results
      // when literally no data tool executed this turn (not even a failed
      // attempt) has nothing whatsoever behind it — the clearest-cut violation
      // of the three, and the one checkDataClaims structurally cannot catch
      // (it requires a receipt to build a vocabulary from; zero receipts means
      // it stays silent by design). This is the exact 2026-09-04 incident
      // shape: "Test" in, a confident fabricated "eight passages across six
      // files" reply out, 6ms later, meta empty.
      let reply = res.text;
      const dataReceiptsThisTurn: DataToolReceipt[] = actions
        .filter((a) => DATA_CLAIM_TOOLS.has(a.tool))
        .map((a) => ({ tool: a.tool, result: a.result }));
      const narratedVerdict = checkNarratedSearchWithoutTool(reply, dataReceiptsThisTurn);
      if (narratedVerdict.fabricated) {
        if (!narratedSearchGuardReprompted) {
          narratedSearchGuardReprompted = true;
          messages.push({ role: 'assistant', content: reply });
          messages.push({ role: 'user', content: NARRATED_SEARCH_GUARD_REPROMPT });
          continue; // one more hop: call the real tool, or restate honestly
        }
        await appendEvent(db, {
          actorUserId: userId,
          actor: 'agent',
          kind: 'agent.narrated_search_without_tool',
          subjectType: 'thread',
          subjectId: args.threadId,
        });
        const learnedOnFabrication = await learnFromTurn(db, { userId, inbound: args.inbound });
        return {
          reply: NARRATED_SEARCH_GUARD_FALLBACK, actions, memoriesUsed, learned: learnedOnFabrication,
          imagesDroppedNoVision, retry,
        };
      }

      // ---- claims require receipts --------------------------------------
      // `actions` holds every receipt this turn produced: tools this loop ran
      // AND tools a subscription CLI harness executed out of process
      // (recorded from executedToolCalls above). Zero receipts + a reply that
      // claims a completed action = a fabrication, and it does not pass.
      const artifactClaim = claimsArtifactCompletion(reply);
      const missingArtifactReceipt = artifactClaim && !hasArtifactReceipt(actions);
      if ((actions.length === 0 && claimsCompletedAction(reply)) || missingArtifactReceipt) {
        if (missingArtifactReceipt && !artifactClaimGuardAudited) {
          artifactClaimGuardAudited = true;
          await appendEvent(db, {
            actorUserId: userId,
            actor: 'agent',
            kind: 'agent.artifact_claim_without_receipt',
            subjectType: 'thread',
            subjectId: args.threadId,
            payload: { receiptCount: actions.length },
          });
        }
        if (!claimGuardReprompted) {
          claimGuardReprompted = true;
          messages.push({ role: 'assistant', content: reply });
          messages.push({ role: 'user', content: missingArtifactReceipt
            ? ARTIFACT_CLAIM_GUARD_REPROMPT : CLAIM_GUARD_REPROMPT });
          continue; // one more hop: produce a real receipt, or restate honestly
        }
        if (!missingArtifactReceipt) {
          await appendEvent(db, {
            actorUserId: userId,
            actor: 'agent',
            kind: 'agent.claim_without_receipt',
            subjectType: 'thread',
            subjectId: args.threadId,
          });
        }
        reply = missingArtifactReceipt ? ARTIFACT_CLAIM_GUARD_FALLBACK : CLAIM_GUARD_FALLBACK;
      }

      // ---- data claims require receipts too (item 41b) -------------------
      // A tool running does not make everything said afterward true. Check
      // the reply's specifics (file names, counts) against what the
      // data-returning tools ACTUALLY returned this turn — not just "a tool
      // ran at all", which is all the guard above checks. Only receipts from
      // data-returning tools go in; task/reminder actions have nothing this
      // guard can compare against and are left out of its vocabulary. Reuses
      // dataReceiptsThisTurn computed above for the narrated-search guard —
      // same filter, no need to recompute it.
      if (dataReceiptsThisTurn.length) {
        const verdict = checkDataClaims(reply, dataReceiptsThisTurn);
        if (verdict.fabricated) {
          if (!dataClaimGuardReprompted) {
            dataClaimGuardReprompted = true;
            messages.push({ role: 'assistant', content: reply });
            messages.push({ role: 'user', content: DATA_CLAIM_GUARD_REPROMPT });
            continue; // one more hop: restate using only the real tool result
          }
          await appendEvent(db, {
            actorUserId: userId,
            actor: 'agent',
            kind: 'agent.data_claim_without_receipt',
            subjectType: 'thread',
            subjectId: args.threadId,
            // Metadata only — events forbid content-shaped payload keys
            // (filename, snippet, etc, see events.ts). A count is enough to
            // know this fired without smuggling the fabricated filename or
            // count itself into the audit trail.
            payload: { mismatchCount: verdict.reasons.length },
          });
          reply = DATA_CLAIM_GUARD_FALLBACK;
        }
      }

      // A completed exchange, so there is something to learn from — and only
      // ever from what the PERSON wrote. Never the reply, never tool output.
      const learned = await learnFromTurn(db, { userId, inbound: args.inbound });
      // Guards inspect the original model text against intact receipts above.
      // Presentation happens only after those checks, once, at the shared
      // agent boundary used by web and every external channel.
      reply = presentToolBackedReply(reply, actions);
      const prepared=actions.map(action=>action.result).filter((result):result is {state:string;summary:string}=>
        !!result&&typeof result==='object'&&(result as {state?:unknown}).state==='prepared'&&typeof (result as {summary?:unknown}).summary==='string');
      if(prepared.length===1)reply=args.requireApprovalReplyTarget
        ? `${prepared[0].summary}\n\nUse the Approve or Deny control below for this exact action.`
        : `${prepared[0].summary}\n\nApprove this exact action? Reply yes or no.`;
      else if(prepared.length>1)reply='More than one consequential action was prepared together. Name which one you want to review; a bare yes will not approve either.';
      else {
        const automatic=actions.map(action=>action.result).filter((result):result is {state:string;summary:string;authorization:string}=>
          !!result&&typeof result==='object'&&(result as {state?:unknown}).state==='approved'&&(result as {authorization?:unknown}).authorization==='user_policy'&&typeof (result as {summary?:unknown}).summary==='string');
        if(automatic.length===1)reply=`${automatic[0].summary}\n\nQueued automatically using your approval preference.`;
      }
      const secureReauth=actions.map(action=>action.result).find((result):result is {error:string;message?:string}=>
        !!result&&typeof result==='object'&&['needs_reauth','locked_out'].includes(String((result as {error?:unknown}).error)));
      if(secureReauth)reply=secureReauth.message
        ?? 'Use the protected reauthentication control in Settings to continue. Never send your password in chat.';
      return { reply, actions, memoriesUsed, learned, imagesDroppedNoVision, retry };
    }

    const toolResults: ToolResult[] = [];
    for (const call of res.toolCalls) {
      let result: unknown;
      try {
        // A provider may still emit a known tool it was not offered. In
        // particular, never turn a hallucinated approve_task call into a
        // reauthentication prompt when no owned task is awaiting approval.
        if (call.name === 'approve_task' && !offeredToolNames.has(call.name)) {
          result = { ok: false, error: 'tool_unavailable', message: 'No task is waiting for approval. Continue the requested action with its own tool.' };
        } else {
          // The gate, in front of everything, keyed by tool name.
          const decision = await checkStepUp(db, { userId, sessionKey, action: call.name });
          if (!decision.allowed) {
            result = { ok: false, error: decision.reason, message: decision.message };
          } else {
            result = await execTool(args, call.name, call.input);
          }
        }
      } catch (err) {
        // The tool's own message, not a stack trace, and never a provider body.
        result = { ok: false, error: 'failed', message: (err as Error).message };
      }
      actions.push({ tool: call.name, result });
      retry = retryTargetFor(call.name, call.input);
      toolResults.push({ toolCallId: call.id, name: call.name, content: JSON.stringify(result) });
    }

    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
    messages.push({ role: 'user', content: '', toolResults });
  }

  await appendEvent(db, {
    actorUserId: userId,
    actor: 'agent',
    kind: 'agent.hop_limit',
    subjectType: 'thread',
    subjectId: args.threadId,
  });
  return {
    reply: 'I went round in circles on that one and stopped. Try telling me in a different way.',
    actions, imagesDroppedNoVision, retry,
  };
}

export interface LearnOutcome {
  suggested: number;
  saved: number;
  /** Named so the caller can say "nothing was kept" honestly. */
  mode: 'off' | 'manual' | 'automatic';
}

/**
 * Bounded, structured extraction from the person's own message.
 *
 * Everything about this is deliberately narrow, and the narrowness IS the
 * feature. It reads one message the person wrote, matches explicit
 * self-statements, refuses secrets and sensitive categories, and hands at most
 * two candidates to `suggestMemory` — which then honours the person's mode:
 * off stores nothing, manual raises a pending suggestion, automatic saves.
 *
 * It never reads the model's reply. A model claim stored as a durable fact
 * about its owner is a fabrication with a long life.
 */
async function learnFromTurn(
  db: Db,
  args: { userId: string; inbound: string },
): Promise<LearnOutcome> {
  const [settings] = await db.query<{ memory_mode: 'off' | 'manual' | 'automatic' }>(
    `select memory_mode from persona_settings where user_id = $1`,
    [args.userId],
  ).catch(() => [] as Array<{ memory_mode: 'off' | 'manual' | 'automatic' }>);
  const mode = settings?.memory_mode ?? 'manual';
  if (mode === 'off') return { suggested: 0, saved: 0, mode };

  const candidates = extractDurableFacts(args.inbound);
  if (!candidates.length) return { suggested: 0, saved: 0, mode };

  let suggested = 0;
  let saved = 0;
  for (const candidate of candidates) {
    try {
      const out = await suggestMemory(db, {
        ownerUserId: args.userId,
        content: candidate.content,
        sourceKind: 'conversation',
        confidence: candidate.confidence,
      });
      if (out.suggested) {
        suggested += 1;
        if (out.auto) saved += 1;
      }
    } catch {
      // Learning is a bonus, never the point of the turn.
    }
  }
  return { suggested, saved, mode };
}

async function execTool(
  args: TurnArgs,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const spec = TOOL_SPECS_BY_NAME.get(name);
  if (!spec) return { ok: false, error: 'unknown_tool', message: `no tool named ${name}` };
  const execute=()=>{
    // The implementations live in execute.ts so the MCP server — which offers
    // these same tools to a subscription CLI's own agent loop — runs the exact
    // code this loop runs, ownership checks and all.
    const masterKey = args.registry.masterKey;
    return executeAssistantTool(args.db, {
      userId: args.userId,
      threadId: args.threadId,
      turnId: args.inboundMessageId,
      latestUserText: args.inbound,
      effectiveNow: args.now,
      connectors: masterKey ? {
        masterKey: () => masterKey,
        fetchImpl: args.connectorFetch,
        customApiFetch: args.customApiFetch,
        resolve: args.outboundResolve,
      } : null,
    }, name, input);
  };
  return isMutatingTool(name,input)?runDurableEffect(args.db,{turnId:args.durableTurnId,leaseToken:args.durableLeaseToken},name,input,execute):execute();
}
