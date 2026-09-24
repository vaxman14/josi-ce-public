// Setup tests what it configures.
//
// Every function here makes a REAL attempt against the thing that was just
// saved, and returns what happened. None of them inspects a database row and
// calls that a result.
//
// The rule that produced this file: persisting a credential and reaching a
// service are different events, and a wizard that conflates them tells an
// operator their installation works when nobody has checked. Setup used to say
// so in its own comments — "No message is sent", "No OAuth flow is started" —
// and then report every step as configured.
import {
  LlmError, buildProvider, discoverModels, explainCategory, loadStoredProvider, meteredProvider, probeProvider,
  type ProbeResult,
  type LlmErrorCategory,
} from '@josi-ce/llm';
import { classifySmtpError, loadProfile, smtpTransport, type SmtpTransport } from '@josi-ce/mail';
import { ENDPOINTS } from '@josi-ce/connectors';
import { openSealed, type Db, type MasterKey } from '@josi-ce/core';

export interface VerifyOutcome {
  status: 'passed' | 'failed';
  category?: string;
  /** Operator-facing. Composed here; never a provider's own prose. */
  detail: string;
  /** Safe metadata proving what was tested. */
  target?: string;
  /** Full observed capabilities, stored and shown by onboarding. */
  probe?: ProbeResult;
}

const failed = (category: string, detail: string): VerifyOutcome => ({ status: 'failed', category, detail });

// ------------------------------------------------------------------ the model

/** Run the same complete capability probe used by the Admin model page. */
export async function verifyLlm(
  opts: { db: Db; masterKey: MasterKey | null; fetchImpl?: typeof fetch; timeoutMs?: number; codexRunner?: never },
): Promise<VerifyOutcome> {
  const stored = await loadStoredProvider(opts.db, 'primary');
  if (!stored) return failed('malformed_request', 'No model provider has been configured yet.');

  let provider;
  try {
    provider = await buildProvider(opts, stored);
  } catch (err) {
    const category = err instanceof LlmError ? err.category : 'unknown';
    return failed(category, err instanceof Error ? err.message : 'The model provider could not be prepared.');
  }

  const probe = await probeProvider(meteredProvider(opts.db, stored, 'primary', provider, { purpose: 'probe' }));
  const who = stored.model || "your plan's model";
  if (!probe.capabilities.chat) {
    const category = probe.fatalCategory ?? 'provider_outage';
    const base = explainCategory(category as LlmErrorCategory);
    const detail = probe.fatalProviderCode ? `${base} (the provider said: ${probe.fatalProviderCode})`
      : probe.fatal ?? 'The model did not return a usable basic reply.';
    return {
      status: 'failed', category, detail, target: stored.model, probe,
    };
  }
  const supported = probe.steps.filter((step) => step.passed).length;
  return {
    status: 'passed', detail: `${who} passed ${supported} of ${probe.steps.length} capability checks.`,
    target: stored.model, probe,
  };
}

function describeLlm(err: LlmError): string {
  const base = explainCategory(err.category as LlmErrorCategory);
  // The provider's short code is an enum member, safe to repeat, and often the
  // one word that tells an operator which of two identical-looking problems
  // they have. Its prose is never carried — see LlmError.providerCode.
  return err.providerCode ? `${base} (the provider said: ${err.providerCode})` : base;
}

// ----------------------------------------------------------------- the models

/** Refuse a model the account cannot actually use, before anything is stored.
 *
 * Separate from `verifyLlm` because it answers a different question: not "does
 * this work" but "is this even on offer". A model that discovery does not list
 * will fail at the first request with a 404, and finding that out during setup
 * is much better than finding it out in front of a user. */
