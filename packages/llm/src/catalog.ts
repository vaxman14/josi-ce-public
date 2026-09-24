// What each provider IS, in one place.
//
// Before this file, "which providers exist" was answered in five places that
// had to agree: the `ProviderKind` union, a `KNOWN_PROVIDERS` array in the API
// routes, a `<select>` in the web form, a CHECK constraint in SQL, and a
// vocabulary map in the web app. They did not agree — `anthropic_subscription`
// shipped in code and reached a live installation before anyone wrote the
// migration that would let it be stored (0022). Adding fourteen providers to
// five hand-maintained lists would have reproduced that failure fourteen times.
//
// So the descriptor is the source. The routes derive their allowlist from it,
// the form renders its fields from it, the registry picks a wire format from
// it, and a test asserts the SQL constraint and the plain-language vocabulary
// against it. A provider that is not described here does not exist anywhere.
//
// What a descriptor deliberately does NOT claim: that the provider works. It
// says what shape a request takes and what credential to ask for. Whether the
// model answers is still decided by a real request in `probe.ts`, and
// `activated_at` still gates every call on that probe having passed. A row in
// this table is a wiring diagram, not a promise.
import type { ProviderKind } from './types.js';

/** How a request is actually put on the wire.
 *
 * Named for the API contract rather than the vendor, because the whole point
 * is that several vendors share one. `openai-chat` is the OpenAI
 * chat-completions shape; a vendor is only listed under it when its API
 * genuinely honours that contract for streaming, tools and structured output,
 * not merely when it advertises an "OpenAI-compatible endpoint". */
export type WireFormat =
  | 'openai-chat'
  | 'anthropic-messages'
  | 'gemini'
  | 'cohere-v2'
  | 'bedrock-converse'
  | 'azure-openai'
  | 'vertex-gemini'
  | 'ernie'
  | 'hunyuan'
  // Not HTTP at all: a first-party CLI run as a subprocess.
  | 'cli';

/** One thing the operator has to supply.
 *
 * `secret: true` fields are sealed with the installation master key and never
 * leave the server again — not to the admin page, not to an audit event, not
 * into an error message. `secret: false` fields are ordinary configuration
 * (a region, a project id) and are shown back so an operator can see what is
 * set. Getting that split wrong in the other direction is how an AWS region
 * ends up write-only and unreadable, so it is stated per field rather than
 * inferred from the name. */
export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
  /** Shown under the field. Says where to get the value, not what it is. */
  help?: string;
}

const API_KEY: CredentialField = {
  key: 'apiKey',
  label: 'API key',
  secret: true,
  required: true,
};

/** A model this provider is known to offer, for the providers that have no
 * listing interface.
 *
 * This is the fallback the roadmap allows and it is labelled as one everywhere
 * it surfaces: `fromProvider: false` on the discovery result, and a sentence in
 * the UI saying the list was not asked for. It is versioned so a stale entry is
 * a visible fact rather than a mystery, and every provider that uses it also
 * accepts a typed-in model name — a catalogue that cannot be overridden is the
 * `gpt-5.6-luna` failure again with more steps. */
export interface CatalogModel {
  id: string;
  label: string;
  recommended?: boolean;
}

/** Bumped whenever a `models` list below is edited. Surfaced to the operator
 * next to a catalogue-derived list so "this is what Josi shipped knowing" is
 * checkable against a date rather than assumed to be current. */
export const CATALOG_VERSION = '2026-09-08';

export interface ProviderDescriptor {
  kind: ProviderKind;
  /** What the vendor calls itself, spelled how the vendor spells it. */
  label: string;
  wire: WireFormat;
  /** True when request content leaves this server. Drives Local-only refusal
   * and the external-data acknowledgement, so it is a privacy decision rather
   * than a networking one: `openai_compatible` points at the operator's own
   * hardware and is the only false here. */
  external: boolean;
  /** Where requests go when the operator does not say. Absent for providers
   * whose endpoint is derived from their own configuration (a Bedrock region,
   * an Azure resource). */
  defaultBaseUrl?: string;
  /** Whether the operator may, must, or must not supply a base URL. `optional`
   * exists for the vendors that offer a regional or proxy endpoint — an
   * operator in a data-residency regime needs to point at their own region,
   * and refusing that would make the provider unusable for exactly the people
   * the roadmap added it for. */
  baseUrlMode: 'none' | 'optional' | 'required';
  fields: CredentialField[];
  /** `endpoint` — the provider lists models for this credential and Josi asks.
   *  `catalog` — no listing interface; the versioned list below is offered and
   *   a custom name is always accepted.
   *  `none` — the model is not Josi's to choose (a subscription CLI). */
  discovery: 'endpoint' | 'catalog' | 'none';
  models?: readonly CatalogModel[];
  /** What this provider calls the thing the operator picks. Almost always a
   * model; Azure routes by deployment name instead, and calling that "model"
   * in the form is how somebody ends up typing a model name into a field that
   * needs the deployment they created. */
  modelNoun?: string;
  /** Provider-specific facts an operator needs BEFORE data is sent — where the
   * request lands, what the vendor's terms do with it, what regional access it
   * requires. The roadmap requires these be surfaced during setup rather than
   * discovered afterwards, so they are content, not decoration. */
  residency: string;
  docsUrl: string;
}

