// The first-run setup wizard.
//
// These routes are UNAUTHENTICATED, because they run before any account exists.
// That makes them the most dangerous surface in the product, and three things
// hold the door:
//
//   1. They exist only while `setup_state.completed = false`. After that they
//      are 404 — not hidden, not redirected, gone (see http/setupGate.ts).
//   2. The step order is a server-side state machine. A client cannot pick a
//      step, skip one, or replay one it has already done.
//   3. Completion is a conditional UPDATE, so two concurrent finishers resolve
//      to exactly one winner and the loser is told setup is already done.
//
// Nothing here ever reads a role, a user id, a completion flag or an install
// identity from the request body.
import { isIP } from 'node:net';
import { Router } from 'express';
import {
  appendEvent, asSecret, ensureWorkspace, getInstallId, getSetupState, getVerifications, initializeVault, json, loadMasterKey,
  updateWorkspace,
  recordVerification, seal, storeCredentialPayload, summarizeReview,
  type Db, type LoadOptions, type MasterKey, type ReviewItemInput,
} from '@josi-ce/core';
import { describeProvider, discoverModels } from '@josi-ce/llm';
import { reconcileWorkspaceMount } from '@josi-ce/storage';
import { CAPABILITIES, saveClient, scopesFor } from '@josi-ce/connectors';
import { DeviceLogin, codexLoginStatus, codexLogout, claudeAuthStatus } from '@josi-ce/llm';
import { claudeSubscriptionRouter, claudeEnv } from '../http/claudeSubscriptionRoutes.js';
import { hasCapability } from '@josi-ce/core';
import {
  providerCatalog, readCredentials, revealForDiscovery, savableProviders, subscriptionOptions,
} from '../http/llmRoutes.js';

/** One login attempt at a time, for one installation.
 *
 * In memory rather than in the database because it IS a running child process:
 * a row describing a process that died with the container would be a row that
 * lies. A restart mid-login costs the operator one click. */
let deviceLogin: DeviceLogin | null = null;

function codexEnv() {
  return { codexHome: process.env.CODEX_HOME ?? null };
}

/** The read-only capabilities each provider is asked for at connect time.
 *
 * Derived from the capability table rather than listed, so a read capability
 * added later is covered and a write capability can never drift into the set an
 * application is registered for. Write access is a separate consent (M32). */
const READ_ONLY_CAPABILITIES: Record<'google' | 'microsoft', string[]> = {
  google: CAPABILITIES.filter((c) => c.provider === 'google' && c.kind === 'read').map((c) => c.key),
  microsoft: CAPABILITIES.filter((c) => c.provider === 'microsoft' && c.kind === 'read').map((c) => c.key),
};
import { UserError, createUser } from '@josi-ce/auth';
import { asyncRoute, param } from '../http/async.js';
import { blockingFailures, runHostChecks } from './hostChecks.js';
import { STEP_DESCRIPTORS, SETUP_STEPS, canSubmit, nextStep, type SetupStep } from './steps.js';
import { assertModelIsOffered, verifyLlm, verifyOAuthClient, verifySmtp, type VerifyOutcome } from './verifySteps.js';

export interface SetupRoutesCtx {
  db: Db;
  masterKey?: LoadOptions | false;
  /** Model-provider HTTP, injected by the suites so no test reaches a real
   * provider. Unset in production, where the global fetch is used. */
  llmFetch?: typeof fetch;
  /** DNS for the SSRF layer that guards model-provider requests. */
  llmResolve?: (hostname: string) => Promise<string[]>;
  /** Google/Microsoft HTTP. Separate from `llmFetch` because a suite routinely
   * stubs one and not the other, and a single seam makes that impossible. */
  connectorFetch?: typeof fetch;
  /** SMTP. The runtime harness supplies a real server on the project network
   * rather than a stub, which is how Phase 8 found three defects the unit
   * suite could not. */
  mailTransport?: Parameters<typeof verifySmtp>[0]['transport'];
}

/** Everything setup is allowed to claim it checked.
 *
 * A step and a verification are not the same thing: `domain` is a step with
 * nothing to contact, `llm` is a step whose whole point is that something
 * answered. Only the latter appear here. */
export const VERIFIABLE_ITEMS = ['llm', 'smtp'] as const;
export type VerifiableItem = (typeof VERIFIABLE_ITEMS)[number];

/** Loads the master key, or refuses the request.
 *
 * Fail closed: a step that cannot seal its secret stores NOTHING. There is no
 * plaintext column to fall back to and no "save it unencrypted for now" path,
 * because that path is how plaintext credentials end up in a database forever. */
function requireMasterKey(ctx: SetupRoutesCtx): MasterKey {
  if (ctx.masterKey === false) {
    throw new SetupError(503, 'this installation cannot store secrets right now');
  }
  try {
    return loadMasterKey(ctx.masterKey ?? {});
  } catch {
    // The loader's message names a filesystem path; the operator sees the
    // actionable half without it.
    throw new SetupError(
      503,
      'the installation master key is missing or unusable, so nothing can be saved securely. Run scripts/install.sh, mount the key, and reload.',
    );
  }
}

class SetupError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bool = (v: unknown): boolean => v === true;

/** Import the deployment choice made by the temporary browser installer.
 *
 * The marker is written only after the operator reviews the installer plan.
 * Values are parsed again here rather than trusted, and an invalid bootstrap
 * simply leaves the normal Address step in place. This is idempotent so both
 * GET and POST routes can enforce the same state-machine boundary. */
async function applyInstallerDeployment(db: Db): Promise<void> {
  if (process.env.JOSI_INSTALLER_CONFIGURED !== '1') return;
  const mode = process.env.JOSI_ACCESS_MODE;
  if (!['lan', 'domain', 'proxy'].includes(mode ?? '')) return;
  let address: URL;
  try {
    address = new URL(process.env.APP_URL ?? '');
  } catch {
    return;
  }
  if (!['http:', 'https:'].includes(address.protocol) || !address.hostname
      || address.username || address.password || (address.pathname !== '/' && address.pathname !== '')
      || address.search || address.hash) return;
  if (mode === 'domain' && address.protocol !== 'https:') return;
  if (mode === 'proxy' && address.protocol !== 'https:') return;
  if (mode === 'lan' && isIP(address.hostname) === 0) return;

  await db.query(
    `update deployment_config
     set domain = $1, tls_mode = $2, acme_email = null
     where id = true`,
    [address.hostname.toLowerCase(), mode === 'proxy' ? 'external_proxy' : 'bundled_caddy'],
  );
  await db.query(
    `update setup_state
     set completed_steps = array_append(completed_steps, 'domain'), current_step = 'domain'
     where id = true and completed = false and not ('domain' = any(completed_steps))`,
  );
}