export async function assertModelIsOffered(
  opts: {
    provider: string; model: string; apiKey?: string | null; baseUrl?: string | null;
    /** The other credential fields, for providers whose listing needs more than
     * an API key — an AWS key pair, a Vertex service account. */
    secrets?: Record<string, string>;
    /** Non-secret settings the listing needs: a region, a project, a version. */
    config?: Record<string, string>;
    fetchImpl?: typeof fetch; resolve?: (hostname: string) => Promise<string[]>; timeoutMs?: number;
  },
): Promise<{ ok: true } | { ok: false; category: string; detail: string }> {
  const result = await discoverModels({
    provider: opts.provider as never,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    secrets: opts.secrets,
    config: opts.config,
    fetchImpl: opts.fetchImpl,
    resolve: opts.resolve,
    timeoutMs: opts.timeoutMs,
  });

  // "I could not check" is not "this is wrong", and conflating them would stop
  // an air-gapped or self-hosted installation from saving a perfectly good
  // configuration because a listing endpoint was unreachable. Only a listing
  // that SUCCEEDED and does not contain the model is evidence against it.
  //
  // Nothing is lost by being permissive here: `verifyLlm` makes a real request
  // and its failure blocks completion, so a wrong key or a wrong model is
  // caught either way — with a better error, from the thing that actually
  // tried to use it.
  if (result.unsupported || !result.ok) return { ok: true };
  // A list Josi shipped rather than one the provider gave is not evidence about
  // what this account offers. Refusing a model because it is missing from a
  // catalogue written months ago would make a newly released model unusable —
  // which is the failure this whole check was built to prevent, pointed the
  // other way. `verifyLlm` still has to make a real request either way.
  if (result.fromCatalog) return { ok: true };
  if (result.models.some((m) => m.id === opts.model)) return { ok: true };

  return {
    ok: false,
    category: 'model_unavailable',
    detail: `This account does not offer "${opts.model}". Choose one of the ${result.models.length} models it does.`,
  };
}

// ------------------------------------------------------------------- the mail

/** Send a real message to an address the administrator chose.
 *
 * The address is theirs to pick precisely so the test is checkable: they go and
 * look. A test that reports success without anybody receiving anything is the
 * thing being replaced. */
export async function verifySmtp(
  opts: {
    db: Db;
    masterKey: MasterKey;
    to: string;
    /** Injected by the suites, matching how the rest of the app injects it, so
     * no test sends real mail. The runtime harness supplies a REAL server on
     * the project network instead — a stub cannot catch what Phase 8 caught. */
    transport?: SmtpTransport;
  },
): Promise<VerifyOutcome> {
  const to = opts.to.trim();
  if (!to || !to.includes('@')) {
    return failed('malformed_request', 'Enter an address to send the test message to.');
  }

  let profile;
  try {
    profile = await loadProfile(opts.db, opts.masterKey, 'system');
  } catch {
    return failed('malformed_request', 'System mail has not been configured, so there is nothing to test.');
  }

  try {
    const transport = opts.transport ?? smtpTransport(profile);
    await transport.send({
      from: profile.fromName ? `${profile.fromName} <${profile.fromAddress}>` : profile.fromAddress,
      replyTo: profile.fromAddress,
      to: [to],
      cc: [],
      subject: 'Josi test message',
      text:
        'This is the test message Josi sends during setup.\n\n'
        + 'If you are reading it, this installation can send mail: the server accepted the '
        + 'connection, the credentials worked, and delivery reached you.\n\n'
        + 'Nothing else about your installation is in this message.',
      headers: { 'Auto-Submitted': 'auto-generated' },
      attachments: [],
    });
    return {
      status: 'passed',
      detail:
        `A test message was sent to ${to}. Check that it arrived — a server accepting a message `
        + 'is not the same as delivering it.',
      target: to,
    };
  } catch (err) {
    // `smtpTransport` already classified it and dropped the server's own words.
    // `classifySmtpError` is the fallback for anything thrown before that.
    const category = (err as { category?: string }).category ?? classifySmtpError(err);
    return { ...failed(category, describeSmtp(category, profile.host)), target: to };
  }
}

