// The provider seam.
//
// Everything above this line — the probe, the registry, and eventually the
// assistant — talks to LlmProvider. Only the adapters know what an OpenAI or
// Anthropic payload looks like, and neither shape is allowed past here.

import { PROVIDERS } from './catalog.js';

export type ProviderKind =
  | 'openai' | 'anthropic' | 'xai' | 'openai_compatible'
  // V2.4. Vendors whose chat-completions endpoint genuinely honours the OpenAI
  // contract for tools and structured output. They are separate KINDS rather
  // than `openai_compatible` with a different base URL for one reason that is
  // not cosmetic: `openai_compatible` is classified as NON-external, exempt
  // from the data-leaves-this-server acknowledgement, and permitted under
  // Local-only mode. Pointing it at a hosted vendor would send user data to a
  // third party while the badge still read "nothing leaves this server".
  | 'deepseek' | 'qwen' | 'mistral' | 'moonshot' | 'zhipu' | 'openrouter' | 'minimax'
  // V2.4. Vendors whose contract differs enough to need their own adapter —
  // a different auth scheme, request body, or tool-calling representation.
  | 'gemini' | 'cohere' | 'bedrock' | 'azure_ai' | 'vertex_ai' | 'ernie' | 'hunyuan'
  // Phase 13.3. Not "OpenAI with a different credential" — a different
  // TRANSPORT: no HTTP request is made by CE on this path at all, the
  // operator's own first-party Codex CLI is run as a subprocess. It is a
  // separate kind so that nothing which branches on provider can confuse the
  // two, and so the edition boundary has something concrete to refuse.
  | 'openai_subscription'
  // Phase 14. The same shape for Anthropic: not "Anthropic with a different
  // credential" but a different TRANSPORT — no HTTP request is made by CE, the
  // operator's own first-party Claude Code CLI is run as a subprocess. Separate
  // from `anthropic` so nothing branching on provider can confuse a subscription
  // with an API account, and so the edition boundary has something to refuse.
  | 'anthropic_subscription';

/** Providers that send request content off this server.
 *
 * `openai_compatible` is the only kind absent, on purpose: it points at
 * whatever the operator runs, which is the self-hosted path. Every hosted
 * vendor is here, and so is each subscription — the bytes reach OpenAI or
 * Anthropic by way of their own binary rather than our fetch, which changes
 * who holds the credential and changes nothing at all about where the
 * conversation goes. So Local-only refuses them and the external
 * acknowledgement is required, exactly as for a key-based provider. Leaving
 * one out would make "nothing leaves this server" false while the badge still
 * said otherwise.
 *
 * Derived from the catalogue rather than typed out again. This list and the
 * provider table used to be maintained separately, which is precisely the
 * arrangement that let `anthropic_subscription` exist in code before the
 * migration that would let it be stored. A provider added to the catalogue is
 * classified here automatically, and one that is not in the catalogue does not
 * exist at all. */
export const EXTERNAL_PROVIDERS: readonly ProviderKind[] =
  PROVIDERS.filter((p) => p.external).map((p) => p.kind);

export function isExternalProvider(kind: string): boolean {
  return (EXTERNAL_PROVIDERS as readonly string[]).includes(kind);
}

export interface ToolResult {
  /** The id of the call this answers. */
  toolCallId: string;
  name: string;
  /** JSON text. The seam does not care what is inside it. */
  content: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Set on an assistant turn that asked for tools. Providers disagree wildly
   * about how a tool round-trip is represented on the wire — OpenAI uses a
   * separate `tool` role keyed by call id, Anthropic uses `tool_result` blocks
   * inside a user turn. Both are expressed here and translated by the adapter,
   * so an agent above this line never learns which dialect it is talking. */
  toolCalls?: ToolCall[];
  /** Set on the user turn that carries those calls' results. */
  toolResults?: ToolResult[];
  /** Images attached to THIS user turn, sent as real image content — never as
   * pre-extracted text pretending to be a description. Only the adapters that
   * were actually built to emit an image content block read this; every other
   * adapter ignores it, which is why the caller must check `Capabilities.vision`
   * before attaching anything here rather than relying on the adapter to say no. */
  images?: ChatImage[];
}

