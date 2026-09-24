// The setup state machine.
//
// The client never chooses which step it is on. It submits to a named step
// endpoint, and the server decides whether that is the step the installation is
// actually waiting for. Everything else — the order, what counts as done, when
// setup may complete — is computed here from database state.
//
// This matters more than a normal wizard because until setup completes the
// routes are unauthenticated. The state machine IS the authorization.

export const SETUP_STEPS = [
  'host_checks',
  'owner',
  'domain',
  'llm',
  'smtp',
  'security',
  'telemetry',
  'review',
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

export function isSetupStep(value: unknown): value is SetupStep {
  return typeof value === 'string' && (SETUP_STEPS as readonly string[]).includes(value);
}

/** The first step not yet completed, or null when every step is done.
 *
 * Order comes from SETUP_STEPS, not from the stored array, so a `completed_steps`
 * value that has been reordered or contains junk cannot move the wizard
 * forward — only membership counts. */
export function nextStep(completed: readonly string[]): SetupStep | null {
  const done = new Set(completed);
  for (const step of SETUP_STEPS) {
    if (!done.has(step)) return step;
  }
  return null;
}

export type TransitionRefusal =
  | 'unknown_step'      // not a step name at all
  | 'already_completed' // this step is behind us
  | 'out_of_order'      // a later step submitted before its predecessors
  | 'setup_finished';   // the whole wizard is done

export type TransitionVerdict =
  | { ok: true }
  | { ok: false; reason: TransitionRefusal; expected: SetupStep | null };

/** Steps an operator may submit again while setup is still open.
 *
 * LB6.4 wants a review screen with a working "change this" action, and the
 * only alternative to re-submitting a step is reinstalling — which is what an
 * operator who typed one character of an SMTP host wrong was previously left
 * with.
 *
 * The list is short on purpose, and what it EXCLUDES is the point. `owner`
 * creates the single super admin; `domain`, `security` and `telemetry` record
 * decisions rather than credentials, and `telemetry` in particular must not be
 * re-openable, because a step that can be submitted twice is a consent that can
 * be flipped by a replayed request. Only the three steps that hold
 * configuration for an external service are revisable, and each of them
 * re-tests what it configures on the way through.
 *
 * `connectors` was the third until Google and Microsoft left the wizard: an
 * OAuth application cannot be registered before a public HTTPS domain exists,
 * so the step could never be completed on the LAN-only installation every
 * operator starts with. It lives in admin now. */
export const REVISABLE_STEPS: readonly SetupStep[] = ['llm', 'smtp'];

export function isRevisable(step: string): boolean {
  return (REVISABLE_STEPS as readonly string[]).includes(step);
}

/** May this submission be accepted right now?
 *
 * Rejecting a step that is already done is deliberate rather than idempotent:
 * a back-button resubmission of the owner step must not be treated as a fresh
 * attempt to create a super admin. The exception is `REVISABLE_STEPS`, and it
 * is an exception rather than a relaxation — see the note there. */
export function canSubmit(step: string, completed: readonly string[]): TransitionVerdict {
  const expected = nextStep(completed);
  if (!isSetupStep(step)) return { ok: false, reason: 'unknown_step', expected };
  if (completed.includes(step)) {
    return isRevisable(step) ? { ok: true } : { ok: false, reason: 'already_completed', expected };
  }
  if (expected === null) return { ok: false, reason: 'setup_finished', expected: null };
  if (step !== expected) return { ok: false, reason: 'out_of_order', expected };
  return { ok: true };
}

/** Every step must be behind us before setup may be sealed. Checked again
 * inside the completing transaction, so a step completed concurrently cannot
 * slip past this. */
export function canComplete(completed: readonly string[]): boolean {
  return nextStep(completed) === null;
}

export interface StepDescriptor {
  id: SetupStep;
  title: string;
  /** What the operator is deciding, in their words. */
  summary: string;
  /** Steps that write nothing when skipped. */
  skippable: boolean;
}

export const STEP_DESCRIPTORS: Record<SetupStep, StepDescriptor> = {
  host_checks: {
    id: 'host_checks',
    title: 'Check this machine',
    summary: 'Confirms this server can run Josi before anything is configured.',
    skippable: false,
  },
  owner: {
    id: 'owner',
    title: 'Your account',
    summary: 'Creates the one administrator account for this installation.',
    skippable: false,
  },
  domain: {
    id: 'domain',
    title: 'Address and HTTPS',
    summary: 'Where people reach Josi, and who terminates TLS.',
    skippable: false,
  },
  llm: {
    id: 'llm',
    title: 'Language model',
    summary: 'Which model Josi thinks with, and whether that means data leaves this server.',
    skippable: false,
  },
  smtp: {
    id: 'smtp',
    title: 'Email sending',
    summary: 'Two senders: system mail for invites and resets, and the address Josi writes from.',
    skippable: true,
  },
  security: {
    id: 'security',
    title: 'Security and privacy',
    summary: 'What Josi is allowed to reach, and what that exposes.',
    skippable: false,
  },
  telemetry: {
    id: 'telemetry',
    title: 'Anonymous usage data',
    summary: 'Off unless you switch it on. Never contents, credentials or anything identifying.',
    skippable: false,
  },
  review: {
    id: 'review',
    title: 'Review and finish',
    summary: 'Everything above, then setup closes permanently.',
    skippable: false,
  },
};
