// Model configuration, capability probing, spending caps and usage.
//
// Two routers, split by what they are allowed to reveal:
//
//   * The admin router configures the installation. It never returns a key, a
//     prompt, or a reply — only whether a key is set and what a probe observed.
//   * The member router answers one question: what can Josi do for me right
//     now, and how much of my own allowance is left. A member cannot see the
//     provider's key, the workspace's other members' usage, or the caps of
//     anyone but themselves.
//
// Every rule that decides whether a model may be called lives in
// packages/llm/src/registry.ts, not here. A route is a bad place for a security
// control: the next route forgets it.
import { Router, type Request, type Response } from 'express';
import {
  appendEvent, asSecret, json, loadMasterKey, openCredentialPayload, storeCredentialPayload,
  type Db, type LoadOptions, type MasterKey,
} from '@josi-ce/core';
import {
  UnsafeEndpointError, buildProvider, capabilitiesOf, checkCaps, disabledFeatures, discoverModels,
  isExternalProvider, isLocalOnly, isSubscriptionProvider, loadStoredProvider, meteredProvider,
  probeProvider, usageSummary, validateEndpoint, LlmError, DEFAULT_CLAUDE_COMMAND,
  DEFAULT_CODEX_COMMAND, DeviceLogin, codexLoginStatus, codexLogout,
  PROVIDERS, credentialFields, describeProvider,
} from '@josi-ce/llm';
import { describeEdition, hasCapability } from '@josi-ce/core';
import { asyncRoute, param } from './async.js';
import { claudeSubscriptionRouter } from './claudeSubscriptionRoutes.js';
import { assertMetadataOnly, requireAuth, requireSuperAdmin } from './authz.js';

export interface LlmRoutesCtx {
  db: Db;
  masterKey?: LoadOptions | false;
  /** Injected in tests so no provider is ever contacted by the suite. */
  fetchImpl?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
  /** Injected in tests so no suite ever executes the Codex binary. */
  codexRunner?: import('@josi-ce/llm').SpawnRunner;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** jsonb that should be a list, made into one no matter how it was stored. */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
/** Every provider that is not gated behind an edition capability.
 *
 * Derived from the catalogue rather than typed out. The hand-maintained version
 * of this array is why `anthropic_subscription` could be chosen in the UI
 * before the database would accept it, and why the fix needed migration 0022.
 * A provider added to `catalog.ts` is savable here the moment its migration
 * lands, and a provider removed from it stops being savable everywhere at once. */
const KNOWN_PROVIDERS = PROVIDERS
  .filter((p) => p.wire !== 'cli')
  .map((p) => p.kind as string);

/** One administrator-driven Codex login at a time. This is a live child
 * process, so persisting it would create a database row that lies after a
 * restart. A restart during login only costs one fresh pairing code. */
let adminCodexLogin: DeviceLogin | null = null;

function codexEnv() {
  return { codexHome: process.env.CODEX_HOME ?? null };
}

/** Providers that exist only on a build whose edition permits them.
 *
 * Kept out of `KNOWN_PROVIDERS` so a hosted build's provider list does not even
 * mention them — and so `savableProviders()` below is the ONE place the two
 * lists are joined. */
export const CAPABILITY_PROVIDERS: Array<{ provider: string; capability: 'subscription_auth' }> = [
  { provider: 'openai_subscription', capability: 'subscription_auth' },
  { provider: 'anthropic_subscription', capability: 'subscription_auth' },
];

/** The catalogue as the admin form needs it.
 *
 * Everything here is metadata — labels, which fields to render, where requests
 * go. No credential and nothing derived from one. The subscription entries are
 * filtered by the edition capability for the same reason `savableProviders()`
 * filters them: a hosted build should not confirm that the option exists
 * somewhere, so the form never learns to draw it.
 *
 * Sent with the page rather than fetched separately, so the form cannot render
 * a provider the server would then refuse to save. */
export function providerCatalog(): Array<Record<string, unknown>> {
  const gated = new Map(CAPABILITY_PROVIDERS.map((p) => [p.provider, p.capability]));
  return PROVIDERS
    .filter((p) => {
      const capability = gated.get(p.kind);
      return !capability || hasCapability(capability);
    })
    .map((p) => ({
      kind: p.kind,
      label: p.label,
      external: p.external,
      baseUrlMode: p.baseUrlMode,
      defaultBaseUrl: p.defaultBaseUrl ?? null,
      // The secret flag travels so the form knows to use a password field and
      // to leave the value out of anything it echoes back.
      fields: p.fields.map((f) => ({
        key: f.key,
        label: f.label,
        secret: f.secret,
        required: f.required,
        placeholder: f.placeholder ?? null,
        help: f.help ?? null,
      })),
      discovery: p.discovery,
      modelNoun: p.modelNoun ?? 'model',
      residency: p.residency,
      docsUrl: p.docsUrl,
    }));
}

export function savableProviders(): string[] {
  return [
    ...KNOWN_PROVIDERS,
    ...CAPABILITY_PROVIDERS.filter((p) => hasCapability(p.capability)).map((p) => p.provider),
  ];
}

/** The credential fields for one provider, pulled out of a request body.
 *
 * Which fields exist, and which half each belongs in, is the catalogue's
 * answer rather than this route's — so a provider that needs a region and a key
 * pair is handled by the same code as one that needs an API key, and adding a
 * provider does not mean editing this function.
 *
 * Secrets stay wrapped in `Secret` the whole way: `seal` unwraps them, and
 * nothing here ever calls reveal(). */
export function readCredentials(kind: string, body: Record<string, unknown>) {
  const { secret, config } = credentialFields(kind);
  const secrets: Record<string, ReturnType<typeof asSecret>> = {};
  for (const field of secret) {
    secrets[field.key] = asSecret(body[field.key]);
  }
  const settings: Record<string, string> = {};
  for (const field of config) {
    const value = str(body[field.key], 200);
    if (value) settings[field.key] = value;
  }
  return { secrets, settings, secretFields: secret, configFields: config };
}

/** Reveals the secrets for ONE listing call.
 *
 * Discovery has to present the credential to the provider, so there is no way
 * around revealing it here. It is used for the request and nothing else — not
 * stored, not logged, not echoed — which is the same contract the single
 * `apiKey` path had before there were several. */
export function revealForDiscovery(secrets: Record<string, ReturnType<typeof asSecret>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (!value.isEmpty) out[key] = value.reveal();
  }
  return out;
}