const REGION: CredentialField = {
  key: 'region',
  label: 'Region',
  secret: false,
  required: true,
  placeholder: 'us-east-1',
  help: 'The region your model access was granted in. Requests never leave it.',
};

export const PROVIDERS: readonly ProviderDescriptor[] = [
  // ---------------------------------------------------------------- own hardware
  {
    kind: 'openai_compatible',
    label: 'A model on your own hardware',
    wire: 'openai-chat',
    external: false,
    baseUrlMode: 'required',
    fields: [{ ...API_KEY, required: false, label: 'API key (only if your server needs one)' }],
    discovery: 'endpoint',
    residency: 'Nothing leaves this server. Josi talks to the address you give it and nowhere else.',
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
  },

  // ---------------------------------------------------------------- key providers
  {
    kind: 'openai',
    label: 'OpenAI',
    wire: 'openai-chat',
    external: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrlMode: 'optional',
    fields: [API_KEY],
    discovery: 'endpoint',
    residency: 'Requests are processed by OpenAI under your OpenAI account\'s terms.',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
  },
  {
    kind: 'anthropic',
    label: 'Anthropic',
    wire: 'anthropic-messages',
    external: true,
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    baseUrlMode: 'optional',
    fields: [API_KEY],
    discovery: 'endpoint',
    residency: 'Requests are processed by Anthropic under your Anthropic account\'s terms.',
    docsUrl: 'https://docs.anthropic.com/en/api/messages',
  },
  {
    kind: 'xai',
    label: 'xAI',
    wire: 'openai-chat',
    external: true,
    defaultBaseUrl: 'https://api.x.ai/v1',
    baseUrlMode: 'optional',
    fields: [API_KEY],
    discovery: 'endpoint',
    residency: 'Requests are processed by xAI under your xAI account\'s terms.',
    docsUrl: 'https://docs.x.ai/docs/api-reference',
  },

  // ------------------------------------------------- genuinely OpenAI-shaped
  // Every provider in this group was placed here because its chat-completions
  // endpoint honours the contract Josi actually uses: `tools` with a nested
  // `function`, `tool_calls` back with a `tool` role keyed by call id, and
  // `response_format: {type:'json_object'}`. Where a vendor merely advertises
  // "OpenAI-compatible" but diverges on tools or structured output, it is NOT
  // here — it has its own adapter below. The probe is what confirms this per
  // model, so a vendor that regresses shows up as a failed capability rather
  // than as silently wrong output.
  {
    kind: 'deepseek',
    label: 'DeepSeek',
    wire: 'openai-chat',
    external: true,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    baseUrlMode: 'optional',
    fields: [API_KEY],
    discovery: 'endpoint',
    residency:
      'Requests are processed by DeepSeek on infrastructure in China under DeepSeek\'s terms. '
      + 'Check that against your own data-residency obligations before you send anything.',
    docsUrl: 'https://api-docs.deepseek.com/',
  },
  {
    kind: 'qwen',
    label: 'Alibaba Qwen',
    wire: 'openai-chat',
    external: true,
    // The international DashScope endpoint. An operator in mainland China wants
    // `https://dashscope.aliyuncs.com/compatible-mode/v1` instead, which is why
    // the base URL stays editable rather than being pinned.
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    baseUrlMode: 'optional',
    fields: [API_KEY],
    discovery: 'endpoint',
    models: [
      { id: 'qwen-max', label: 'Qwen Max', recommended: true },
      { id: 'qwen-plus', label: 'Qwen Plus' },
      { id: 'qwen-turbo', label: 'Qwen Turbo' },
    ],
    residency:
      'Requests are processed by Alibaba Cloud under your DashScope account\'s terms. Which region '
      + 'they land in is decided by the endpoint above — the default is the international one.',
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope',
  },
  {
    kind: 'mistral',
    label: 'Mistral',
    wire: 'openai-chat',
    external: true,
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    baseUrlMode: 'optional',
    fields: [API_KEY],
    discovery: 'endpoint',
    residency: 'Requests are processed by Mistral AI in the EU under your Mistral account\'s terms.',
    docsUrl: 'https://docs.mistral.ai/api/',
  },
  {
    kind: 'moonshot',
    label: 'Moonshot (Kimi)',
    wire: 'openai-chat',
    external: true,
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    baseUrlMode: 'optional',
    fields: [API_KEY],
    discovery: 'endpoint',
    residency:
      'Requests are processed by Moonshot AI under your Moonshot account\'s terms. The default '
      + 'endpoint is the international one; the mainland China endpoint is api.moonshot.cn.',
    docsUrl: 'https://platform.moonshot.ai/docs/api/chat',
  },
  {
    kind: 'zhipu',
    label: 'Zhipu GLM',
    wire: 'openai-chat',
    external: true,
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    baseUrlMode: 'optional',
    fields: [API_KEY],
    discovery: 'endpoint',
    models: [
      { id: 'glm-4.6', label: 'GLM-4.6', recommended: true },
      { id: 'glm-4.5', label: 'GLM-4.5' },
      { id: 'glm-4.5-air', label: 'GLM-4.5-Air' },
      { id: 'glm-4-plus', label: 'GLM-4-Plus' },
      { id: 'glm-4-flash', label: 'GLM-4-Flash' },
    ],
    residency:
      'Requests are processed by Zhipu AI on infrastructure in China under Zhipu\'s terms. Check '
      + 'that against your own data-residency obligations before you send anything.',
    docsUrl: 'https://docs.bigmodel.cn/en/guide/develop/openai/introduction',
  },
  {
    kind: 'openrouter',
    label: 'OpenRouter',
    wire: 'openai-chat',
    external: true,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    baseUrlMode: 'optional',
    fields: [API_KEY],
    discovery: 'endpoint',
    residency:
      'OpenRouter is a broker, not the model\'s operator: it forwards each request to whichever '
      + 'upstream provider serves the model you pick, and that provider\'s terms and country apply '
      + 'as well as OpenRouter\'s. Josi cannot tell you which one that is — the model name can.',
    docsUrl: 'https://openrouter.ai/docs/api-reference/overview',
  },
  {
    kind: 'minimax',
    label: 'MiniMax',
    wire: 'openai-chat',
    external: true,
    defaultBaseUrl: 'https://api.minimax.io/v1',
    baseUrlMode: 'optional',
    fields: [API_KEY],
    discovery: 'catalog',
    models: [
      { id: 'MiniMax-Text-01', label: 'MiniMax-Text-01', recommended: true },
      { id: 'abab6.5s-chat', label: 'abab6.5s-chat' },
    ],
    residency:
      'Requests are processed by MiniMax under your MiniMax account\'s terms. The default endpoint '
      + 'is the international one; the mainland China endpoint is api.minimax.chat.',
    docsUrl: 'https://www.minimax.io/platform/document/ChatCompletion',
  },

  // -------------------------------------------------------- dedicated adapters
  // Everything below has its own adapter because its contract genuinely differs
  // — a different auth scheme, a different request body, a different way of
  // saying "call this tool". Routing them through the OpenAI adapter with a
  // changed base URL is the "compatibility shim presented as native support"
  // the roadmap forbids, and it fails at exactly the moment a user asks for
  // something that needs a tool.
  {
    kind: 'gemini',
    label: 'Google Gemini',
    wire: 'gemini',
    external: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    baseUrlMode: 'optional',
    fields: [{ ...API_KEY, help: 'From Google AI Studio. Not a Google Cloud service account.' }],
    discovery: 'endpoint',
    residency:
      'Requests are processed by Google under the Gemini API terms. The free tier is explicitly '
      + 'used to improve Google\'s products; a paid tier is not. Which one you are on is set at '
      + 'Google, not here.',
    docsUrl: 'https://ai.google.dev/api/generate-content',
  },
  {
    kind: 'cohere',
    label: 'Cohere',
    wire: 'cohere-v2',
    external: true,
    defaultBaseUrl: 'https://api.cohere.com',
    baseUrlMode: 'optional',
    fields: [API_KEY],
    discovery: 'endpoint',
    residency: 'Requests are processed by Cohere under your Cohere account\'s terms.',
    docsUrl: 'https://docs.cohere.com/reference/chat',
  },
  {
    kind: 'bedrock',
    label: 'AWS Bedrock',
    wire: 'bedrock-converse',
    external: true,
    // Derived from the region: bedrock-runtime.<region>.amazonaws.com.
    baseUrlMode: 'none',
    fields: [
      REGION,
      { key: 'accessKeyId', label: 'Access key ID', secret: true, required: true },
      { key: 'secretAccessKey', label: 'Secret access key', secret: true, required: true },
      {
        key: 'sessionToken',
        label: 'Session token',
        secret: true,
        required: false,
        help: 'Only for temporary credentials. Leave empty for a long-lived IAM user.',
      },
    ],
    discovery: 'endpoint',
    residency:
      'Requests stay in the AWS region you name and are processed under your own AWS agreement. '
      + 'Bedrock does not use your prompts to train the base models. Each model still has to be '
      + 'granted to your account in that region before it will answer.',
    docsUrl: 'https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html',
  },
  {
    kind: 'azure_ai',
    label: 'Azure AI',
    wire: 'azure-openai',
    external: true,
    // The operator's own resource. There is no shared default host.
    baseUrlMode: 'required',
    fields: [
      { ...API_KEY, label: 'Key', help: 'Key 1 or Key 2 from your resource\'s Keys and Endpoint page.' },
      {
        key: 'apiVersion',
        label: 'API version',
        secret: false,
        required: false,
        placeholder: '2024-10-21',
        help: 'Leave empty to use the version Josi was built against.',
      },
    ],
    // What Azure lists — and what the model field holds — is a DEPLOYMENT name,
    // because that is what routes a request there. It is often but not always
    // the same string as the underlying model, so Josi asks the resource rather
    // than assuming, and the form says which of the two it is showing.
    discovery: 'endpoint',
    modelNoun: 'deployment',
    residency:
      'Requests stay in the region of your own Azure resource and are processed under your Azure '
      + 'agreement. Azure\'s abuse monitoring may retain prompts for up to thirty days unless your '
      + 'subscription has been approved for the modified-abuse-monitoring exemption.',
    docsUrl: 'https://learn.microsoft.com/azure/ai-services/openai/reference',
  },
  {
    kind: 'vertex_ai',
    label: 'Google Vertex AI',
    wire: 'vertex-gemini',
    external: true,
    baseUrlMode: 'none',
    fields: [
      { key: 'project', label: 'Project ID', secret: false, required: true, placeholder: 'my-project-123456' },
      {
        key: 'location',
        label: 'Location',
        secret: false,
        required: true,
        placeholder: 'us-central1',
        help: 'The region your model access was granted in. Requests never leave it.',
      },
      {
        key: 'serviceAccountJson',
        label: 'Service account key (JSON)',
        secret: true,
        required: true,
        help:
          'The whole JSON file for a service account with the Vertex AI User role. Josi uses it to '
          + 'mint short-lived tokens and never sends it anywhere.',
      },
    ],
    // Vertex does publish a publisher-model listing, but it enumerates every
    // model Google offers rather than the ones this project may call, which is
    // the "offer things the account cannot use" failure discovery exists to
    // stop. A short versioned list plus a typed-in name tells the truth instead.
    discovery: 'catalog',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', recommended: true },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
    ],
    residency:
      'Requests stay in the Google Cloud region you name and are processed under your own Google '
      + 'Cloud agreement. Vertex AI does not use your prompts to train Google\'s models.',
    docsUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference',
  },
  {
    kind: 'ernie',
    label: 'Baidu ERNIE',
    wire: 'ernie',
    external: true,
    defaultBaseUrl: 'https://aip.baidubce.com',
    baseUrlMode: 'optional',
    fields: [
      { ...API_KEY, label: 'API key', help: 'The API Key of your Qianfan application.' },
      { key: 'secretKey', label: 'Secret key', secret: true, required: true },
    ],
    // Qianfan lists models through the console API rather than the inference
    // credential, so this credential cannot ask. Versioned list plus a typed-in
    // endpoint name, which is what the operator reads off the console anyway.
    discovery: 'catalog',
    models: [
      { id: 'ernie-4.5-turbo-128k', label: 'ERNIE 4.5 Turbo 128K', recommended: true },
      { id: 'ernie-4.0-8k', label: 'ERNIE 4.0 8K' },
      { id: 'ernie-3.5-8k', label: 'ERNIE 3.5 8K' },
      { id: 'ernie-speed-128k', label: 'ERNIE Speed 128K' },
    ],
    residency:
      'Requests are processed by Baidu on infrastructure in China under Baidu Qianfan\'s terms. '
      + 'Check that against your own data-residency obligations before you send anything.',
    docsUrl: 'https://cloud.baidu.com/doc/WENXINWORKSHOP/s/jlil56u11',
  },
  {
    kind: 'hunyuan',
    label: 'Tencent Hunyuan',
    wire: 'hunyuan',
    external: true,
    // Tencent Cloud's signed API host. Not a base path an operator edits.
    baseUrlMode: 'none',
    fields: [
      { key: 'secretId', label: 'Secret ID', secret: true, required: true },
      { key: 'secretKey', label: 'Secret key', secret: true, required: true },
      {
        key: 'region',
        label: 'Region',
        secret: false,
        required: false,
        placeholder: 'ap-guangzhou',
        help: 'Optional. Hunyuan is served globally; leave empty unless Tencent told you otherwise.',
      },
    ],
    discovery: 'catalog',
    models: [
      { id: 'hunyuan-turbos-latest', label: 'Hunyuan TurboS', recommended: true },
      { id: 'hunyuan-large', label: 'Hunyuan Large' },
      { id: 'hunyuan-standard', label: 'Hunyuan Standard' },
      { id: 'hunyuan-lite', label: 'Hunyuan Lite' },
    ],
    residency:
      'Requests are processed by Tencent Cloud on infrastructure in China under Tencent\'s terms. '
      + 'Check that against your own data-residency obligations before you send anything.',
    docsUrl: 'https://www.tencentcloud.com/document/product/1729/105701',
  },

  // ------------------------------------------------------------- subscriptions
  // No HTTP request is made by CE on these paths at all: the operator's own
  // first-party CLI is run as a subprocess and holds its own login. They are
  // described here so the one allowlist covers them, but their availability is
  // still gated by the edition capability rather than by this table.
  {
    kind: 'openai_subscription',
    label: 'My ChatGPT plan (no API key)',
    wire: 'cli',
    external: true,
    baseUrlMode: 'none',
    fields: [],
    discovery: 'none',
    residency:
      'Runs OpenAI\'s own Codex CLI on this server, signed in as you. The conversation still reaches '
      + 'OpenAI — by way of their binary rather than ours, which changes who holds the credential '
      + 'and changes nothing about where the words go.',
    docsUrl: 'https://developers.openai.com/codex/cli/',
  },
  {
    kind: 'anthropic_subscription',
    label: 'My Claude plan (no API key)',
    wire: 'cli',
    external: true,
    baseUrlMode: 'none',
    fields: [],
    discovery: 'none',
    residency:
      'Runs Anthropic\'s own Claude Code CLI on this server, signed in as you. The conversation '
      + 'still reaches Anthropic — by way of their binary rather than ours.',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/overview',
  },
];

