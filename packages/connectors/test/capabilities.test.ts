// The capability rule.
//
// The phase plan names the risk this file answers: "deny-only policy inverted
// by accident → an explicit effectiveCapability = min(userGrant, adminPolicy)
// function with a truth-table test." This is that test, and it enumerates every
// combination rather than sampling.
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES, IDENTITY_SCOPES, capabilitySpec, capabilityState, capabilitiesFor,
  effectiveCapability, grantedCapabilities, refusalReason, scopesFor,
} from '../src/capabilities.js';

const BOOLS = [false, true];

describe('the deny-only rule', () => {
  it('is the AND of all three inputs, for every combination', () => {
    for (const providerGranted of BOOLS) {
      for (const adminAllows of BOOLS) {
        for (const userEnabled of BOOLS) {
          const inputs = { providerGranted, adminAllows, userEnabled };
          expect(effectiveCapability(inputs), JSON.stringify(inputs))
            .toBe(providerGranted && adminAllows && userEnabled);
        }
      }
    }
  });

  /** The property that matters, stated as its own test rather than left to be
   * inferred from the table above. */
  it('never lets an administrator GRANT what the user did not enable', () => {
    for (const providerGranted of BOOLS) {
      const withAdmin = effectiveCapability({ providerGranted, adminAllows: true, userEnabled: false });
      expect(withAdmin, `providerGranted=${providerGranted}`).toBe(false);
    }
  });

  it('never lets an administrator GRANT what the provider withheld', () => {
    for (const userEnabled of BOOLS) {
      expect(effectiveCapability({ providerGranted: false, adminAllows: true, userEnabled })).toBe(false);
    }
  });

  it('always lets an administrator TAKE AWAY something fully enabled', () => {
    expect(effectiveCapability({ providerGranted: true, adminAllows: true, userEnabled: true })).toBe(true);
    expect(effectiveCapability({ providerGranted: true, adminAllows: false, userEnabled: true })).toBe(false);
  });

  it('is monotone: turning any input off can only ever remove the capability', () => {
    // A stronger statement than the table. If the answer is true, flipping any
    // single input to false must make it false — there is no combination where
    // removing a permission grants one.
    const inputs = { providerGranted: true, adminAllows: true, userEnabled: true };
    for (const key of ['providerGranted', 'adminAllows', 'userEnabled'] as const) {
      expect(effectiveCapability({ ...inputs, [key]: false }), key).toBe(false);
    }
  });
});

describe('the state a person is shown', () => {
  it('reports needs_consent before blocked_by_admin when both are true', () => {
    // Telling someone "your administrator blocked this" when the real problem
    // is that they never finished connecting sends them to the wrong person.
    expect(capabilityState({ providerGranted: false, adminAllows: false, userEnabled: true }))
      .toBe('needs_consent');
  });

  it('distinguishes off from blocked', () => {
    expect(capabilityState({ providerGranted: true, adminAllows: true, userEnabled: false })).toBe('off');
    expect(capabilityState({ providerGranted: true, adminAllows: false, userEnabled: false }))
      .toBe('blocked_by_admin');
  });

  it('agrees with effectiveCapability: on if and only if allowed', () => {
    for (const providerGranted of BOOLS) {
      for (const adminAllows of BOOLS) {
        for (const userEnabled of BOOLS) {
          const inputs = { providerGranted, adminAllows, userEnabled };
          expect(capabilityState(inputs) === 'on').toBe(effectiveCapability(inputs));
        }
      }
    }
  });

  it('gives every refusal a sentence naming what to do', () => {
    for (const state of ['needs_consent', 'blocked_by_admin', 'off'] as const) {
      const reason = refusalReason(state, 'google.mail.send');
      expect(reason.length, state).toBeGreaterThan(20);
      expect(reason, state).toMatch(/send email/i);
    }
    expect(refusalReason('on', 'google.mail.send')).toBe('');
  });
});

describe('scopes', () => {
  it('asks only for what is needed now, plus identity', () => {
    // M32: incremental. A read-only connect must not request write scope.
    const readOnly = scopesFor('google', ['google.calendar.read']);
    expect(readOnly).toContain('calendar.readonly');
    expect(readOnly).not.toContain('auth/calendar ');
    expect(readOnly).not.toContain('gmail.send');
    for (const identity of IDENTITY_SCOPES.google) expect(readOnly).toContain(identity);
  });

  it('asks for the write scope only when the write capability is requested', () => {
    const write = scopesFor('google', ['google.calendar.write']);
    expect(write.split(/\s+/)).toContain('https://www.googleapis.com/auth/calendar');
  });

  /** Learned against a live account in the engine: calendar.events can write
   * but cannot run freeBusy, so availability needs the full scope. */
  it('uses the full google calendar scope for writing, not calendar.events', () => {
    const spec = capabilitySpec('google.calendar.write')!;
    expect(spec.scopes).toEqual(['https://www.googleapis.com/auth/calendar']);
    expect(spec.scopes.join(' ')).not.toContain('calendar.events');
  });

  it('includes offline_access for microsoft, or there is no refresh token', () => {
    expect(IDENTITY_SCOPES.microsoft).toContain('offline_access');
  });

  it('ignores capabilities belonging to the other provider', () => {
    const scopes = scopesFor('google', ['microsoft.mail.send', 'google.mail.read']);
    expect(scopes).toContain('gmail.readonly');
    expect(scopes).not.toContain('Mail.Send');
  });
});

describe('what the provider actually granted', () => {
  it('derives capabilities from the granted scopes, not from what was asked', () => {
    const granted = grantedCapabilities(
      'google',
      'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email',
    );
    expect(granted).toEqual(['google.calendar.read']);
  });

  it('does not credit a capability whose scope was dropped', () => {
    // A provider that silently withholds a scope must not leave us believing
    // we have it.
    const granted = grantedCapabilities('google', 'https://www.googleapis.com/auth/userinfo.email');
    expect(granted).toEqual([]);
  });

  it('credits write when the full scope is present', () => {
    const granted = grantedCapabilities('google', 'https://www.googleapis.com/auth/calendar');
    expect(granted).toContain('google.calendar.write');
    // calendar.readonly is a different string; having `calendar` does not imply
    // it here, and the read capability is listed separately on purpose.
    expect(granted).not.toContain('google.calendar.read');
  });

  it('handles microsoft scopes', () => {
    expect(grantedCapabilities('microsoft', 'Mail.Read Calendars.Read')).toEqual(
      expect.arrayContaining(['microsoft.calendar.read', 'microsoft.mail.read']),
    );
    expect(grantedCapabilities('microsoft', 'Mail.Read')).not.toContain('microsoft.mail.send');
  });
});

describe('the catalogue', () => {
  it('has both providers, and every write capability names its consequence', () => {
    expect(capabilitiesFor('google').length).toBeGreaterThan(0);
    expect(capabilitiesFor('microsoft').length).toBeGreaterThan(0);
    for (const spec of CAPABILITIES) {
      if (spec.kind !== 'write') continue;
      // A consent screen that does not say what it permits is not consent.
      expect(spec.consequence, spec.key).toBeTruthy();
      expect(spec.consequence!.length, spec.key).toBeGreaterThan(20);
    }
  });

  it('has a unique key per capability', () => {
    const keys = CAPABILITIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keys start with their provider, so a key cannot be used against the wrong one', () => {
    for (const spec of CAPABILITIES) expect(spec.key.startsWith(`${spec.provider}.`), spec.key).toBe(true);
  });
});