/** Saving a model is not completing the model step. The five-part probe is the
 * acceptance gate, and until it passes the server continues to report `llm` as
 * the current step even after a refresh or a hostile direct POST to SMTP. */
async function expectedSetupStep(db: Db, completed: readonly string[]): Promise<SetupStep | null> {
  const ordinary = nextStep(completed);
  if (!completed.includes('llm')) return ordinary;
  const verification = (await getVerifications(db)).get('llm');
  return verification?.status === 'passed' ? ordinary : 'llm';
}

export function setupRoutes(ctx: SetupRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;

  /** Current position. The only thing a client is told about where it is. */
  r.get(
    '/state',
    asyncRoute(async (_req, res) => {
      await applyInstallerDeployment(db);
      const state = await getSetupState(db);
      const next = await expectedSetupStep(db, state.completed_steps ?? []);
      const visibleCompleted = next === 'llm'
        ? (state.completed_steps ?? []).filter((id) => id !== 'llm')
        : (state.completed_steps ?? []);
      return res.json({
        completed: state.completed,
        completedSteps: visibleCompleted,
        nextStep: next,
        steps: SETUP_STEPS.map((id) => ({
          ...STEP_DESCRIPTORS[id],
          done: visibleCompleted.includes(id),
        })),
        // The same catalogue the admin page is sent, for the same reason: the
        // wizard must not be able to draw a provider this build would refuse to
        // save. Without it the installer offered five hardcoded choices while
        // the server had long since accepted twenty, so a provider was
        // reachable after installation but not during it.
        providerCatalog: providerCatalog(),
      });
    }),
  );

  /** Host checks are read-only and repeatable, so they are also a GET. */
  r.get(
    '/host-checks',
    asyncRoute(async (_req, res) => {
      const checks = await runHostChecks(db, { masterKey: ctx.masterKey });
      return res.json({ checks, blocking: blockingFailures(checks).map((c) => c.id) });
    }),
  );

  /** One endpoint per step. The step name is in the PATH, never in the body,
   * and the server checks it against the state machine before doing anything. */
  r.post(
    '/steps/:step',
    asyncRoute(async (req, res) => {
      const step = param(req, 'step');
      await applyInstallerDeployment(db);
      const state = await getSetupState(db);

      if (state.completed) {
        // Belt and braces: setupGate should already have 404'd this.
        return res.status(404).json({ error: 'not found' });
      }

      const verdict = canSubmit(step, state.completed_steps ?? []);
      if (!verdict.ok) {
        const status = verdict.reason === 'unknown_step' ? 404 : 409;
        return res.status(status).json({
          error:
            verdict.reason === 'unknown_step' ? 'no such step'
            : verdict.reason === 'already_completed' ? 'that step is already done'
            : verdict.reason === 'setup_finished' ? 'setup is already finished'
            : 'that is not the current step',
          expected: verdict.expected,
        });
      }
      const expected = await expectedSetupStep(db, state.completed_steps ?? []);
      if (expected === 'llm' && step !== 'llm') {
        return res.status(409).json({ error: 'test the language model before continuing', expected: 'llm' });
      }

      let result: StepResult | void;
      try {
        result = await applyStep(ctx, step as SetupStep, (req.body ?? {}) as Record<string, unknown>);
      } catch (err) {
        if (err instanceof SetupError) {
          return res.status(err.status).json({ error: err.message });
        }
        throw err;
      }

      // Recorded only after the step's own work succeeded. `array_append` with
      // a `not ... = any` guard makes a concurrent duplicate a no-op rather than
      // a doubled entry.
      await db.query(
        `update setup_state
         set completed_steps = array_append(completed_steps, $1), current_step = $1
         where id = true and completed = false and not ($1 = any(completed_steps))`,
        [step],
      );

      const after = await getSetupState(db);
      return res.json({
        ok: true,
        completedSteps: after.completed_steps ?? [],
        nextStep: await expectedSetupStep(db, after.completed_steps ?? []),
        // Present for steps that contacted something. A step can succeed — the
        // configuration was stored — while what it configured did not work, and
        // the client has to be able to tell those apart.
        ...(result && 'verification' in result ? { verification: result.verification } : {}),
        ...(result?.vaultRecovery ? { vaultRecovery: result.vaultRecovery } : {}),
      });
    }),
  );

  /** The models this credential may actually use.
   *
   * Asked of the provider rather than served from a list in this repository.
   * The list that used to be shipped offered identifiers that no account had
   * been granted and some that did not exist. */
  r.post(
    '/models',
    asyncRoute(async (req, res) => {
      const state = await getSetupState(db);
      if (state.completed) return res.status(404).json({ error: 'not found' });

      const body = (req.body ?? {}) as Record<string, unknown>;
      const provider = str(body.provider, 32);
      if (!savableProviders().includes(provider)) {
        return res.status(400).json({ error: 'choose a model provider' });
      }

      // Which fields this provider takes is the catalogue's answer, exactly as
      // it is on the admin route. Asking only for `apiKey` here is why Bedrock,
      // Vertex, ERNIE and Hunyuan could not be configured during installation:
      // their credential is a key pair, a service account or a region, and the
      // wizard had no way to send one.
      const { secrets, settings } = readCredentials(provider, body);
      const revealed = revealForDiscovery(secrets);
      const result = await discoverModels({
        provider: provider as never,
        // Discovery happens BEFORE the step is submitted, so the credential
        // comes from the request rather than from storage. It is never written
        // here and never echoed back — only the model list is returned.
        apiKey: revealed.apiKey ?? null,
        baseUrl: str(body.baseUrl, 500) || null,
        secrets: revealed,
        config: settings,
        fetchImpl: ctx.llmFetch,
        resolve: ctx.llmResolve,
      });

      return res.json({
        ok: result.ok,
        unsupported: !!result.unsupported,
        models: result.models,
        category: result.category ?? null,
        message: result.message ?? null,
        providerCode: result.providerCode ?? null,
        // Whether the operator is looking at the provider's own list or at the
        // one Josi ships. The wizard says which, rather than presenting both as
        // the same kind of fact.
        fromCatalog: !!result.fromCatalog,
        catalogVersion: result.catalogVersion ?? null,
        allowsCustomModel: !!result.allowsCustomModel,
      });
    }),
  );

  // ------------------------------------------- ChatGPT subscription sign-in
  //
  // LB2. Phase 13.3 built the provider and told the operator to run
  // `codex login` in their own terminal. On a Docker installation that cannot
  // be done: the binary is inside the container, the operator is outside it,
  // and a login on the host signs in a CLI the application never runs.
  //
  // These routes are MOUNTED ONLY on a build whose edition permits the
  // capability. Not guarded — absent. A hosted build's route table does not
  // contain them, which is the outermost of the four layers; the guard, the
  // provider factory and the registry are the other three.
  if (hasCapability('subscription_auth')) {
    /** What is on offer, and the honest reason for each thing that is not. */
    r.get(
      '/subscription',
      asyncRoute(async (_req, res) => {
        const state = await getSetupState(db);
        if (state.completed) return res.status(404).json({ error: 'not found' });
        return res.json({
          options: subscriptionOptions(),
          cli: await codexLoginStatus(codexEnv()),
          // Reported separately rather than folded into one "the CLI" field:
          // an installation can have either, both or neither signed in, and a
          // single flag could not say which.
          claudeCli: await claudeAuthStatus(claudeEnv()),
        });
      }),
    );

    /** Start the CLI's own device-code sign-in and return what it printed.
     *
     * The code is a pairing code, not a credential: it is meant to be read
     * aloud, it grants nothing without somebody completing the flow with their
     * own ChatGPT account, and it expires. Josi never sees what the CLI stores
     * afterwards. */
    r.post(
      '/subscription/login',
      asyncRoute(async (_req, res) => {
        const state = await getSetupState(db);
        if (state.completed) return res.status(404).json({ error: 'not found' });

        // A second attempt supersedes the first rather than running two device
        // flows against one CLI home.
        if (deviceLogin?.running) deviceLogin.cancel();
        deviceLogin = new DeviceLogin(codexEnv());
        return res.json(await deviceLogin.start());
      }),
    );

    r.get(
      '/subscription/login',
      asyncRoute(async (_req, res) => {
        const state = await getSetupState(db);
        if (state.completed) return res.status(404).json({ error: 'not found' });
        if (!deviceLogin) {
          return res.json({ state: 'idle', challenge: null, expiresAt: null, message: null });
        }
        // The CLI exiting zero is what "signed in" means, and it is confirmed
        // against the CLI rather than inferred from an exit code alone.
        const snapshot = deviceLogin.status;
        if (snapshot.state === 'signed_in') {
          const status = await codexLoginStatus(codexEnv());
          if (!status.signedIn) {
            return res.json({
              state: 'failed', challenge: null, expiresAt: null,
              message: 'The sign-in reported success but the CLI is still not signed in. Try again.',
            });
          }
        }
        return res.json(snapshot);
      }),
    );

    r.post(
      '/subscription/login/cancel',
      asyncRoute(async (_req, res) => {
        deviceLogin?.cancel();
        return res.json({ ok: true });
      }),
    );

    /** Undo it. The CLI owns the stored login; this asks it to delete it. */
    r.post(
      '/subscription/logout',
      asyncRoute(async (_req, res) => {
        const state = await getSetupState(db);
        if (state.completed) return res.status(404).json({ error: 'not found' });
        return res.json(await codexLogout(codexEnv()));
      }),
    );

    // Claude, on its own prefix, with the same disappear-after-setup rule the
    // routes above have — expressed as the router's own availability check so
    // there is one copy of it rather than five.
    r.use('/subscription/claude', claudeSubscriptionRouter({
      available: async () => !(await getSetupState(db)).completed,
    }));
  }

  /** Test one configured thing, for real, and record what happened.
   *
   * Separate from the step that saved it so it can be re-run without
   * re-submitting credentials — LB4.5's rerun control — and so a failure is a
   * recorded outcome rather than a step that refused to complete. */
  r.post(
    '/verify/:item',
    asyncRoute(async (req, res) => {
      const state = await getSetupState(db);
      if (state.completed) return res.status(404).json({ error: 'not found' });

      const item = param(req, 'item');
      if (!(VERIFIABLE_ITEMS as readonly string[]).includes(item)) {
        return res.status(404).json({ error: 'there is nothing by that name to test' });
      }

      let outcome;
      try {
        outcome = await runVerification(ctx, item as VerifiableItem, (req.body ?? {}) as Record<string, unknown>);
      } catch (err) {
        if (err instanceof SetupError) return res.status(err.status).json({ error: err.message });
        throw err;
      }

      await recordVerification(db, {
        item,
        status: outcome.status,
        category: outcome.category ?? null,
        detail: outcome.detail,
        target: outcome.target ?? null,
      });

      // Onboarding runs the same full probe as Admin and records every observed
      // capability. A basic reply alone must never masquerade as verification.
      if (item === 'llm' && outcome.probe) {
        const cap = outcome.probe.capabilities;
        await db.query(
          `update llm_providers set
             probed_at = $1, cap_chat = $2, cap_structured_output = $3,
             cap_tool_calling = $4, cap_vision = $5, cap_context_tokens = $6,
             activated_at = case when $2 then coalesce(activated_at, now()) else null end,
             probe_steps = $7
           where role = 'primary'`,
          [outcome.probe.probedAt, cap.chat, cap.structuredOutput, cap.toolCalling,
            cap.vision, cap.contextTokens, json(outcome.probe.steps)],
        );
      }
      return res.json(outcome);
    }),
  );

  /** A redacted summary of everything captured. Never a secret, never a
   * ciphertext — the operator is confirming their choices, not auditing the
   * encryption. */
  r.get(
    '/review',
    asyncRoute(async (_req, res) => res.json(await buildReview(ctx))),
  );

  /** The point of no return.
   *
   * Everything is checked again INSIDE the conditional update, so a step
   * finished by a concurrent request between the check and the write cannot
   * produce a half-configured completion. */
  r.post(
    '/complete',
    asyncRoute(async (_req, res) => {
      const state = await getSetupState(db);
      if (state.completed) return res.status(404).json({ error: 'not found' });

      const remaining = await expectedSetupStep(db, state.completed_steps ?? []);
      if (remaining !== null && remaining !== 'review') {
        return res.status(409).json({ error: 'setup is not finished', expected: remaining });
      }

      const checks = await runHostChecks(db, { masterKey: ctx.masterKey });
      const blocking = blockingFailures(checks);
      if (blocking.length) {
        return res.status(409).json({
          error: 'this machine still has a problem that must be fixed first',
          blocking: blocking.map((c) => ({ id: c.id, label: c.label, detail: c.detail })),
        });
      }

      const owner = await db.query<{ id: string }>(`select id from users where role = 'super_admin' limit 1`);
      if (!owner.length) {
        // Should be impossible — the owner step precedes this — but completing
        // without an administrator would lock the installation permanently.
        return res.status(409).json({ error: 'setup cannot finish without an administrator account' });
      }
      const [vaultState]=await db.query<{recovery_confirmed_at:string|null}>(`select recovery_confirmed_at from vault_state where id=true`);
      if(!vaultState?.recovery_confirmed_at)return res.status(409).json({error:'confirm that the one-time Vault recovery key was saved offline before finishing setup'});

      // Setup cannot close while its required singleton is absent. Rebuild it
      // from answers already persisted by the owner and domain steps.
      const [ownerProfile] = await db.query<{ username: string; display_name: string | null }>(
        `select username, display_name from users where role = 'super_admin' limit 1`,
      );
      const [deployment] = await db.query<{ domain: string | null }>(
        `select domain from deployment_config where id = true`,
      );
      await ensureWorkspace(db, {
        name: ownerProfile?.display_name || ownerProfile?.username || 'My workspace',
      });
      if (deployment?.domain) {
        await updateWorkspace(db, { settings: { publicAddress: deployment.domain } });
      }

      // LB4.4 / LB6.5. A required thing that failed, or that was never tested,
      // stops this here. Checked server-side and checked again at the moment of
      // completion rather than trusted from the review screen, because the
      // review screen is a client.
      const review = await buildReview(ctx);
      if (!review.canComplete) {
        return res.status(409).json({
          error: 'something that has to work does not work yet',
          blocking: review.blocking.map((b) => ({
            key: b.key, label: b.label, status: b.status, detail: b.verification?.detail ?? null,
          })),
        });
      }

      const installId = await getInstallId(db);
      const sealed = await sealSetupOnce(db, installId);
      if (!sealed) {
        // Someone else won the race. Setup is over either way.
        return res.status(404).json({ error: 'not found' });
      }

      await appendEvent(db, {
        actor: 'system',
        kind: 'setup.completed',
        subjectType: 'workspace',
        payload: { steps: (state.completed_steps ?? []).length },
      });

      return res.json({ ok: true, completedAt: sealed.completed_at });
    }),
  );

  r.post('/vault-recovery-confirmed',asyncRoute(async(_req,res)=>{const rows=await db.query(`update vault_state set recovery_confirmed_at=now(),updated_at=now() where id=true and initialized_at is not null returning id`);if(!rows.length)return res.status(409).json({error:'the Master Vault is not initialized'});return res.json({ok:true});}));

  return r;
}

