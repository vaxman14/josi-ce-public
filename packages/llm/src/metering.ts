// Usage accounting and spending caps.
//
// Two rules that are easy to get subtly wrong, so they live in one place:
//
//   * A cost is labelled with where it came from. CE holds a local price table
//     that goes stale the moment a provider edits its pricing page, so anything
//     derived from it is an ESTIMATE and says so. Self-hosted calls report
//     `$0 provider charge` — which is true, and is not the same as free.
//
//   * A cap is checked BEFORE the call, not after. Checking afterwards means the
//     limit is discovered by exceeding it.
import type { Db } from '@josi-ce/core';
import type { ProviderKind, Usage } from './types.js';
import { isSubscriptionProvider } from './providers/codexCli.js';

export type CostSource = 'reported' | 'estimated' | 'none' | 'subscription';

export interface CostBreakdown {
  costUsd: number;
  source: CostSource;
  /** Shown wherever the number is. Not decoration: an estimate presented as a
   * bill is a lie the operator only discovers on their card statement. */
  note: string;
}

const ESTIMATE_NOTE =
  'Estimated from a local price list, which may be out of date. Your provider invoice is the real figure.';
const SELF_HOSTED_NOTE =
  'No provider charge. Hardware and electricity are not counted here.';
const REPORTED_NOTE = 'Reported by the provider.';
// A subscription IS a provider charge — just not a per-call one. Filing these
// under the self-hosted note would make "no provider charge" quietly false, and
// filing them under `estimated` would put a fabricated number next to a flat
// monthly fee.
const SUBSCRIPTION_NOTE =
  'Covered by your own ChatGPT plan. There is no per-call charge to show, and no token count — '
  + 'the Codex CLI reports neither. Your plan\'s own usage limits still apply.';

/** What a call cost. `reportedCostUsd` wins when a provider supplies one;
 * almost none do, which is why the estimate path is the common one. */
export async function priceCall(
  db: Db,
  args: {
    provider: ProviderKind;
    model: string;
    usage: Usage;
    reportedCostUsd?: number;
    external: boolean;
  },
): Promise<CostBreakdown> {
  // Before the external check, because a subscription provider IS external and
  // would otherwise fall through to the price table and be "estimated" at a
  // made-up figure.
  if (isSubscriptionProvider(args.provider)) {
    return { costUsd: 0, source: 'subscription', note: SUBSCRIPTION_NOTE };
  }
  if (!args.external) {
    return { costUsd: 0, source: 'none', note: SELF_HOSTED_NOTE };
  }
  if (typeof args.reportedCostUsd === 'number' && Number.isFinite(args.reportedCostUsd)) {
    return { costUsd: args.reportedCostUsd, source: 'reported', note: REPORTED_NOTE };
  }

  const rows = await db.query<{ input_usd_per_mtok: string; output_usd_per_mtok: string }>(
    `select input_usd_per_mtok, output_usd_per_mtok from llm_prices where provider = $1 and model = $2`,
    [args.provider, args.model],
  );
  if (!rows.length) {
    // No price for this model. Reporting 0 would silently under-count against
    // the cap, so the tokens are recorded and the cost is left honest at 0 with
    // a note saying why.
    return {
      costUsd: 0,
      source: 'estimated',
      note: 'No price is known for this model, so only tokens are counted. Set a price to track spend.',
    };
  }
  const inPrice = Number(rows[0].input_usd_per_mtok);
  const outPrice = Number(rows[0].output_usd_per_mtok);
  const costUsd =
    (args.usage.inputTokens / 1_000_000) * inPrice + (args.usage.outputTokens / 1_000_000) * outPrice;
  return { costUsd: Number(costUsd.toFixed(6)), source: 'estimated', note: ESTIMATE_NOTE };
}