function requireMasterKey(ctx: LlmRoutesCtx): MasterKey {
  if (ctx.masterKey === false) throw new RouteError(503, 'this installation cannot store secrets right now');
  try {
    return loadMasterKey(ctx.masterKey ?? {});
  } catch {
    // The loader's message names a filesystem path. The operator gets the
    // actionable half without it.
    throw new RouteError(
      503,
      'the installation master key is missing or unusable, so nothing can be saved securely.',
    );
  }
}

/**
 * M83, revisited in Phase 13.3 after re-reading both providers' current terms.
 *
 * The August 2026 answer was "no compliant path exists" for all three, and half
 * of that has changed. So the list is no longer a blanket refusal: each entry
 * carries what is actually true of that provider today, with the reason and the
 * date, and only the one with a real supported path is offered.
 *
 * Sources are recorded in `docs/SUBSCRIPTION_AUTH.md` rather than in a code
 * comment nobody re-checks.
 */
export function subscriptionOptions(): Array<{
  id: string; label: string; available: boolean; provider: string | null; reason: string;
}> {
  const ceOnly = hasCapability('subscription_auth');
  return [
    {
      id: 'chatgpt_subscription',
      label: 'Use my ChatGPT plan through the Codex CLI',
      provider: 'openai_subscription',
      available: ceOnly,
      reason: ceOnly
        ? 'Josi runs OpenAI\'s own Codex CLI on this machine, signed in as you. Josi never sees, '
          + 'stores or forwards your login. It is per installation rather than per person, it '
          + 'shares your own Codex usage limits, and it reports no token counts or cost. Tools '
          + 'work on this path once the model test confirms them.'
        // The honest sentence for a build that is not CE. It names the reason
        // as a licence boundary rather than implying a missing feature.
        : 'OpenAI permits a personal ChatGPT plan to be used for individual productivity and not '
          + 'to power a commercial service. This build is not a Community Edition installation, '
          + 'so it cannot offer it.',
    },
    {
      id: 'claude_subscription',
      label: 'Use my Claude subscription through Claude Code',
      provider: 'anthropic_subscription',
      available: ceOnly,
      // The previous entry here said Anthropic forbids this outright. Re-reading
      // the current terms showed that what is forbidden is a third party
      // implementing Claude.ai login or intermediating credentials — shipping
      // the unmodified first-party binary and letting the user authenticate
      // through Anthropic's own flow is the documented arrangement. FI-006.
      reason: ceOnly
        ? 'Josi runs Anthropic\'s own Claude Code CLI on this machine, signed in as you through '
          + 'Anthropic\'s own sign-in. Josi never sees, stores or forwards your login — it shows '
          + 'you the link and carries the one-time code you bring back. It is per installation '
          + 'rather than per person, and it shares your own Claude usage limits. Tools work on '
          + 'this path once the model test confirms them.'
        : 'A personal Claude plan is licensed for an individual rather than for powering a '
          + 'commercial service. This build is not a Community Edition installation, so it cannot '
          + 'offer it. An Anthropic API key works on any build.',
    },
    // GitHub Copilot is deliberately NOT in this list any more. It used to
    // appear as a permanently-unavailable entry; a choice that can never be
    // chosen is noise, and the decision (2026-09-02) was to drop it entirely
    // rather than keep explaining it.
  ];
}