export interface ChatImage {
  /** e.g. 'image/png', 'image/jpeg'. Anthropic's vision API is picky about this
   * matching the actual bytes. */
  mediaType: string;
  /** Raw bytes, base64-encoded. Never a URL — CE does not ask a model provider
   * to fetch a second party's storage on our behalf. */
  base64: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Who is asking, carried with the request for providers that execute tools
 * OUT of process.
 *
 * HTTP providers ignore this entirely: their tool calls come back in the
 * response and are executed — and permission-checked — by the agent loop in
 * this process. A subscription (CLI) provider runs the loop inside the
 * vendor's own binary, so the identity has to travel with the request for the
 * out-of-process tool server to enforce the same step-up policy. Populated by
 * the agent from the authenticated session, never from a request body. */
export interface ToolContext {
  userId: string | null;
  sessionKey: string | null;
  threadId: string | null;
  /** Server-only durable execution capability forwarded to Josi's MCP server.
   * It is never model input and never accepted from a client request. */
  durableTurnId?: string | null;
  durableLeaseToken?: string | null;
  /** Latest authenticated user turn and server clock. The out-of-process MCP
   * server uses these to enforce relative calendar dates independently of the
   * model's absolute timestamps. */
  latestUserText?: string | null;
  effectiveNow?: string | null;
}

export interface ChatRequest {
  messages: ChatMessage[];
  system?: string;
  tools?: ToolDefinition[];
  toolContext?: ToolContext;
  /** Ask for a JSON object back. Providers differ wildly in how well they
   * honour this, which is exactly why the probe checks it. */
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A call completed by an out-of-process subscription harness. The result is
 * recorded by Josi's MCP server, not reconstructed from vendor CLI prose. */
export interface ExecutedToolCall extends ToolCall {
  result: unknown;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  /** Tool calls that ALREADY RAN before this response was assembled.
   *
   * Only the harness path sets this: a CLI provider's model runs its own tool
   * loop against Josi's MCP server, so by the time the subprocess exits the
   * calls are history, not requests. They are reported so the agent can show
   * what happened and the probe can verify a call genuinely reached us — and
   * they must NEVER be executed again by the caller. Pending calls that still
   * need executing stay in `toolCalls`, exactly as before. */
  executedToolCalls?: ExecutedToolCall[];
  usage: Usage;
  /** Wall-clock time for the call, recorded for self-hosted endpoints where
   * latency is the only cost signal there is. */
  latencyMs: number;
  /** What the provider said it charged, when it says anything at all. Almost
   * nobody does, which is why `estimated` exists downstream. */
  reportedCostUsd?: number;
}

/** What kind of failure this is.
 *
 * The point of the enum is that the answers are genuinely different: an
 * operator whose key was revoked needs to paste a new one, one who hit a quota
 * needs to pay someone, and one whose provider is down needs to wait. A single
 * "the model provider refused the request" tells all three of them nothing.
 *
 * `authentication` and `authorization` are separate for the same reason: a 401
 * means the credential is wrong, a 403 means it is right and this account may
 * not do this — usually a project or organization that does not have access to
 * the model. Those have different fixes and different people who can apply them. */
export type LlmErrorCategory =
  | 'authentication'
  | 'authorization'
  | 'model_unavailable'
  | 'rate_limit'
  | 'billing'
  | 'network'
  | 'malformed_request'
  | 'provider_outage'
  | 'unknown';

export class LlmError extends Error {
  /** The credential is wrong or revoked — reconnecting fixes it, retrying does
   * not. */
  needsReconfiguration = false;
  /** Rate limited or a transient server error. A fallback may be tried. */
  retryable = false;
  status?: number;
  category: LlmErrorCategory = 'unknown';
  /** The provider's own short code — `insufficient_quota`, `model_not_found`.
   *
   * Codes only. The provider's `message` field is never carried: they routinely
   * quote the request back, and the request contains the prompt. A code is an
   * enum member, so it is safe to show and worth showing. */
  providerCode?: string;

