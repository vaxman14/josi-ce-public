// Which models this account can actually use.
//
// The thing this replaces was a hardcoded list in the web app. It offered
// `gpt-5.6-terra` and `gpt-5.6-luna` to everyone, whether or not the account
// had ever been granted them, whether or not they existed — and an operator who
// picked one found out at the first real request, long after setup said it was
// configured.
//
// So the list is asked for. Every provider CE supports has a models endpoint,
// it is scoped to the credential presented, and that is the whole point: the
// answer is what THIS key on THIS organization may call, which is a question no
// catalog in this repository can answer.
//
// Two things are deliberately NOT done here:
//
//   * No model is called. Discovery lists; the probe proves. A model that
//     appears here has not been shown to work, and `activated_at` still gates
//     use on a real request succeeding.
//   * Nothing is invented. If a listing FAILS, this returns the failure and its
//     category. It never answers an authentication or billing problem with a
//     built-in list, because falling back to a guess is exactly the behaviour
//     being removed.
//
// V2.4 added the one case that is not a guess. Several providers have no
// listing interface at all — Vertex publishes the same catalogue to everyone
// rather than to a credential, Qianfan and Tencent list models through a
// console API the inference credential cannot reach. For those, and only those,
// a versioned list from `catalog.ts` is offered, flagged `fromCatalog` with the
// date it was last edited, and always accompanied by a field for typing in a
// name it does not contain. That is a different act from inventing a list for a
// provider that would have answered: the operator is told which kind of list
// they are looking at, and the probe still has to reach the model either way.
import {
  LlmError, categorizeFailure, explainCategory,
  type LlmErrorCategory, type ProviderKind,
} from './types.js';
import { safeFetch, UnsafeEndpointError, type SafeFetchOptions } from './ssrf.js';
import { safeErrorCode } from './providers/openaiCompatible.js';
import { CATALOG_VERSION, describeProvider, type CatalogModel, type ProviderDescriptor } from './catalog.js';
import { errorCodeFrom } from './providers/shared.js';
import { listGeminiModels } from './providers/gemini.js';
import { listCohereModels } from './providers/cohere.js';
import { listAzureDeployments } from './providers/azureAi.js';
import { listBedrockModels } from './providers/bedrock.js';
import { readServiceAccount, verifyVertexCredential } from './providers/vertexAi.js';
import { verifyErnieCredential } from './providers/ernie.js';
import { listCodexModels, type CodexListedModel } from './providers/codexModels.js';

export interface DiscoveredModel {
  /** Exactly what the provider calls it. This is what gets stored and sent. */
  id: string;
  /** A human-readable name, for the ordinary view. */
  label: string;
  /** The provider's own display name where it gave one, otherwise derived. */
  fromProvider: boolean;
  /** Josi's suggestion, not the provider's. Highest-capability first. */
  recommended: boolean;
  /** Set when the model is almost certainly not a chat model. Hidden from the
   * ordinary list and shown under "show everything". */
  likelyNonChat: boolean;
}

export interface DiscoveryResult {
  ok: boolean;
  models: DiscoveredModel[];
  /** Present when ok is false. */
  category?: LlmErrorCategory;
  message?: string;
  providerCode?: string;
  /** True when this provider has no listing interface at all, which is a
   * different thing from a listing that failed. */
  unsupported?: boolean;
  /** True when the models below came from Josi's own versioned catalogue
   * rather than from the provider.
   *
   * Surfaced rather than smoothed over. A list nobody asked the provider for
   * can be stale, and an operator deciding whether to trust it needs to know
   * which kind of list they are looking at. */
  fromCatalog?: boolean;
  /** When that catalogue was last edited, so "possibly stale" is a date rather
   * than a feeling. */
  catalogVersion?: string;
  /** Whether a name the provider did not list may be typed in. */
  allowsCustomModel?: boolean;
}

export interface DiscoverOptions {
  provider: ProviderKind;
  apiKey?: string | null;
  baseUrl?: string | null;
  /** The other secret fields a provider needs, by the key names the catalogue
   * declares — an AWS secret access key, a Baidu secret key, a Vertex service
   * account file. Used for the one listing call and never stored from here. */
  secrets?: Record<string, string>;
  /** The non-secret fields — a region, a project, an API version. */
  config?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolve?: SafeFetchOptions['resolve'];
  /** Override for tests; the live path asks the signed-in Codex app-server. */
  codexModelList?: () => Promise<CodexListedModel[]>;
  codexCommand?: string;
}