const BY_KIND = new Map<string, ProviderDescriptor>(PROVIDERS.map((p) => [p.kind, p]));

/** The descriptor for a kind, or null when the name is not one Josi knows.
 *
 * Null rather than a throw: the callers are route handlers validating a request
 * body, and an unknown provider name is a 400, not a crash. */
export function describeProvider(kind: string): ProviderDescriptor | null {
  return BY_KIND.get(kind) ?? null;
}

/** Every provider kind, in the order the form should offer them. */
export function allProviderKinds(): ProviderKind[] {
  return PROVIDERS.map((p) => p.kind);
}

/** The fields the operator must fill in, split by where the value is stored.
 *
 * Used by the save route to decide what to seal and what to write as ordinary
 * configuration, and by the form to decide what to render. One function so the
 * two cannot disagree about which half a value belongs in. */
export function credentialFields(kind: string): { secret: CredentialField[]; config: CredentialField[] } {
  const d = describeProvider(kind);
  if (!d) return { secret: [], config: [] };
  return {
    secret: d.fields.filter((f) => f.secret),
    config: d.fields.filter((f) => !f.secret),
  };
}

/** Whether an operator may type a model name this provider did not list.
 *
 * True wherever Josi cannot prove the list is complete — a catalogue, or an
 * endpoint whose listing failed. A model typed in here is not treated as
 * verified: the probe still has to reach it before `activated_at` is set. */
export function allowsCustomModel(kind: string): boolean {
  const d = describeProvider(kind);
  if (!d) return false;
  return d.discovery !== 'none';
}