  constructor(
    message: string,
    init: Partial<Pick<LlmError, 'needsReconfiguration' | 'retryable' | 'status' | 'category' | 'providerCode'>> = {},
  ) {
    super(message);
    Object.assign(this, init);
  }
}

/** HTTP status plus the provider's own code, turned into one category.
 *
 * The code is consulted first where it disambiguates something the status
 * cannot: OpenAI answers 429 for both "you are going too fast" and "you have
 * run out of credit", and those are not the same problem. */
export function categorizeFailure(status: number, providerCode?: string): LlmErrorCategory {
  const code = (providerCode ?? '').toLowerCase();
  if (code.includes('insufficient_quota') || code.includes('billing') || code.includes('credit')) {
    return 'billing';
  }
  if (code.includes('model_not_found') || code.includes('unknown_model')) return 'model_unavailable';
  if (status === 401) return 'authentication';
  if (status === 402) return 'billing';
  if (status === 403) return 'authorization';
  if (status === 404) return 'model_unavailable';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 422) return 'malformed_request';
  if (status >= 500) return 'provider_outage';
  return 'unknown';
}

/** What to tell the operator, and what they can do about it. */
export function explainCategory(category: LlmErrorCategory): string {
  switch (category) {
    case 'authentication':
      return 'The provider rejected the credential. It is wrong, expired, or has been revoked — a new one is needed.';
    case 'authorization':
      return 'The credential is valid but this account may not use this model. Check the organization or project it belongs to, and whether that project has been granted access.';
    case 'model_unavailable':
      return 'The provider does not offer this model to this account. It may have been retired, or never been available on this plan.';
    case 'rate_limit':
      return 'The provider is rate limiting this installation. Waiting and trying again usually works.';
    case 'billing':
      return 'The account has no credit or its billing is not in order. This is fixed with the provider, not here.';
    case 'network':
      return 'The provider could not be reached from this server. Check outbound network access and DNS.';
    case 'malformed_request':
      return 'The provider rejected the shape of the request. This is a defect in Josi rather than in your configuration — please report it.';
    case 'provider_outage':
      return 'The provider had a server error. Nothing is wrong with this installation; try again shortly.';
    default:
      return 'The provider refused the request and did not say why in a way Josi could interpret.';
  }
}

export interface LlmProvider {
  kind: ProviderKind;
  model: string;
  /** True when this provider sends content off the server. */
  external: boolean;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

// ------------------------------------------------------------- capabilities

/** What a model was actually observed to do. Every field starts unknown and is
 * only set by a probe that ran — nothing here is inferred from the model name,
 * because a name is a marketing decision and this is a compatibility question. */
export interface Capabilities {
  chat: boolean;
  structuredOutput: boolean;
  toolCalling: boolean;
  /** Whether this model was actually SHOWN an image and answered a question
   * about it correctly. False by default — including for providers whose
   * adapter has no code path to send an image at all, such as the CLI
   * subscription harnesses, and for every model whose adapter does have one but
   * which has not yet been shown a picture.
   * Unproven is off, exactly like every other capability here. */
  vision: boolean;
  /** Context window in tokens, as reported or as demonstrated. Null when the
   * probe could not establish it. */
  contextTokens: number | null;
}

/** Features CE will not offer unless the underlying capability was proven.
 *
 * The mapping is deliberately explicit rather than computed: when a feature is
 * disabled the operator is told which capability was missing, and that sentence
 * has to come from somewhere. */
export interface FeatureGate {
  feature: string;
  requires: keyof Capabilities;
  /** Shown to the operator when the capability is absent. */
  explanation: string;
}

export const FEATURE_GATES: readonly FeatureGate[] = [
  {
    feature: 'assistant_chat',
    requires: 'chat',
    explanation: 'This model did not answer a basic message, so Josi cannot talk to anyone with it.',
  },
  {
    feature: 'task_extraction',
    requires: 'structuredOutput',
    explanation:
      'This model did not return valid JSON when asked, so Josi cannot reliably turn a conversation into a task.',
  },
  {
    feature: 'calendar_tools',
    requires: 'toolCalling',
    explanation:
      'This model does not support tool calling, so Josi cannot check availability or book on your behalf.',
  },
  {
    feature: 'email_tools',
    requires: 'toolCalling',
    explanation:
      'This model does not support tool calling, so Josi cannot search or draft email.',
  },
  {
    feature: 'document_search',
    requires: 'toolCalling',
    explanation:
      'This model does not support tool calling, so Josi cannot search your documents.',
  },
  {
    feature: 'chat_vision',
    requires: 'vision',
    explanation:
      'This model was not shown to understand images, so Josi will not guess what a picture shows. '
      + 'It will say plainly that it cannot see the attachment.',
  },
];

export interface DisabledFeature {
  feature: string;
  reason: string;
}

/** Which features are unavailable given what the probe found. */
export function disabledFeatures(capabilities: Capabilities | null): DisabledFeature[] {
  if (!capabilities) {
    // No probe has run. Everything dependent on a model is off — refusing is
    // honest, pretending is not.
    return FEATURE_GATES.map((g) => ({
      feature: g.feature,
      reason: 'No model has been tested yet, so Josi cannot promise this works.',
    }));
  }
  return FEATURE_GATES.filter((g) => !capabilities[g.requires]).map((g) => ({
    feature: g.feature,
    reason: g.explanation,
  }));
}

export function featureAvailable(feature: string, capabilities: Capabilities | null): boolean {
  return !disabledFeatures(capabilities).some((d) => d.feature === feature);
}