export async function recordUsage(
  db: Db,
  args: {
    userId?: string | null;
    provider: ProviderKind;
    model: string;
    role: 'primary' | 'fallback';
    usage: Usage;
    cost: CostBreakdown;
    latencyMs?: number;
    purpose?: string;
  },
): Promise<void> {
  await db.query(
    `insert into llm_usage
       (user_id, provider, model, role, input_tokens, output_tokens, cost_usd, cost_source, latency_ms, purpose)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      args.userId ?? null,
      args.provider,
      args.model,
      args.role,
      args.usage.inputTokens,
      args.usage.outputTokens,
      args.cost.source === 'none' || args.cost.source === 'subscription' ? 0 : args.cost.costUsd,
      args.cost.source,
      args.latencyMs ?? null,
      args.purpose ?? null,
    ],
  );
}

// ------------------------------------------------------------------- caps

export type CapStatus = 'ok' | 'warn_50' | 'warn_80' | 'blocked';

export interface CapVerdict {
  allowed: boolean;
  status: CapStatus;
  /** Which cap is closest to its limit, when one is set. */
  scope: 'workspace' | 'user' | null;
  /** 0..1+, or null when no cap applies. */
  fraction: number | null;
  message: string;
}

interface CapRow {
  monthly_cost_usd: string | null;
  monthly_tokens: string | null;
}

/** Month-to-date spend and tokens. Calendar month, because that is what an
 * operator setting a monthly budget means by it. */
async function usedThisMonth(
  db: Db,
  userId?: string | null,
): Promise<{ cost: number; tokens: number }> {
  const rows = await db.query<{ cost: string | null; tokens: string | null }>(
    `select coalesce(sum(cost_usd), 0) as cost,
            coalesce(sum(input_tokens + output_tokens), 0) as tokens
     from llm_usage
     where created_at >= date_trunc('month', now())
       and ($1::uuid is null or user_id = $1)`,
    [userId ?? null],
  );
  return { cost: Number(rows[0]?.cost ?? 0), tokens: Number(rows[0]?.tokens ?? 0) };
}

function fractionOf(used: { cost: number; tokens: number }, cap: CapRow): number | null {
  const fractions: number[] = [];
  if (cap.monthly_cost_usd !== null) {
    const limit = Number(cap.monthly_cost_usd);
    if (limit > 0) fractions.push(used.cost / limit);
  }
  if (cap.monthly_tokens !== null) {
    const limit = Number(cap.monthly_tokens);
    if (limit > 0) fractions.push(used.tokens / limit);
  }
  // Whichever cap is closest to its limit decides. Being under budget on
  // tokens is no comfort if the dollar cap is spent.
  return fractions.length ? Math.max(...fractions) : null;
}

function statusFor(fraction: number | null): CapStatus {
  if (fraction === null) return 'ok';
  if (fraction >= 1) return 'blocked';
  if (fraction >= 0.8) return 'warn_80';
  if (fraction >= 0.5) return 'warn_50';
  return 'ok';
}

/** Checked before every paid call.
 *
 * A blocked verdict is a hard stop: no degraded mode, no "just this once". The
 * operator raises the cap or waits for the month to turn over, and both are
 * decisions a human makes rather than software. */
export async function checkCaps(db: Db, userId?: string | null): Promise<CapVerdict> {
  const [workspaceCap] = await db.query<CapRow>(
    `select monthly_cost_usd, monthly_tokens from llm_caps where id = true`,
  );
  const workspaceUsed = await usedThisMonth(db, null);
  const workspaceFraction = workspaceCap ? fractionOf(workspaceUsed, workspaceCap) : null;

  let userFraction: number | null = null;
  if (userId) {
    const [userCap] = await db.query<CapRow>(
      `select monthly_cost_usd, monthly_tokens from llm_user_caps where user_id = $1`,
      [userId],
    );
    if (userCap) userFraction = fractionOf(await usedThisMonth(db, userId), userCap);
  }

  // Whichever is worse governs. A user under their own cap is still stopped by
  // the installation running out.
  const candidates: Array<{ scope: 'workspace' | 'user'; fraction: number }> = [];
  if (workspaceFraction !== null) candidates.push({ scope: 'workspace', fraction: workspaceFraction });
  if (userFraction !== null) candidates.push({ scope: 'user', fraction: userFraction });

  if (!candidates.length) {
    return { allowed: true, status: 'ok', scope: null, fraction: null, message: 'No spending cap is set.' };
  }

  const worst = candidates.reduce((a, b) => (b.fraction > a.fraction ? b : a));
  const status = statusFor(worst.fraction);
  const pct = Math.floor(worst.fraction * 100);
  const who = worst.scope === 'workspace' ? 'This installation' : 'Your account';

  if (status === 'blocked') {
    return {
      allowed: false,
      status,
      scope: worst.scope,
      fraction: worst.fraction,
      message:
        worst.scope === 'workspace'
          ? 'This installation has reached its monthly model budget. An administrator has to raise the cap before Josi can think again.'
          : 'You have reached your monthly model budget. Ask an administrator to raise your cap.',
    };
  }

  return {
    allowed: true,
    status,
    scope: worst.scope,
    fraction: worst.fraction,
    message:
      status === 'ok'
        ? `${who} has used ${pct}% of its monthly model budget.`
        : `${who} has used ${pct}% of its monthly model budget.`,
  };
}

export interface UsageSummary {
  month: string;
  totalTokens: number;
  /** Split by how the figure was arrived at, so a total is never a blend of a
   * bill and a guess presented as one number. */
  reportedCostUsd: number;
  estimatedCostUsd: number;
  selfHostedCalls: number;
  /** Calls covered by the operator's own subscription. Counted separately so a
   * usage report never implies they were free OR that they were billed. */
  subscriptionCalls: number;
  calls: number;
  notes: string[];
}

export async function usageSummary(db: Db, userId?: string | null): Promise<UsageSummary> {
  const rows = await db.query<{
    cost_source: CostSource; cost: string | null; tokens: string | null; calls: string;
  }>(
    `select cost_source,
            coalesce(sum(cost_usd), 0) as cost,
            coalesce(sum(input_tokens + output_tokens), 0) as tokens,
            count(*)::text as calls
     from llm_usage
     where created_at >= date_trunc('month', now())
       and ($1::uuid is null or user_id = $1)
     group by cost_source`,
    [userId ?? null],
  );

  const summary: UsageSummary = {
    month: new Date().toISOString().slice(0, 7),
    totalTokens: 0,
    reportedCostUsd: 0,
    estimatedCostUsd: 0,
    selfHostedCalls: 0,
    subscriptionCalls: 0,
    calls: 0,
    notes: [],
  };
  for (const row of rows) {
    summary.totalTokens += Number(row.tokens ?? 0);
    summary.calls += Number(row.calls);
    if (row.cost_source === 'reported') summary.reportedCostUsd += Number(row.cost ?? 0);
    if (row.cost_source === 'estimated') summary.estimatedCostUsd += Number(row.cost ?? 0);
    if (row.cost_source === 'none') summary.selfHostedCalls += Number(row.calls);
    if (row.cost_source === 'subscription') summary.subscriptionCalls += Number(row.calls);
  }
  if (summary.estimatedCostUsd > 0) summary.notes.push(ESTIMATE_NOTE);
  if (summary.selfHostedCalls > 0) summary.notes.push(SELF_HOSTED_NOTE);
  if (summary.subscriptionCalls > 0) summary.notes.push(SUBSCRIPTION_NOTE);
  return summary;
}