/** The non-secret settings for a provider, and nothing else.
 *
 * An allowlist, not a denylist: fields are kept because the catalogue says they
 * are configuration, rather than dropped because their name looked like a
 * credential. A field nobody declared does not come out. */
export function publicConfig(
  kind: string,
  stored: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!stored || typeof stored !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const field of credentialFields(kind).config) {
    const value = stored[field.key];
    if (typeof value === 'string' && value) out[field.key] = value;
  }
  return out;
}

interface ProviderDto {
  role: 'primary' | 'fallback';
  provider: string;
  model: string;
  baseUrl: string | null;
  /** Whether a key is stored. Never the key, never its length or prefix. */
  apiKeySet: boolean;
  /** The non-secret settings — region, project, API version.
   *
   * Shown back on purpose. An operator has to be able to see which AWS region
   * their conversations are being sent to, and a write-only region is a support
   * conversation waiting to happen. Nothing sealed is ever in here: the split is
   * declared per field in the catalogue, and `readCredentials` sorts by it. */
  providerConfig: Record<string, unknown>;
  external: boolean;
  externalAcknowledged: boolean;
  active: boolean;
  probedAt: string | null;
  capabilities: ReturnType<typeof capabilitiesOf>;
  probeSteps: unknown;
}

async function providerDto(db: Db, role: 'primary' | 'fallback'): Promise<ProviderDto | null> {
  const stored = await loadStoredProvider(db, role);
  if (!stored) return null;
  const [steps] = await db.query<{ probe_steps: unknown }>(
    `select probe_steps from llm_providers where role = $1`,
    [role],
  );
  const dto: ProviderDto = {
    role,
    provider: stored.provider,
    model: stored.model,
    baseUrl: stored.base_url,
    apiKeySet: !!stored.api_key_enc,
    // Projected through the catalogue rather than served as stored. Only the
    // fields THIS provider declares non-secret come out, so a key that reached
    // the column by any route other than `readCredentials` — a hand-edited row,
    // a future bug — is dropped here instead of being handed to a screen.
    providerConfig: publicConfig(stored.provider, stored.provider_config),
    external: isExternalProvider(stored.provider),
    externalAcknowledged: stored.external_acknowledged,
    active: !!stored.activated_at,
    probedAt: stored.probed_at,
    capabilities: capabilitiesOf(stored),
    // Normalised here as well: a row written before the fix above, or by any
    // other means, must not reach a caller as something that is not a list.
    probeSteps: asArray(steps?.probe_steps),
  };
  // Belt and braces: a careless `...stored` spread added later throws here
  // rather than serialising the sealed key.
  assertMetadataOnly(dto as unknown as Record<string, unknown>);
  return dto;
}

// ------------------------------------------------------------------- admin