/** The latch that ends setup, extracted so it can be tested on its own.
 *
 * `completed = false` in the WHERE clause is the whole of the single-use
 * guarantee: whichever caller gets there first updates the row, and every later
 * caller updates zero rows and gets null back. Returning null is not an error
 * — it is the correct answer to "did I win the race", and the route turns it
 * into the same 404 an already-finished installation gives.
 *
 * This lives in its own function because the route's early `if (completed)`
 * check would otherwise mask it: a test driving HTTP can never tell whether the
 * early check or this clause did the work, and a database that serialises
 * queries (pglite, in the unit suite) makes the early check win every time. */
export async function sealSetupOnce(
  db: Db,
  installId: string,
): Promise<{ completed_at: string } | null> {
  const rows = await db.query<{ completed_at: string }>(
    `update setup_state
     set completed = true, current_step = 'done', completed_at = now(),
         install_id = $1,
         completed_steps = array(select distinct unnest(completed_steps || array['review']))
     where id = true and completed = false
     returning completed_at`,
    [installId],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- step logic

/** A step's own result.
 *
 * Steps that contact something return what happened, so the client can show it
 * immediately rather than making a second request to find out whether the thing
 * it just configured works. */
interface StepResult {
  verification?: unknown;
  vaultRecovery?: { key:string; fingerprint:string };
}

async function applyStep(
  ctx: SetupRoutesCtx,
  step: SetupStep,
  body: Record<string, unknown>,
): Promise<StepResult | void> {
  const { db } = ctx;

  switch (step) {
    // ------------------------------------------------------------ host checks
    case 'host_checks': {
      const checks = await runHostChecks(db, { masterKey: ctx.masterKey });
      const blocking = blockingFailures(checks);
      if (blocking.length) {
        throw new SetupError(409, `this machine is not ready: ${blocking.map((c) => c.detail).join(' ')}`);
      }
      // Recorded so an operator can see later what the machine looked like.
      for (const c of checks) {
        await db.query(
          `insert into setup_host_checks (check_id, status, label, mandatory) values ($1, $2, $3, $4)`,
          [c.id, c.status, c.label, c.mandatory],
        );
      }
      return;
    }

    // ----------------------------------------------------------------- owner
    case 'owner': {
      const email = str(body.email, 320);
      const username = str(body.username, 64);
      const displayName = str(body.displayName, 120);
      const timezone = str(body.timezone, 80) || 'UTC';
      const password = asSecret(body.password);

      if (!email || !email.includes('@')) throw new SetupError(400, 'a valid email address is required');
      if (!username) throw new SetupError(400, 'a username is required');
      if (password.length < 12) throw new SetupError(400, 'the password must be at least 12 characters');

      // The role is a literal here. Nothing from `body` can influence it, so a
      // request carrying {"role":"member"} or {"role":"super_admin"} changes
      // nothing at all.
      try {
        await ensureWorkspace(db, { name: displayName || username, timezone });
        const owner=await createUser(db, {
          email,
          username,
          displayName: displayName || null,
          role: 'super_admin',
          password: password.reveal(),
        });
        await reconcileWorkspaceMount(db);
        const vault=await initializeVault(db,requireMasterKey(ctx),owner.id);
        return {vaultRecovery:{key:vault.recoveryKey.reveal(),fingerprint:vault.fingerprint}};
      } catch (err) {
        if (err instanceof UserError) {
          // Includes the one-super-admin constraint, which is what a concurrent
          // duplicate submission trips.
          throw new SetupError(409, err.message);
        }
        throw err;
      }
      // Deliberately no session is issued and no cookie set. The operator signs
      // in normally once setup finishes; a wizard that hands out an
      // authenticated session mid-flow is a wizard that can be raced.
      return;
    }

    // ---------------------------------------------------------------- domain
    case 'domain': {
      const domain = str(body.domain, 253).toLowerCase();
      const tlsMode = body.tlsMode === 'external_proxy' ? 'external_proxy' : 'bundled_caddy';
      const acmeEmail = str(body.acmeEmail, 320);

      if (!domain) throw new SetupError(400, 'an address is required');
      // Hostname, localhost, or a literal LAN address. Not a URL, path, or
      // scheme. Public ACME certificates need a hostname, but LAN-only Josi is
      // a supported install and must not lie that its address is invalid.
      if (isIP(domain) === 0 && !/^(localhost|(?=.{1,253}$)([a-z0-9](-*[a-z0-9])*\.)+[a-z]{2,})$/.test(domain)) {
        throw new SetupError(400, 'that does not look like a hostname or IP address');
      }
      if (acmeEmail && !acmeEmail.includes('@')) throw new SetupError(400, 'that does not look like an email address');

      await db.query(
        `update deployment_config set domain = $1, tls_mode = $2, acme_email = $3 where id = true`,
        [domain, tlsMode, acmeEmail || null],
      );
      await ensureWorkspace(db);
      await updateWorkspace(db, { settings: { publicAddress: domain } });
      // certificate_verified_at is untouched: no ACME challenge has happened,
      // and claiming otherwise would be a lie the UI then repeats.
      return;
    }

    // ------------------------------------------------------------------- LLM
    case 'llm': {
      const provider = str(body.provider, 32);
      const model = str(body.model, 120);
      const baseUrl = str(body.baseUrl, 500);
      const apiKey = asSecret(body.apiKey);
      const acknowledged = bool(body.externalAcknowledged);

      // `openai_subscription` is in this list only on a build whose edition
      // permits it. On a hosted build it is absent, so the step refuses it with
      // "choose a model provider" — the same answer as any other unknown
      // string, which is deliberate: a hosted build should not confirm that
      // the capability exists to be asked for.
      if (!savableProviders().includes(provider)) throw new SetupError(400, 'choose a model provider');
      // Automatic is represented by an empty model on either subscription.
      // A selected ChatGPT identifier is also accepted and passed to Codex as
      // --model; the real probe must succeed before it becomes active. A
      // non-subscription provider still needs an explicit model name.
      const subscriptionProvider = provider === 'openai_subscription' || provider === 'anthropic_subscription';
      if (!model && !subscriptionProvider) throw new SetupError(400, 'a model name is required');

      // A subscription path carries no API key at all — the credential lives in
      // the operator's own CLI login and never enters this process — so the
      // "a key is required" rule below must not apply to it. It IS still
      // external: the bytes reach the vendor, by way of the vendor's own binary.
      const isSubscription = subscriptionProvider;
      if (isSubscription) {
        if (!apiKey.isEmpty) {
          throw new SetupError(
            400,
            'a subscription provider must not be given an API key — that would bill an API account '
            + 'while calling itself a subscription',
          );
        }
        // ASKED OF THE CLI THAT WILL ACTUALLY BE RUN. Checking the wrong one
        // would let an installation finish setup pointing at a binary nobody
        // has signed in to, which is the failure this whole step exists to
        // prevent.
        const signedIn = provider === 'anthropic_subscription'
          ? await claudeAuthStatus(claudeEnv())
          : await codexLoginStatus({ codexHome: process.env.CODEX_HOME ?? null });
        if (!signedIn.signedIn) {
          throw new SetupError(400, `${signedIn.detail} Sign in first, then continue.`);
        }
      }

      const isExternal = provider !== 'openai_compatible';
      if (isExternal && !acknowledged) {
        // M89. Not a checkbox the UI can quietly pre-tick: the server refuses
        // without it, and the acknowledgment is stored rather than merely shown.
        throw new SetupError(
          400,
          'to use a hosted model provider you must acknowledge that the data needed for each request leaves this server and is processed under that provider\'s terms',
        );
      }
      // Which credentials this provider needs is the catalogue's answer, the
      // same as on the admin route. The rule this replaces asked every external
      // provider for an "API key", which is not what Bedrock, Vertex, ERNIE or
      // Hunyuan take — they would have been refused during installation for
      // failing to supply a field they do not have.
      const descriptor = describeProvider(provider);
      if (!descriptor) throw new SetupError(400, 'choose a model provider');

      const { secrets, settings, secretFields, configFields } = readCredentials(provider, body);
      const supplied = Object.entries(secrets).filter(([, value]) => !value.isEmpty);

      if (!isSubscription) {
        const missing = [
          ...secretFields.filter((f) => f.required && !supplied.some(([key]) => key === f.key)),
          ...configFields.filter((f) => f.required && !settings[f.key]),
        ];
        if (missing.length) {
          throw new SetupError(
            400,
            `this provider needs ${missing.map((f) => f.label.toLowerCase()).join(' and ')}`,
          );
        }
      }

      if (descriptor.baseUrlMode === 'required' && !baseUrl) {
        throw new SetupError(
          400,
          provider === 'openai_compatible'
            ? 'a base URL is required for a self-hosted endpoint'
            : 'this provider needs the address of your own endpoint',
        );
      }
      if (baseUrl) {
        if (descriptor.baseUrlMode === 'none') {
          // A setting that would be silently ignored is worse than one refused:
          // this provider's endpoint is derived from its own configuration.
          throw new SetupError(400, 'this provider does not take an endpoint address');
        }
        let parsed: URL;
        try {
          parsed = new URL(baseUrl);
        } catch {
          throw new SetupError(400, 'that base URL is not a valid URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new SetupError(400, 'the base URL must be http or https');
        }
      }

      // Before anything is stored: is this model even on offer to this account?
      //
      // It used to be free text, and the web app offered a hardcoded list of
      // identifiers nobody had checked — so an operator could store
      // `gpt-5.6-luna`, be told they were configured, and discover at the first
      // real request that no such model had ever existed. Discovery answers
      // that question with the credential they just supplied.
      // An empty model on a subscription provider means 'the plan's default':
      // there is nothing to look up, and asking discovery whether it offers ""
      // guarantees a refusal with a blank name in it.
      if (model || !subscriptionProvider) {
        const revealed = revealForDiscovery(secrets);
        const offered = await assertModelIsOffered({
          provider,
          model,
          apiKey: revealed.apiKey ?? null,
          baseUrl: descriptor.baseUrlMode === 'none' ? null : (baseUrl || null),
          secrets: revealed,
          config: settings,
          fetchImpl: ctx.llmFetch,
          resolve: ctx.llmResolve,
        });
        if (!offered.ok) throw new SetupError(400, offered.detail);
      }

      // Sealed before it goes anywhere near the database, and only if there is
      // something to seal. One envelope holds every secret field the provider
      // takes — an AWS key pair and a session token seal together exactly as a
      // lone API key does. `seal` unwraps each Secret itself; nothing here ever
      // calls reveal() on the way to storage.
      const [vaultOwner]=await db.query<{id:string}>(`select id from users where role='super_admin' order by created_at limit 1`);
      const sealedKey = supplied.length
        ? await storeCredentialPayload(db,requireMasterKey(ctx),{ownerUserId:vaultOwner.id,kind:'api_key',service:'llm',slot:'primary',label:'Primary model credentials',payload:Object.fromEntries(supplied),actorUserId:vaultOwner.id})
        : null;

      // A passing probe belongs to the exact provider configuration that was
      // tested. Invalidate first: if the following write ever fails, setup
      // demands a harmless re-test instead of trusting a stale receipt.
      await db.query(`delete from setup_verifications where item = 'llm'`);
      await db.query(
        `insert into llm_providers
           (role, provider, model, base_url, api_key_enc, external_acknowledged, external_acknowledged_at,
            provider_config)
         values ('primary', $1, $2, $3, $4, $5, $6, $7)
         on conflict (role) do update set
           provider = excluded.provider, model = excluded.model, base_url = excluded.base_url,
           api_key_enc = excluded.api_key_enc,
           external_acknowledged = excluded.external_acknowledged,
           external_acknowledged_at = excluded.external_acknowledged_at,
           provider_config = excluded.provider_config`,
        [
          provider,
          model,
          // Stored for every provider the catalogue lets an operator point
          // somewhere, and null for the ones whose endpoint is derived.
          descriptor.baseUrlMode === 'none' ? null : (baseUrl || null),
          sealedKey,
          isExternal ? true : acknowledged,
          isExternal ? new Date().toISOString() : null,
          // Non-secret settings only. `readCredentials` splits them by the
          // catalogue's own `secret` flag, so a credential cannot arrive here.
          json(settings),
        ],
      );
      return;
    }

    // ------------------------------------------------------------------ SMTP
    case 'smtp': {
      // A local or single-user installation can become useful before it has a
      // mail relay. Skipping stores no placeholder profiles; the admin can add
      // them later, and features that require mail remain honestly unavailable.
      //
      // The skip is RECORDED. An unrecorded skip is indistinguishable from a
      // step nobody reached, and the review screen has to tell those apart:
      // one is a decision, the other is unfinished work.
      if (bool(body.skip)) {
        await recordVerification(db, {
          item: 'smtp',
          status: 'skipped',
          detail: 'Skipped during setup. Josi cannot send invitations, password resets or mail until this is configured.',
        });
        return;
      }

      const system = (body.system ?? {}) as Record<string, unknown>;
      const comms = (body.communications ?? {}) as Record<string, unknown>;

      const sysHost = str(system.host, 253);
      const sysPort = Number(system.port);
      const sysSecurity = str(system.security, 16) || 'starttls';
      const sysUser = str(system.username, 320);
      const submittedPassword = asSecret(system.password);
      // Google displays app passwords in four groups separated by spaces.
      // SMTP AUTH expects the 16 letters without presentation whitespace.
      const sysPassword = sysHost.trim().toLowerCase() === 'smtp.gmail.com' && !submittedPassword.isEmpty
        ? asSecret(submittedPassword.reveal().replace(/\s/g, ''))
        : submittedPassword;
      const sysFromName = str(system.fromName, 120);
      const sysFromAddress = str(system.fromAddress, 320);

      // LB4.2. Configuring mail means proving mail can be sent, to an address
      // the administrator names so the result is checkable by going and
      // looking. The only alternative is `skip`, handled above.
      //
      // Validated here, with the other field checks and BEFORE anything is
      // written: a refusal has to leave the database exactly as it found it.
      const testTo = str(body.testTo, 320);
      if (!testTo) {
        throw new SetupError(
          400,
          'Enter an address to send a test message to, or choose to skip email for now. '
          + 'Josi does not report mail as working without sending one.',
        );
      }

      if (!sysHost) throw new SetupError(400, 'a mail server is required for system mail');
      if (!Number.isInteger(sysPort) || sysPort < 1 || sysPort > 65535) {
        throw new SetupError(400, 'that is not a valid port');
      }
      if (!['none', 'starttls', 'tls'].includes(sysSecurity)) throw new SetupError(400, 'unknown connection security');
      if (!sysFromAddress.includes('@')) throw new SetupError(400, 'a valid From address is required for system mail');
      if (sysHost.trim().toLowerCase() === 'smtp.gmail.com' && !sysPassword.isEmpty && sysPassword.length !== 16) {
        throw new SetupError(400, 'Google App Passwords must contain exactly 16 letters. Paste all four groups; spaces are removed automatically.');
      }

      const key = sysPassword.isEmpty ? null : requireMasterKey(ctx);
      const [vaultOwner]=await db.query<{id:string}>(`select id from users where role='super_admin' order by created_at limit 1`);
      const sysPasswordEnc = key ? await storeCredentialPayload(db,key,{ownerUserId:vaultOwner.id,kind:'password',service:'smtp',slot:'system',label:'System SMTP password',payload:{password:sysPassword},actorUserId:vaultOwner.id}) : null;

      await db.query(
        `insert into smtp_profiles (kind, copy_from_system, host, port, security, username, password_enc, from_name, from_address)
         values ('system', false, $1, $2, $3, $4, $5, $6, $7)
         on conflict (kind) do update set
           host = excluded.host, port = excluded.port, security = excluded.security,
           username = excluded.username, password_enc = coalesce(excluded.password_enc, smtp_profiles.password_enc),
           from_name = excluded.from_name, from_address = excluded.from_address`,
        [sysHost, sysPort, sysSecurity, sysUser || null, sysPasswordEnc, sysFromName || null, sysFromAddress],
      );

      // The credentials are saved first and stay saved even when the send
      // fails, so a retry does not mean typing an SMTP password again. Mail is
      // optional, so a failure does not block completion — it is recorded, and
      // the review screen shows it as "Configured but failed" rather than
      // quietly as "Skipped".
      const copy = bool(comms.copyFromSystem);
      const commsFromName = str(comms.fromName, 120);
      const commsFromAddress = str(comms.fromAddress, 320);
      if (!commsFromAddress.includes('@')) {
        throw new SetupError(400, 'a valid From address is required for the address Josi writes from');
      }

      if (copy) {
        // Borrows the system server. Stores its OWN sender identity and NO
        // credentials, so the password exists once in the database rather than
        // twice — which is also why rotating it later is one change, not two.
        await db.query(
          `insert into smtp_profiles (kind, copy_from_system, host, port, security, username, password_enc, from_name, from_address)
           values ('communications', true, null, null, null, null, null, $1, $2)
           on conflict (kind) do update set
             copy_from_system = true, host = null, port = null, security = null,
             username = null, password_enc = null,
             from_name = excluded.from_name, from_address = excluded.from_address`,
          [commsFromName || null, commsFromAddress],
        );
      } else {
        const cHost = str(comms.host, 253);
        const cPort = Number(comms.port);
        const cSecurity = str(comms.security, 16) || 'starttls';
        const cUser = str(comms.username, 320);
        const cPassword = asSecret(comms.password);
        if (!cHost) throw new SetupError(400, 'a mail server is required, or choose to reuse the system one');
        if (!Number.isInteger(cPort) || cPort < 1 || cPort > 65535) throw new SetupError(400, 'that is not a valid port');
        const cKey = cPassword.isEmpty ? null : requireMasterKey(ctx);
        await db.query(
          `insert into smtp_profiles (kind, copy_from_system, host, port, security, username, password_enc, from_name, from_address)
           values ('communications', false, $1, $2, $3, $4, $5, $6, $7)
           on conflict (kind) do update set
             copy_from_system = false, host = excluded.host, port = excluded.port,
             security = excluded.security, username = excluded.username,
             password_enc = excluded.password_enc, from_name = excluded.from_name,
             from_address = excluded.from_address`,
          [cHost, cPort, cSecurity, cUser || null, cKey ? await storeCredentialPayload(db,cKey,{ownerUserId:vaultOwner.id,kind:'password',service:'smtp',slot:'communications',label:'Communications SMTP password',payload:{password:cPassword},actorUserId:vaultOwner.id}) : null,
           commsFromName || null, commsFromAddress],
        );
      }
      // The message goes out now, with the credentials that were just stored.
      const outcome = await verifySmtp({
        db, masterKey: requireMasterKey(ctx), to: testTo, transport: ctx.mailTransport,
      });
      await recordVerification(db, {
        item: 'smtp',
        status: outcome.status,
        category: outcome.category ?? null,
        detail: outcome.detail,
        target: outcome.target ?? null,
      });
      return { verification: outcome };
    }

    // ------------------------------------------------------------ connectors
    // -------------------------------------------------------------- security
    case 'security': {
      // Deny-by-default is the column default. A field that is absent or
      // malformed leaves the restrictive value in place; only an explicit
      // `true` opens anything.
      const retention = Number(body.auditRetentionDays);
      const allowedRetention = [30, 90, 365, 0];
      await db.query(
        `update security_policy set
           folder_mapping_enabled = $1,
           folder_sharing_enabled = $2,
           workspace_wide_sharing_enabled = $3,
           ocr_enabled = $4,
           clamav_enabled = $5,
           audit_retention_days = $6
         where id = true`,
        [
          bool(body.folderMappingEnabled),
          body.folderSharingEnabled === false ? false : true,
          bool(body.workspaceWideSharingEnabled),
          bool(body.ocrEnabled),
          bool(body.clamavEnabled),
          allowedRetention.includes(retention) ? retention : 365,
        ],
      );
      // local_file_access_enabled is deliberately not settable here. Local
      // access needs a Docker mount as well as an application allowlist, so it
      // cannot be switched on from a web form (M45).
      return;
    }

    // ------------------------------------------------------------- telemetry
    case 'telemetry': {
      // Only a literal `true` enables it. `"true"`, `1`, `"yes"`, `{}` and a
      // missing field all leave it off.
      const enabled = body.enabled === true;
      await db.query(
        `update telemetry_state set enabled = $1, opted_in_at = $2 where id = true`,
        [enabled, enabled ? new Date().toISOString() : null],
      );
      // Nothing is transmitted in this phase, whatever the answer.
      return;
    }

    // ---------------------------------------------------------------- review
    case 'review':
      // Reviewing is reading. The write is POST /complete.
      return;
  }
}

// ------------------------------------------------------------------- review

/** The public HTTPS origin this installation is reachable at, or null.
 *
 * Null is the honest answer for a LAN-only installation, and callers are
 * expected to say so rather than to synthesise `https://192.168.1.50` — which
 * no provider will accept as a redirect URI and which would send an operator
 * round a loop of provider error pages looking for their own mistake. */
export async function publicHttpsBase(db: Db): Promise<string | null> {
  const [deployment] = await db.query<{ domain: string | null }>(
    `select domain from deployment_config where id = true`,
  );
  const domain = deployment?.domain?.trim().toLowerCase();
  if (!domain) return null;
  // A bare IP address cannot hold a publicly trusted certificate, and
  // `localhost` is not reachable from a provider's servers.
  if (domain === 'localhost' || isIP(domain) !== 0) return null;
  return `https://${domain}`;
}

// ---------------------------------------------------------- running the tests

async function runVerification(
  ctx: SetupRoutesCtx,
  item: VerifiableItem,
  body: Record<string, unknown>,
): Promise<VerifyOutcome> {
  const { db } = ctx;

  if (item === 'llm') {
    let masterKey: MasterKey | null = null;
    try {
      masterKey = requireMasterKey(ctx);
    } catch {
      // A self-hosted endpoint with no key needs none; a hosted one has a
      // sealed key that cannot be opened without it, and buildProvider says so.
      masterKey = null;
    }
    return verifyLlm({ db, masterKey, fetchImpl: ctx.llmFetch });
  }

  return verifySmtp({
    db,
    masterKey: requireMasterKey(ctx),
    to: str(body.to, 320),
    transport: ctx.mailTransport,
  });
}

// ------------------------------------------------------------------- review

/** What the review screen is allowed to say about each thing.
 *
 * The old version derived every status from "does a row exist", so a credential
 * that had never been used and one that worked read identically — and the
 * connector line said "accounts are connected once connector support ships"
 * long after connector support had shipped.
 *
 * Status now comes from `summarizeReview`, which can only say "tested" when a
 * verification passed. */
async function reviewItems(ctx: SetupRoutesCtx): Promise<ReviewItemInput[]> {
  const { db } = ctx;
  const verifications = await getVerifications(db);

  const [llm] = await db.query<{ provider: string; model: string }>(
    `select provider, model from llm_providers where role = 'primary'`,
  );
  const [systemMail] = await db.query<{ host: string | null }>(
    `select host from smtp_profiles where kind = 'system'`,
  );
  // Google and Microsoft are deliberately absent. Registering an OAuth
  // application needs a public HTTPS callback, which a LAN-only installation
  // does not have at setup time, so the wizard used to carry two items that
  // could only ever report themselves unavailable. They are administered after
  // installation, once a domain exists — see the admin Connectors page.
  return [
    {
      key: 'llm',
      label: 'Language model',
      required: true,
      configured: !!llm,
      verification: verifications.get('llm') ?? null,
    },
    {
      key: 'smtp',
      label: 'Email sending',
      required: false,
      configured: !!systemMail,
      verification: verifications.get('smtp') ?? null,
    },
  ];
}

async function buildReview(ctx: SetupRoutesCtx) {
  const summary = summarizeReview(await reviewItems(ctx));
  return { ...summary, summary: await buildReviewDetail(ctx.db) };
}

/** Everything captured, with nothing sensitive in it.
 *
 * The rule applied throughout: say THAT a secret is set, never any part of it.
 * No ciphertext either — an operator confirming their choices has no use for it
 * and it is one copy-paste away from a support ticket. */
async function buildReviewDetail(db: Db): Promise<Record<string, unknown>> {
  const [deployment] = await db.query<{ domain: string | null; tls_mode: string; acme_email: string | null; certificate_verified_at: string | null }>(
    `select domain, tls_mode, acme_email, certificate_verified_at from deployment_config where id = true`,
  );
  const [llm] = await db.query<{ provider: string; model: string; base_url: string | null; api_key_enc: string | null; external_acknowledged: boolean; activated_at: string | null; probe_steps: unknown }>(
    `select provider, model, base_url, api_key_enc, external_acknowledged, activated_at, probe_steps from llm_providers where role = 'primary'`,
  );
  const smtp = await db.query<{ kind: string; copy_from_system: boolean; host: string | null; port: number | null; security: string | null; username: string | null; password_enc: string | null; from_name: string | null; from_address: string | null; verified_at: string | null }>(
    `select kind, copy_from_system, host, port, security, username, password_enc, from_name, from_address, verified_at from smtp_profiles order by kind`,
  );
  // `oauth_clients`, not `connector_configs` — see migration 0018. Selected
  // column by column rather than with `*`, so widening the query cannot start
  // serving the sealed secret; that is the same mistake Phase 4's M18 and
  // Phase 7's M19 both made.
  const connectors = await db.query<{ provider: string; client_id: string; redirect_uri: string }>(
    `select provider, client_id, redirect_uri from oauth_clients order by provider`,
  );
  const [policy] = await db.query<Record<string, unknown>>(`select * from security_policy where id = true`);
  const [telemetry] = await db.query<{ enabled: boolean }>(`select enabled from telemetry_state where id = true`);
  const [owner] = await db.query<{ email: string; username: string }>(
    `select email, username from users where role = 'super_admin' limit 1`,
  );

  return {
    owner: owner ? { email: owner.email, username: owner.username } : null,
    deployment: deployment
      ? {
          domain: deployment.domain,
          tlsMode: deployment.tls_mode,
          acmeEmailSet: !!deployment.acme_email,
          // Honest: a certificate has not been obtained during setup.
          certificateVerified: !!deployment.certificate_verified_at,
        }
      : null,
    llm: llm
      ? {
          provider: llm.provider,
          model: llm.model,
          baseUrl: llm.base_url,
          apiKeySet: !!llm.api_key_enc,
          externalAcknowledged: llm.external_acknowledged,
          probeSteps: Array.isArray(llm.probe_steps) ? llm.probe_steps : [],
        }
      : null,
    smtp: smtp.map((p) => ({
      kind: p.kind,
      copyFromSystem: p.copy_from_system,
      host: p.copy_from_system ? null : p.host,
      port: p.copy_from_system ? null : p.port,
      security: p.copy_from_system ? null : p.security,
      username: p.copy_from_system ? null : p.username,
      passwordSet: p.copy_from_system ? null : !!p.password_enc,
      fromName: p.from_name,
      fromAddress: p.from_address,
    })),
    connectors: connectors.map((c) => ({
      provider: c.provider,
      // A client ID is not a secret — it appears in the consent URL the user
      // sees — but it is still an identifier, so only its presence is shown.
      clientIdSet: !!c.client_id,
      // Shown in full: an operator has to compare it character for character
      // against what they registered with the provider, and a mismatch here is
      // the single most common connector failure.
      redirectUri: c.redirect_uri,
    })),
    security: policy
      ? {
          localFileAccess: policy.local_file_access_enabled,
          folderMapping: policy.folder_mapping_enabled,
          folderSharing: policy.folder_sharing_enabled,
          workspaceWideSharing: policy.workspace_wide_sharing_enabled,
          ocr: policy.ocr_enabled,
          clamav: policy.clamav_enabled,
          auditRetentionDays: policy.audit_retention_days,
        }
      : null,
    telemetry: { enabled: telemetry?.enabled ?? false },
    reminders: [
      'Back up the installation master key separately. A database backup alone cannot restore your saved credentials.',
    ],
  };
}
