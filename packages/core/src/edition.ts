// The edition capability boundary.
//
// Some things CE may do, a hosted or white-label build of this same source may
// not — not "should not", not "is not shown", may not. The clearest example is
// L3's subscription authentication: OpenAI's terms permit an individual to use
// their own ChatGPT plan for their own productivity and forbid using it to
// power a commercial service. CE is the first; a hosted product built from this
// repository would be the second. So the difference has to be structural.
//
// FOUR PROPERTIES, AND WHY EACH ONE IS NEEDED
//
//  1. The edition comes from the BUILD (`buildStamp.ts`), not the environment.
//     An env var is a label; a compiled constant is a property of the artefact.
//
//  2. The environment may NARROW and may never WIDEN. An operator who wants
//     less than their edition allows should get it. An operator who wants more
//     needs a different build. Every widening spelling is tested, because "we
//     only read one variable" is a claim that decays.
//
//  3. An unrecognised stamp fails CLOSED — to the least capable edition, not to
//     CE. A typo in a build argument must not hand out capabilities.
//
//  4. The resolved profile is frozen. Not because a frozen object stops a
//     determined attacker inside the process, but because it stops the ordinary
//     accident: a route handler that pushes onto the array to "temporarily
//     enable" something and leaves it enabled for every later request.
//
// Enforcement is layered on purpose. The route is not mounted, the guard
// refuses, the factory refuses, and the call path refuses. A boundary with one
// check is a boundary with one bug.
import { BUILD_EDITION } from './buildStamp.js';

export const EDITIONS = ['ce', 'hosted', 'business', 'white_label'] as const;
export type Edition = (typeof EDITIONS)[number];

/**
 * The capabilities the boundary governs.
 *
 * Deliberately short. This list is not a feature flag registry — everything
 * that merely varies by configuration belongs in the database, where an
 * administrator can change it. A capability belongs here only when the answer
 * must be fixed by the artefact and unreachable from any setting.
 *
 * `local_command_execution` — may this build run a program on the host as a
 *   subprocess. CE runs on the operator's own machine, so their own binaries
 *   are theirs to run. A multi-tenant host must never spawn a host process on
 *   behalf of a tenant, whatever the feature.
 *
 * `subscription_auth` — may this build authenticate to a model provider using
 *   an individual's consumer subscription rather than a metered API key. It
 *   requires `local_command_execution`, because the only supported mechanism
 *   is delegating to the provider's own signed-in CLI.
 */
export const CAPABILITIES = ['local_command_execution', 'subscription_auth'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Capabilities that cannot stand alone. Checked when a profile is computed, so
 * a future edit that grants `subscription_auth` without its prerequisite
 * produces a profile without it rather than a half-enforced feature. */
const REQUIRES: Partial<Record<Capability, Capability>> = Object.freeze({
  subscription_auth: 'local_command_execution',
});

/**
 * The table. CE is the only edition with anything in it, and the three empty
 * rows are not padding: they are what makes the boundary testable. The tests
 * compute a `hosted` profile from a `hosted` stamp and prove that every route,
 * factory and call path refuses — which is the only way to know that a hosted
 * build of this source would refuse, given no hosted build exists to try.
 */
const BY_EDITION: Readonly<Record<Edition, readonly Capability[]>> = Object.freeze({
  ce: Object.freeze(['local_command_execution', 'subscription_auth'] as const),
  hosted: Object.freeze([] as const),
  business: Object.freeze([] as const),
  white_label: Object.freeze([] as const),
});

/** The least capable edition. Where an unrecognised stamp lands. */
const FAIL_CLOSED: Edition = 'hosted';

export interface EditionProfile {
  readonly edition: Edition;
  readonly capabilities: readonly Capability[];
  /** True when the stamp was not a recognised edition, so the profile fell
   * closed. Surfaced in diagnostics — a build that silently became `hosted`
   * because of a typo should be visible to whoever built it. */
  readonly stampRecognised: boolean;
}

export class CapabilityUnavailable extends Error {
  constructor(readonly capability: Capability, readonly edition: Edition) {
    super(
      `this build does not have the "${capability}" capability`
      + ` (edition: ${edition}), and no setting can add it`,
    );
  }
}

export function isEdition(value: unknown): value is Edition {
  return typeof value === 'string' && (EDITIONS as readonly string[]).includes(value);
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Build a profile from a stamp and an environment.
 *
 * Exported with both inputs as arguments so the tests can compute a `hosted`
 * profile without a hosted build, and so nothing here has to read a global.
 *
 * The environment is consulted for exactly one variable and it can only
 * subtract. There is no branch below that adds a capability from any input.
 */
export function computeProfile(
  args: { stamp?: string; env?: NodeJS.ProcessEnv } = {},
): EditionProfile {
  const stamp = args.stamp ?? BUILD_EDITION;
  const stampRecognised = isEdition(stamp);
  const edition: Edition = stampRecognised ? stamp : FAIL_CLOSED;

  const disabled = parseDisabled(args.env ?? process.env);

  const granted = BY_EDITION[edition].filter((cap) => !disabled.has(cap));
  // Prerequisites, applied after narrowing: disabling the prerequisite disables
  // everything that needs it, which is the direction that is always safe.
  const capabilities = granted.filter((cap) => {
    const needs = REQUIRES[cap];
    return !needs || granted.includes(needs);
  });

  return Object.freeze({
    edition,
    capabilities: Object.freeze(capabilities),
    stampRecognised,
  });
}

/** `JOSI_DISABLED_CAPABILITIES=subscription_auth,local_command_execution`.
 *
 * Unknown names are ignored rather than rejected: an operator narrowing their
 * own installation should not have it refuse to start because they named a
 * capability that a later version removed. Ignoring cannot widen anything. */
function parseDisabled(env: NodeJS.ProcessEnv): ReadonlySet<Capability> {
  const raw = env.JOSI_DISABLED_CAPABILITIES ?? '';
  const out = new Set<Capability>();
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (isCapability(name)) out.add(name);
  }
  return out;
}

/** This process's profile. Computed once, at module load, from the build stamp
 * and the environment as it was at start. Re-reading `process.env` later would
 * make the boundary depend on whatever a request handler had set. */
export const EDITION_PROFILE: EditionProfile = computeProfile();

export function hasCapability(
  capability: Capability,
  profile: EditionProfile = EDITION_PROFILE,
): boolean {
  return profile.capabilities.includes(capability);
}

/** Refuse rather than return false, for the call paths where a caller who
 * ignores a boolean would proceed. */
export function assertCapability(
  capability: Capability,
  profile: EditionProfile = EDITION_PROFILE,
): void {
  if (!hasCapability(capability, profile)) {
    throw new CapabilityUnavailable(capability, profile.edition);
  }
}

/** What the UI and diagnostics are allowed to know. No secret, no key, no
 * path — the edition and its capabilities are printed on the About screen. */
export function describeEdition(profile: EditionProfile = EDITION_PROFILE): {
  edition: Edition;
  capabilities: Capability[];
  stampRecognised: boolean;
} {
  return {
    edition: profile.edition,
    capabilities: [...profile.capabilities],
    stampRecognised: profile.stampRecognised,
  };
}