export function adminLlmRoutes(ctx: LlmRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireSuperAdmin);

  /** Turns the two expected refusals into responses an operator can act on, and
   * lets anything unexpected reach the error handler — which says nothing at
   * all, because an unexpected error's message is not ours to publish. */
  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    asyncRoute(async (req: Request, res: Response) => {
      try {
        return await fn(req, res);
      } catch (err: unknown) {
        if (err instanceof RouteError) return res.status(err.status).json({ error: err.message });
        if (err instanceof UnsafeEndpointError) return res.status(400).json({ error: err.message });
        throw err;
      }
    });

  r.get(
    '/',
    handle(async (_req, res) => {
      const primary = await providerDto(db, 'primary');
      const [caps] = await db.query(
        `select monthly_cost_usd, monthly_tokens from llm_caps where id = true`,
      );
      return res.json({
        primary,
        fallback: await providerDto(db, 'fallback'),
        localOnly: await isLocalOnly(db),
        // What CE will and will not do right now, with the reason attached.
        disabledFeatures: disabledFeatures(primary?.capabilities ?? null),
        caps,
        providerCatalog: providerCatalog(),
        subscriptionOptions: subscriptionOptions(),
        // What this build is, so the screen can explain a refusal rather than
        // showing a control that silently does nothing.
        edition: describeEdition(),
      });
    }),
  );

  /** Model discovery for a credential that has not been stored yet — the same
   * question the wizard asks, answerable after installation too. Without it
   * the admin page could not offer the full provider form, and the first
   * choice made during setup became a trap. The key comes from the request,
   * is used for the one listing call, and is never written or echoed. */
  r.post(
    '/models',
    handle(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const provider = str(body.provider, 32);
      if (!savableProviders().includes(provider)) {
        throw new RouteError(400, 'choose a model provider');
      }
      const { secrets, settings } = readCredentials(provider, body);
      const revealed = revealForDiscovery(secrets);
      const result = await discoverModels({
        provider: provider as never,
        apiKey: revealed.apiKey ?? null,
        baseUrl: str(body.baseUrl, 500) || null,
        secrets: revealed,
        config: settings,
        fetchImpl: ctx.fetchImpl,
        resolve: ctx.resolve,
      });
      return res.json({
        ok: result.ok,
        unsupported: !!result.unsupported,
        models: result.models,
        category: result.category ?? null,
        message: result.message ?? null,
        providerCode: result.providerCode ?? null,
        // Whether this list came from the provider or from Josi's own versioned
        // catalogue, and when that catalogue was last edited. The operator is
        // told which kind of list they are looking at rather than being left to
        // assume the provider answered.
        fromCatalog: !!result.fromCatalog,
        catalogVersion: result.catalogVersion ?? null,
        allowsCustomModel: !!result.allowsCustomModel,
      });
    }),
  );

  // The setup wizard has the same first-party device flow, but its routes are
  // intentionally gone after installation. Administrators still need to sign
  // in, reconnect, inspect status and sign out from the Model page.
  if (hasCapability('subscription_auth')) {
    r.get('/subscription/status', asyncRoute(async (_req, res) => {
      return res.json({ cli: await codexLoginStatus(codexEnv()) });
    }));

    r.post('/subscription/login', asyncRoute(async (_req, res) => {
      if (adminCodexLogin?.running) adminCodexLogin.cancel();
      adminCodexLogin = new DeviceLogin(codexEnv());
      return res.json(await adminCodexLogin.start());
    }));

    r.get('/subscription/login', asyncRoute(async (_req, res) => {
      if (!adminCodexLogin) {
        return res.json({ state: 'idle', challenge: null, expiresAt: null, message: null });
      }
      const snapshot = adminCodexLogin.status;
      if (snapshot.state === 'signed_in') {
        const status = await codexLoginStatus(codexEnv());
        if (!status.signedIn) {
          return res.json({
            state: 'failed', challenge: null, expiresAt: null,
            message: 'The sign-in reported success but Codex is still not signed in. Try again.',
          });
        }
      }
      return res.json(snapshot);
    }));

    r.post('/subscription/login/cancel', asyncRoute(async (_req, res) => {
      adminCodexLogin?.cancel();
      return res.json({ ok: true });
    }));

    r.post('/subscription/logout', asyncRoute(async (_req, res) => {
      adminCodexLogin?.cancel();
      adminCodexLogin = null;
      return res.json(await codexLogout(codexEnv()));
    }));

    // Claude, on its own prefix. Not a parameter on the routes above because
    // the flows genuinely differ: Anthropic's CLI blocks on stdin for a code
    // the operator pastes back, so it needs a route that writes.
    r.use('/subscription/claude', claudeSubscriptionRouter());
  }

  /** Configure a provider.
   *
   * Saving ALWAYS clears the probe result and deactivates. A model that was
   * proven to call tools yesterday says nothing about the one whose name was
   * just typed in — and leaving the old capabilities attached would silently
   * re-enable features against an untested model. */
  r.put(
    '/providers/:role',
    handle(async (req, res) => {
      const role = param(req, 'role');
      if (role !== 'primary' && role !== 'fallback') throw new RouteError(404, 'no such provider slot');

      const body = (req.body ?? {}) as Record<string, unknown>;
      const provider = str(body.provider, 32);
      const model = str(body.model, 120);
      const baseUrl = str(body.baseUrl, 500);
      const apiKey = asSecret(body.apiKey);
      const acknowledged = body.externalAcknowledged === true;

      // The capability boundary, at the save path. A hosted build's list does
      // not contain `openai_subscription`, so this is the refusal that a
      // hand-crafted request gets — and it is deliberately the same "choose a
      // model provider" as an unknown name, because a hosted build should not
      // confirm that the option exists somewhere.
      if (!savableProviders().includes(provider)) {
        throw new RouteError(400, 'choose a model provider');
      }
      const subscription = isSubscriptionProvider(provider);
      // A subscription CLI chooses its plan's model itself; an empty name here
      // means exactly that. Requiring one forced the UI to invent an
      // identifier, and the invented one then leaked into the next provider
      // switch — a Claude row carrying `gpt-5-codex` is how this rule was
      // found to be wrong.
      if (!model && !subscription) throw new RouteError(400, 'a model name is required');
      if (subscription) {
        // L3.4. Accepting a key here — even to ignore it — would leave a route
        // that takes a credential under the word "subscription". The database
        // refuses the shape too; this refuses the request.
        if (!apiKey.isEmpty) {
          throw new RouteError(
            400,
            'this option uses your own Codex sign-in on this machine, so there is no API key to '
            + 'give. If you want to use an API key, choose OpenAI instead — it is billed per call.',
          );
        }
      }

      const external = isExternalProvider(provider);
      if (external && (await isLocalOnly(db))) {
        // Refusing at save time as well as at call time. Storing a provider
        // that can never be used is a trap for whoever configures it next.
        throw new RouteError(
          409,
          'Local-only mode is on, so a hosted provider cannot be configured. Turn Local-only off first if that is what you want.',
        );
      }
      if (external && !acknowledged) {
        throw new RouteError(
          400,
          'to use a hosted model provider you must acknowledge that the data needed for each request leaves this server '
          + "and is processed under that provider's terms",
        );
      }
      // Which credentials this provider needs is the catalogue's answer, and it
      // is checked against the merged envelope further down. The rule this
      // replaces asked every external provider for an "API key", which is not
      // what Bedrock, Vertex, ERNIE or Hunyuan take — they would have been
      // refused for not supplying a field they do not have.
      const descriptor = describeProvider(provider);
      if (!descriptor) throw new RouteError(400, 'choose a model provider');

      if (descriptor.baseUrlMode === 'required' && !baseUrl) {
        throw new RouteError(
          400,
          provider === 'openai_compatible'
            ? 'a base URL is required for a self-hosted endpoint'
            : 'this provider needs the address of your own endpoint',
        );
      }
      if (baseUrl) {
        if (descriptor.baseUrlMode === 'none') {
          // A base URL on a provider whose endpoint is derived from its own
          // configuration would be silently ignored, and a setting that does
          // nothing is worse than one that is refused.
          throw new RouteError(400, 'this provider does not take an endpoint address');
        }
        // Resolves and classifies. Loopback and LAN pass; cloud metadata does
        // not. See packages/llm/src/ssrf.ts for why that split is the right one.
        await validateEndpoint(baseUrl, { resolve: ctx.resolve });
      }

      const existing = await loadStoredProvider(db, role);
      // Carrying a stored secret forward is only ever right when the slot is
      // still pointed at the SAME provider. An AWS secret access key is not a
      // Cohere key, so switching provider means every credential is re-entered
      // rather than a stale one being kept because a field was left blank.
      const sameProvider = existing?.provider === provider;

      const { secrets, settings, secretFields, configFields } = readCredentials(provider, body);
      const supplied = Object.entries(secrets).filter(([, value]) => !value.isEmpty);

      let sealedKey: string | null = null;
      // Which secret fields the row will actually hold once this save lands.
      // Tracked explicitly rather than inferred, because "required" has to be
      // checked against the merged result: a field left blank on an update is
      // present if it is already stored, and absent if it never was.
      let held: Set<string>;

      if (subscription) {
        // Always null. Switching a slot from OpenAI to the subscription path
        // must not silently carry the old key across; the database constraint
        // would refuse the row, and an operator would get a constraint error
        // instead of the right behaviour.
        sealedKey = null;
        held = new Set();
      } else if (!supplied.length) {
        // Nothing was typed. Keep the stored envelope when the slot still
        // points at the same provider, and treat its contents as satisfying the
        // requirements — they did when it was saved, and opening it here would
        // decrypt a credential for no reason other than to count its keys.
        const keep = sameProvider ? existing?.api_key_enc ?? null : null;
        sealedKey = keep;
        held = keep
          ? new Set(secretFields.map((f) => f.key))
          : new Set();
      } else {
        const masterKey = requireMasterKey(ctx);
        // An update that fills in some fields and leaves others blank keeps the
        // blank ones, so changing an Azure API version does not mean retyping
        // the key. Only within the same provider, per the rule above.
        const carried: Record<string, unknown> = sameProvider && existing?.api_key_enc
          ? await openCredentialPayload<Record<string,unknown>>(db,masterKey,{ownerUserId:req.user!.id,service:'llm',slot:role,stored:existing.api_key_enc})
          : {};
        const merged = { ...carried, ...Object.fromEntries(supplied) };
        sealedKey = await storeCredentialPayload(db,masterKey,{ownerUserId:req.user!.id,kind:'api_key',service:'llm',slot:role,label:`${role} model credentials`,payload:merged,actorUserId:req.user!.id});
        held = new Set(Object.keys(merged));
      }

      if (!subscription) {
        const missing = [
          ...secretFields.filter((f) => f.required && !held.has(f.key)),
          ...configFields.filter((f) => f.required && !settings[f.key]),
        ];
        if (missing.length) {
          throw new RouteError(
            400,
            `this provider needs ${missing.map((f) => f.label.toLowerCase()).join(' and ')}`,
          );
        }
      }

      // Which binary to run. Bounded and recorded so the admin screen can show
      // what will actually be executed rather than an assumption.
      // Defaulted PER PROVIDER. The old default was always the Codex binary,
      // so switching the slot to the Claude subscription silently recorded
      // `codex` as the thing to run — the previous provider's CLI bleeding
      // into the new row.
      const command = subscription
        ? (str(body.subscriptionCommand, 200)
          || (provider === 'anthropic_subscription' ? DEFAULT_CLAUDE_COMMAND : DEFAULT_CODEX_COMMAND))
        : null;

      await db.query(
        `insert into llm_providers
           (role, provider, model, base_url, api_key_enc, external_acknowledged, external_acknowledged_at,
            activated_at, probed_at, probe_steps,
            cap_chat, cap_structured_output, cap_tool_calling, cap_vision, cap_context_tokens,
            subscription_command, provider_config)
         values ($1, $2, $3, $4, $5, $6, $7, null, null, '[]', null, null, null, null, null, $8, $9)
         on conflict (role) do update set
           provider = excluded.provider, model = excluded.model, base_url = excluded.base_url,
           api_key_enc = excluded.api_key_enc,
           external_acknowledged = excluded.external_acknowledged,
           external_acknowledged_at = excluded.external_acknowledged_at,
           activated_at = null, probed_at = null, probe_steps = '[]',
           cap_chat = null, cap_structured_output = null, cap_tool_calling = null, cap_vision = null,
           cap_context_tokens = null,
           subscription_command = excluded.subscription_command,
           provider_config = excluded.provider_config`,
        [
          role, provider, model,
          // Stored for every provider the catalogue lets an operator point
          // somewhere — a regional DashScope host, an Azure resource, a local
          // Ollama — and null for the ones whose endpoint is derived.
          descriptor.baseUrlMode === 'none' ? null : (baseUrl || null),
          sealedKey,
          external ? true : acknowledged,
          external ? new Date().toISOString() : null,
          command,
          // Non-secret settings only. `readCredentials` splits them by the
          // catalogue's own `secret` flag, so a credential cannot arrive here.
          json(settings),
        ],
      );

      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'llm.configured',
        // The provider and model are configuration. The key is not recorded in
        // any form, not even as a hash.
        payload: { role, provider, model, external },
      });

      return res.json({ provider: await providerDto(db, role), needsProbe: true });
    }),
  );

  r.delete(
    '/providers/fallback',
    handle(async (req, res) => {
      await db.query(`delete from llm_providers where role = 'fallback'`);
      await appendEvent(db, {
        actorUserId: req.user!.id, actor: 'super_admin', kind: 'llm.fallback_removed',
      });
      return res.status(204).end();
    }),
  );

  /** Run the capability probe and store what it observed.
   *
   * This is the ONLY thing that sets `activated_at`. Nothing is inferred from
   * the model name, and a probe that cannot hold a basic conversation leaves
   * the provider inactive. */
  r.post(
    '/providers/:role/probe',
    handle(async (req, res) => {
      const role = param(req, 'role');
      if (role !== 'primary' && role !== 'fallback') throw new RouteError(404, 'no such provider slot');

      const stored = await loadStoredProvider(db, role);
      if (!stored) throw new RouteError(404, 'that provider is not configured');
      if (!stored.updated_at) throw new RouteError(409, 'the model configuration could not be verified');

      let result;
      try {
        const provider = await buildProvider(
          {
            db,
            masterKey: ctx.masterKey === false ? null : loadMasterKey(ctx.masterKey ?? {}),
            fetchImpl: ctx.fetchImpl,
            resolve: ctx.resolve,
            codexRunner: ctx.codexRunner,
          },
          stored,
        );
        // Metered. Probing a hosted provider is four real requests on a real
        // invoice; leaving them out of the usage report would understate spend.
        result = await probeProvider(meteredProvider(db, stored, role, provider, { purpose: 'probe' }));
      } catch (err) {
        // A refusal (Local-only, missing acknowledgment, unusable key) is not a
        // failed probe — nothing was asked. Say which it was.
        const message = err instanceof LlmError ? err.message : 'the probe could not run';
        return res.status(409).json({ error: message });
      }

      const updated = await db.query<{ role: string }>(
        `update llm_providers set
           probed_at = $2, probe_steps = $3,
           cap_chat = $4, cap_structured_output = $5, cap_tool_calling = $6, cap_vision = $7, cap_context_tokens = $8,
           activated_at = case when $4 then coalesce(activated_at, now()) else null end
         where role = $1 and updated_at::text = $9::text returning role`,
        [
          // json(), not JSON.stringify + ::jsonb. Hand-serialising is what
          // db.ts warns about: postgres.js types a JS string as text, so the
          // cast stores a jsonb STRING SCALAR rather than an array, and reading
          // it back yields a string. It is silent in pglite and permanent in
          // production — the admin model page crashed on `.map is not a
          // function` because of exactly this.
          role, result.probedAt, json(result.steps),
          result.capabilities.chat, result.capabilities.structuredOutput,
          result.capabilities.toolCalling, result.capabilities.vision, result.capabilities.contextTokens,
          stored.updated_at,
        ],
      );
      if (!updated.length) {
        return res.status(409).json({ error: 'The model changed during the test. Test the current selection again.' });
      }

      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'llm.probed',
        payload: { role, capabilities: result.capabilities, passed: result.capabilities.chat },
      });

      const dto = await providerDto(db, role);
      return res.json({
        provider: dto,
        result: { steps: result.steps, fatal: result.fatal },
        // The consequence, stated plainly, rather than four booleans the
        // operator has to interpret.
        disabledFeatures: role === 'primary' ? disabledFeatures(dto?.capabilities ?? null) : [],
      });
    }),
  );

  // -------------------------------------------------------------- local-only
  r.put(
    '/local-only',
    handle(async (req, res) => {
      const enabled = (req.body ?? {}).enabled === true;

      if (enabled) {
        // Turning it on while a hosted provider is configured would leave an
        // installation that claims to be local and cannot answer anything.
        const rows = await db.query<{ role: string; provider: string }>(
          `select role, provider from llm_providers`,
        );
        const hosted = rows.filter((row) => isExternalProvider(row.provider));
        if (hosted.length) {
          throw new RouteError(
            409,
            `remove the hosted provider${hosted.length > 1 ? 's' : ''} first (${hosted.map((h) => h.role).join(', ')}), `
            + 'otherwise Local-only mode would leave this installation with no usable model.',
          );
        }
      }

      await db.query(`update security_policy set local_only = $1 where id = true`, [enabled]);
      await appendEvent(db, {
        actorUserId: req.user!.id, actor: 'super_admin', kind: 'llm.local_only_changed',
        payload: { enabled },
      });
      return res.json({ localOnly: enabled });
    }),
  );

  // -------------------------------------------------------------------- caps
  const capValue = (v: unknown, field: string): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    // 0 is refused rather than silently meaning "unlimited": an operator who
    // types 0 means "stop everything", and null already means "no cap".
    if (!Number.isFinite(n) || n <= 0) throw new RouteError(400, `${field} must be a positive number, or empty for no cap`);
    return n;
  };

  r.put(
    '/caps',
    handle(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const cost = capValue(body.monthlyCostUsd, 'the monthly spend cap');
      const tokens = capValue(body.monthlyTokens, 'the monthly token cap');
      await db.query(
        `update llm_caps set monthly_cost_usd = $1, monthly_tokens = $2 where id = true`,
        [cost, tokens],
      );
      await appendEvent(db, {
        actorUserId: req.user!.id, actor: 'super_admin', kind: 'llm.caps_changed',
        payload: { monthlyCostUsd: cost, monthlyTokens: tokens },
      });
      return res.json({ caps: { monthly_cost_usd: cost, monthly_tokens: tokens } });
    }),
  );

  r.put(
    '/caps/users/:userId',
    handle(async (req, res) => {
      const userId = param(req, 'userId');
      const users = await db.query<{ id: string }>(`select id from users where id = $1`, [userId]);
      if (!users.length) throw new RouteError(404, 'no such user');

      const body = (req.body ?? {}) as Record<string, unknown>;
      const cost = capValue(body.monthlyCostUsd, "the member's monthly spend cap");
      const tokens = capValue(body.monthlyTokens, "the member's monthly token cap");

      if (cost === null && tokens === null) {
        await db.query(`delete from llm_user_caps where user_id = $1`, [userId]);
      } else {
        await db.query(
          `insert into llm_user_caps (user_id, monthly_cost_usd, monthly_tokens) values ($1, $2, $3)
           on conflict (user_id) do update set
             monthly_cost_usd = excluded.monthly_cost_usd, monthly_tokens = excluded.monthly_tokens`,
          [userId, cost, tokens],
        );
      }
      await appendEvent(db, {
        actorUserId: req.user!.id, actor: 'super_admin', kind: 'llm.user_cap_changed',
        subjectType: 'user', subjectId: userId,
        payload: { monthlyCostUsd: cost, monthlyTokens: tokens },
      });
      return res.json({ userId, monthlyCostUsd: cost, monthlyTokens: tokens });
    }),
  );

  // ------------------------------------------------------------------- usage
  r.get(
    '/usage',
    handle(async (_req, res) => {
      // Aggregate token counts and cost, split by source, per member. How much
      // someone spent is administration; what they said is not, and no prompt
      // or reply is stored anywhere to return.
      const perUser = await db.query(
        `select u.id as user_id, u.username,
                sum(l.input_tokens + l.output_tokens)::bigint as tokens,
                sum(case when l.cost_source = 'reported' then l.cost_usd else 0 end)::float8 as reported_cost_usd,
                sum(case when l.cost_source = 'estimated' then l.cost_usd else 0 end)::float8 as estimated_cost_usd,
                count(*)::int as calls
         from llm_usage l join users u on u.id = l.user_id
         where l.created_at >= date_trunc('month', now())
         group by u.id, u.username
         order by tokens desc`,
      );
      return res.json({
        summary: await usageSummary(db),
        perUser,
        cap: await checkCaps(db),
      });
    }),
  );

  return r;
}

// ------------------------------------------------------------------ member

/** What a signed-in member is allowed to know about the model.
 *
 * Deliberately thin. A member needs to know which features work and how much of
 * their own allowance is left; they do not need the provider, the model name,
 * the endpoint, or anyone else's usage. */
export function llmRoutes(ctx: LlmRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireAuth);

  r.get(
    '/status',
    asyncRoute(async (req, res) => {
      const primary = await loadStoredProvider(db, 'primary');
      const capabilities = capabilitiesOf(primary);
      return res.json({
        // Whether Josi can answer at all, and if not, why not.
        ready: !!primary?.activated_at && capabilities?.chat === true,
        localOnly: await isLocalOnly(db),
        disabledFeatures: disabledFeatures(capabilities),
        // Scoped to the caller. `req.user!.id` is from the session cookie, not
        // from a parameter, so a member cannot ask about somebody else.
        usage: await usageSummary(db, req.user!.id),
        cap: await checkCaps(db, req.user!.id),
      });
    }),
  );

  return r;
}