/** Model families that are not chat models, whatever else they are.
 *
 * OpenAI's `/models` returns everything the account can touch, which includes
 * embeddings, speech, transcription and image generation. Offering
 * `text-embedding-3-small` as the model Josi thinks with is worse than offering
 * nothing, so these are filtered out of the ordinary list.
 *
 * This IS a heuristic and it is labelled as one: a match sets `likelyNonChat`
 * rather than dropping the row, and the advanced view shows everything. A
 * future model whose name matches one of these patterns is hidden, not lost. */
const NON_CHAT = [
  /embedding/i, /^tts-/i, /^whisper/i, /^dall-e/i, /^gpt-image/i, /moderation/i,
  /^text-moderation/i, /-audio(-|$)/i, /-realtime(-|$)/i, /^omni-moderation/i,
  /^codex-mini/i, /-transcribe(-|$)/i, /^sora/i, /guard/i, /-tts(-|$)/i,
];

function looksNonChat(id: string): boolean {
  return NON_CHAT.some((p) => p.test(id));
}

/** A readable name for an identifier nobody chose for readability.
 *
 * Derived rather than looked up, because the ids are discovered: a table would
 * have an entry for every model that existed when it was written and nothing
 * for the one released last week, which is the failure this whole module is
 * about. */
export function humanizeModelId(id: string): string {
  return id
    .replace(/[-_]/g, ' ')
    .replace(/\bgpt\b/gi, 'GPT')
    .replace(/\bo(\d)\b/gi, 'o$1')
    .replace(/\bclaude\b/gi, 'Claude')
    .replace(/\bgrok\b/gi, 'Grok')
    .replace(/\bllama\b/gi, 'Llama')
    .replace(/\bmistral\b/gi, 'Mistral')
    .replace(/\bqwen\b/gi, 'Qwen')
    .replace(/\bdeepseek\b/gi, 'DeepSeek')
    .replace(/\bmini\b/gi, 'Mini')
    .replace(/\bnano\b/gi, 'Nano')
    .replace(/\bturbo\b/gi, 'Turbo')
    .replace(/\bopus\b/gi, 'Opus')
    .replace(/\bsonnet\b/gi, 'Sonnet')
    .replace(/\bhaiku\b/gi, 'Haiku')
    .replace(/\binstruct\b/gi, 'Instruct')
    .replace(/\blatest\b/gi, '(latest)')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Which of the discovered models to put at the top.
 *
 * A preference between real options, not a claim about what exists. If the
 * account has none of these, nothing is marked recommended and the list is
 * simply the list. */
const PREFERRED = [/opus/i, /sonnet/i, /^gpt-\d/i, /^o\d/i, /grok-\d/i];

function markRecommended(models: DiscoveredModel[]): void {
  const chat = models.filter((m) => !m.likelyNonChat);
  for (const pattern of PREFERRED) {
    const hit = chat.find((m) => pattern.test(m.id));
    if (hit) { hit.recommended = true; return; }
  }
}

interface ListRow { id?: unknown; display_name?: unknown }

function toModels(rows: ListRow[]): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const provided = typeof row.display_name === 'string' && row.display_name.trim()
      ? row.display_name.trim()
      : '';
    models.push({
      id,
      label: provided || humanizeModelId(id),
      fromProvider: !!provided,
      recommended: false,
      likelyNonChat: looksNonChat(id),
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  markRecommended(models);
  return models;
}

const failure = (
  category: LlmErrorCategory,
  message?: string,
  providerCode?: string,
): DiscoveryResult => ({ ok: false, models: [], category, message: message ?? explainCategory(category), providerCode });

/** The versioned list, for a provider that has none of its own. */
function fromCatalog(descriptor: ProviderDescriptor, message: string): DiscoveryResult {
  const models: CatalogModel[] = [...(descriptor.models ?? [])];
  return {
    ok: true,
    fromCatalog: true,
    catalogVersion: CATALOG_VERSION,
    allowsCustomModel: true,
    models: models.map((m) => ({
      id: m.id,
      label: m.label,
      // Not from the provider, and the flag says so rather than letting a
      // shipped list wear the authority of a discovered one.
      fromProvider: false,
      recommended: m.recommended === true,
      likelyNonChat: false,
    })),
    message,
  };
}

/** Ask the provider what this credential may use. */
export async function discoverModels(opts: DiscoverOptions): Promise<DiscoveryResult> {
  if (opts.provider === 'openai_subscription') {
    try {
      const listed = await (opts.codexModelList ?? (() => listCodexModels({ command: opts.codexCommand })))();
      const models: DiscoveredModel[] = listed.filter(row => !row.hidden).map(row => ({
        id: row.id,
        label: row.displayName || row.id,
        fromProvider: true,
        recommended: row.isDefault,
        likelyNonChat: false,
      }));
      return {
        ok: true,
        models,
        unsupported: models.length === 0,
        allowsCustomModel: true,
        message: models.length
          ? 'These choices are listed by the signed-in Codex CLI. Your plan may not run every one; Josi will test the selected model with a real request before activation.'
          : 'The Codex CLI returned no visible models. Automatic still works, or enter an exact model identifier; Josi will test it with a real request before activation.',
      };
    } catch {
      // Never forward CLI errors or credential-bearing output to a browser.
      return {
        ok: true,
        models: [],
        unsupported: true,
        allowsCustomModel: true,
        message: 'Could not list ChatGPT models from the Codex CLI. Automatic still works, or enter an exact model identifier; Josi will test it with a real request before activation.',
      };
    }
  }

  if (opts.provider === 'anthropic_subscription') {
    // There is no listing interface on the subscription path either — but
    // unlike Codex, the CLI DOES take a model, so claiming there is nothing to
    // choose would be false in the other direction.
    //
    // These are the aliases the CLI's own `--model` documents, not a catalogue
    // Josi discovered and not a guess at what a plan includes. Which of them a
    // particular Claude plan can actually reach is between the operator and
    // Anthropic, so nothing here is marked available: Josi confirms the one
    // that was chosen by making a real request, exactly as it does elsewhere.
    const aliases = [
      { id: 'opus', label: 'Opus — most capable' },
      { id: 'sonnet', label: 'Sonnet — balanced' },
      { id: 'haiku', label: 'Haiku — fastest' },
    ];
    return {
      ok: true,
      allowsCustomModel: true,
      models: aliases.map((a, index) => ({
        id: a.id,
        label: a.label,
        // These come from the CLI's documented aliases rather than from a
        // provider listing call, and the flag says so rather than implying an
        // API answered.
        fromProvider: false,
        recommended: index === 1,
        likelyNonChat: false,
      })),
      message:
        'These are the model aliases Claude Code accepts. A full model name works too. Which ones '
        + 'your plan can reach is between you and Anthropic — Josi will confirm your choice by '
        + 'making a real request.',
    };
  }

  const descriptor = describeProvider(opts.provider);
  if (!descriptor) {
    return failure('malformed_request', 'Josi does not know that model provider.');
  }

  const secrets = opts.secrets ?? {};
  const config = opts.config ?? {};
  const transport = {
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
    resolve: opts.resolve,
  };

  // A listing that needs its own request shape. Each returns raw rows plus the
  // status, so the failure handling below stays in one place rather than being
  // repeated per provider.
  type Listing = { status: number; body: string; rows: ListRow[] | null };
  let listing: Listing | null = null;

  try {
    switch (descriptor.wire) {
      case 'gemini':
        listing = await listGeminiModels({
          model: '', apiKey: opts.apiKey, baseUrl: opts.baseUrl, ...transport,
        });
        break;

      case 'cohere-v2':
        listing = await listCohereModels({
          model: '', apiKey: opts.apiKey, baseUrl: opts.baseUrl, ...transport,
        });
        break;

      case 'azure-openai':
        if (!opts.baseUrl) {
          return failure('malformed_request', 'Enter the endpoint of your Azure resource first.');
        }
        listing = await listAzureDeployments({
          model: '', apiKey: opts.apiKey, baseUrl: opts.baseUrl,
          apiVersion: config.apiVersion || null, ...transport,
        });
        break;

      case 'bedrock-converse':
        if (!config.region) {
          return failure('malformed_request', 'Choose the AWS region your model access is in first.');
        }
        listing = await listBedrockModels({
          region: config.region,
          credentials: {
            accessKeyId: secrets.accessKeyId ?? '',
            secretAccessKey: secrets.secretAccessKey ?? '',
            sessionToken: secrets.sessionToken || null,
          },
          ...transport,
        });
        break;

      case 'vertex-gemini':
        // Nothing to list, but the credential CAN be checked — and checking it
        // now is worth more than a longer list would be, because a service
        // account that cannot mint a token is the failure an operator would
        // otherwise meet after setup said it was configured.
        await verifyVertexCredential({
          model: '',
          project: config.project ?? '',
          location: config.location ?? '',
          serviceAccount: readServiceAccount(secrets.serviceAccountJson ?? ''),
          ...transport,
        });
        return fromCatalog(
          descriptor,
          'That service account works. Vertex offers the same published models to every project, so '
          + 'these are the ones Josi ships knowing about — a newer model name can be typed in, and '
          + 'Josi will confirm whichever you pick by making a real request.',
        );

      case 'ernie':
        await verifyErnieCredential({
          model: '', apiKey: opts.apiKey, secretKey: secrets.secretKey ?? null,
          baseUrl: opts.baseUrl, ...transport,
        });
        return fromCatalog(
          descriptor,
          'That key pair works. Qianfan lists models through its console rather than through this '
          + 'credential, so these are the ones Josi ships knowing about — the exact endpoint name '
          + 'from your console can be typed in instead.',
        );

      default:
        break;
    }
  } catch (err) {
    // A listing that threw rather than answering: an unusable credential, an
    // endpoint we will not go to, or a socket.
    if (err instanceof LlmError) {
      return failure(err.category, err.message, err.providerCode);
    }
    return failure('network');
  }

  if (listing) {
    if (!listing.rows) {
      const providerCode = errorCodeFrom(listing.body);
      const category = categorizeFailure(listing.status, providerCode);
      // A 2xx that could not be read is a provider whose listing Josi does not
      // understand, not a credential problem — and where a catalogue exists,
      // that is exactly what it is for.
      if (listing.status >= 200 && listing.status < 300) {
        if (descriptor.models?.length) {
          return fromCatalog(
            descriptor,
            'That provider did not answer with a model list Josi could read, so these are the ones '
            + 'it ships knowing about. A different name can be typed in.',
          );
        }
        return {
          ...failure('malformed_request', 'The endpoint answered, but not with a model list Josi could read.'),
          unsupported: true,
          allowsCustomModel: true,
        };
      }
      return failure(category, explainCategory(category), providerCode);
    }
    return { ok: true, models: toModels(listing.rows), allowsCustomModel: true };
  }

  // Providers with no listing interface and no special request shape.
  if (descriptor.discovery === 'catalog') {
    return fromCatalog(
      descriptor,
      'This provider does not publish a model list to your credential, so these are the ones Josi '
      + 'ships knowing about. A different name can be typed in, and Josi will confirm whichever you '
      + 'pick by making a real request.',
    );
  }

  // The OpenAI-shaped listing, which Anthropic and every compatible vendor also
  // answer. The base URL is the operator's where they gave one, so a regional
  // or self-hosted endpoint is asked rather than the vendor's default.
  const base = (opts.baseUrl || descriptor.defaultBaseUrl || '').replace(/\/$/, '');
  if (!base) {
    return failure('malformed_request', 'No endpoint is configured for this provider.');
  }

  const headers: Record<string, string> = {};
  if (descriptor.wire === 'anthropic-messages') {
    if (opts.apiKey) headers['x-api-key'] = opts.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  let res: Response;
  try {
    res = await safeFetch(`${base}/models`, { method: 'GET', headers }, {
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
      resolve: opts.resolve,
    });
  } catch (err) {
    if (err instanceof UnsafeEndpointError) {
      return failure('malformed_request', err.message);
    }
    return failure('network');
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const providerCode = safeErrorCode(text);
    const category = categorizeFailure(res.status, providerCode);
    return failure(category, explainCategory(category), providerCode);
  }

  let parsed: { data?: unknown; models?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return failure('malformed_request', 'The endpoint answered, but not with a model list Josi could read.');
  }

  // OpenAI, Anthropic and xAI all use `data`. Some self-hosted runtimes use
  // `models`. Anything else is a runtime that does not speak this API.
  const rows = Array.isArray(parsed.data) ? parsed.data
    : Array.isArray(parsed.models) ? parsed.models
    : null;
  if (!rows) {
    // Where the catalogue has something to offer, offer it and say where it
    // came from. Where it does not, say plainly that the endpoint does not
    // list models rather than showing an empty box.
    if (descriptor.models?.length) {
      return fromCatalog(
        descriptor,
        'That endpoint did not answer with a model list Josi could read, so these are the ones it '
        + 'ships knowing about. A different name can be typed in.',
      );
    }
    return {
      ...failure(
        'malformed_request',
        'The endpoint answered, but its reply is not an OpenAI-compatible model list.',
      ),
      unsupported: true,
      allowsCustomModel: true,
    };
  }

  return { ok: true, models: toModels(rows as ListRow[]), allowsCustomModel: true };
}

/** Turn a discovery failure into the error the rest of CE throws. */
export function discoveryError(result: DiscoveryResult): LlmError {
  return new LlmError(result.message ?? 'models could not be listed', {
    category: result.category ?? 'unknown',
    providerCode: result.providerCode,
    needsReconfiguration:
      result.category === 'authentication'
      || result.category === 'authorization'
      || result.category === 'billing',
    retryable: result.category === 'rate_limit' || result.category === 'provider_outage' || result.category === 'network',
  });
}