function describeSmtp(category: string, host: string): string {
  switch (category) {
    case 'auth':
      return `${host} rejected the username or password. Many providers require an app password rather than the account password, and some require the connection security to match before they will accept either.`;
    case 'connection':
      return `${host} could not be reached. Check the hostname and port, whether this server is allowed to make outbound connections, and whether the connection security setting matches the port — STARTTLS on 587, TLS on 465.`;
    case 'rejected_recipient':
      return 'The server refused that recipient address. Check it is spelled correctly and that the server is willing to deliver to it.';
    case 'rejected_content':
      return 'The server refused the message itself. That is unusual for a plain-text test message and may mean a content filter is in the way.';
    case 'rate_limited':
      return `${host} is rate limiting this server. Wait and try again.`;
    default:
      return `${host} refused the message and did not say why in a way Josi could interpret.`;
  }
}

// -------------------------------------------------------------- the OAuth apps

/** Prove the client id and secret are the ones the provider knows about.
 *
 * There is no user to consent during setup, so a full authorization round trip
 * is impossible. What IS possible is a real token-endpoint call with a
 * deliberately invalid authorization code: the provider checks the CLIENT
 * credential before it looks at the code, so
 *
 *   * wrong id or secret  -> `invalid_client`
 *   * right id and secret -> `invalid_grant`, because the code is nonsense
 *
 * `invalid_grant` is therefore the PASS. It is a genuine handshake with the
 * provider using the operator's real credential, and it catches the mistakes
 * that actually happen — a typo, a secret from the wrong project, a secret that
 * was rotated, an application that was deleted.
 *
 * It does not prove the redirect URI is registered; only a real consent can,
 * and that is what the per-user Connect flow is for. The detail line says so
 * rather than implying more than was checked. */
export async function verifyOAuthClient(
  opts: {
    db: Db;
    masterKey: MasterKey;
    provider: 'google' | 'microsoft';
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<VerifyOutcome> {
  const [row] = await opts.db.query<{ client_id: string; client_secret_enc: string; redirect_uri: string }>(
    `select client_id, client_secret_enc, redirect_uri from oauth_clients where provider = $1`,
    [opts.provider],
  );
  if (!row) return failed('malformed_request', 'No application has been registered for this provider yet.');

  let clientSecret: string;
  try {
    clientSecret = openSealed<{ clientSecret: string }>(opts.masterKey, row.client_secret_enc).clientSecret;
  } catch {
    return failed('malformed_request', 'The stored client secret could not be opened with this installation master key.');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    // Deliberately invalid, and deliberately obvious in a provider's logs.
    code: 'josi-setup-verification-not-a-real-code',
    client_id: row.client_id,
    client_secret: clientSecret,
    redirect_uri: row.redirect_uri,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(ENDPOINTS[opts.provider].tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch {
    return failed('network', `${opts.provider === 'google' ? 'Google' : 'Microsoft'} could not be reached from this server.`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  const error = readOAuthError(text);

  if (error === 'invalid_grant') {
    return {
      status: 'passed',
      detail:
        'The application was accepted. This proves the client ID and secret are right; '
        + 'the redirect URI is checked the first time somebody connects an account.',
      target: row.client_id,
    };
  }
  if (error === 'invalid_client' || res.status === 401) {
    return failed(
      'authentication',
      'The provider does not recognise this client ID and secret together. Check that both were copied from the same application, and that the secret has not been rotated.',
    );
  }
  if (error === 'unauthorized_client' || error === 'invalid_request') {
    return failed(
      'authorization',
      'The provider recognised the application but refused this configuration. Check that the application is enabled and that the redirect URI is registered exactly as shown.',
    );
  }
  if (res.status === 429) {
    return failed('rate_limit', 'The provider is rate limiting this server. Wait and try again.');
  }
  if (res.status >= 500) {
    return failed('provider_outage', 'The provider had a server error. Nothing is wrong with this installation.');
  }
  return failed('unknown', `The provider answered with something Josi could not interpret (HTTP ${res.status}).`);
}

/** The OAuth2 `error` field, and only that field.
 *
 * `error_description` is prose and is not read: providers put the submitted
 * values into it, and one of the submitted values is the client secret. */
export function readOAuthError(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error !== 'string') return null;
    return /^[a-z_]{1,64}$/.test(parsed.error) ? parsed.error : null;
  } catch {
    return null;
  }
}
