// The edition capability boundary (L4).
//
// The interesting tests here are the ones that try to BREAK the boundary. A
// test that computes a CE profile and finds CE capabilities proves nothing —
// the question is whether a hosted build can be talked into CE's behaviour by
// an environment variable, a typo, a mutation of the exported object, or a
// half-granted prerequisite.
import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITIES, CapabilityUnavailable, EDITIONS, EDITION_PROFILE,
  assertCapability, computeProfile, describeEdition, hasCapability, isCapability, isEdition,
} from '../src/edition.js';
import { BUILD_EDITION } from '../src/buildStamp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** No env at all, so a test never inherits the developer's shell. */
const CLEAN: NodeJS.ProcessEnv = {};

describe('the build stamp decides the edition (L4.1)', () => {
  it('a source checkout is CE', () => {
    expect(BUILD_EDITION).toBe('ce');
    expect(EDITION_PROFILE.edition).toBe('ce');
    expect(EDITION_PROFILE.stampRecognised).toBe(true);
  });

  it('CE has the capabilities the boundary exists to protect', () => {
    const ce = computeProfile({ stamp: 'ce', env: CLEAN });
    expect([...ce.capabilities].sort()).toEqual(['local_command_execution', 'subscription_auth']);
  });

  it('a hosted stamp produces a build with none of them', () => {
    for (const edition of ['hosted', 'business', 'white_label'] as const) {
      const profile = computeProfile({ stamp: edition, env: CLEAN });
      expect(profile.edition).toBe(edition);
      expect(profile.capabilities).toEqual([]);
      expect(hasCapability('subscription_auth', profile)).toBe(false);
      expect(hasCapability('local_command_execution', profile)).toBe(false);
    }
  });

  it('an unrecognised stamp falls to the LEAST capable edition, not to CE', () => {
    for (const junk of ['CE', 'ce ', 'community', '', 'enterprise', '__proto__']) {
      const profile = computeProfile({ stamp: junk, env: CLEAN });
      expect(profile.edition).toBe('hosted');
      expect(profile.capabilities).toEqual([]);
      // And it says so, so a mis-stamped build is visible to whoever built it
      // rather than only to whoever files the support ticket.
      expect(profile.stampRecognised).toBe(false);
    }
  });
});

describe('the environment may narrow and may never widen (L4.2)', () => {
  // Every spelling somebody would reach for. The point is not that these
  // particular names are read — it is that NONE of them are.
  const WIDENING_ATTEMPTS: NodeJS.ProcessEnv[] = [
    { JOSI_EDITION: 'ce' },
    { JOSI_EDITION: 'ce', JOSI_BUILD_ID: 'anything' },
    { JOSI_CAPABILITIES: 'subscription_auth' },
    { JOSI_ENABLED_CAPABILITIES: 'subscription_auth,local_command_execution' },
    { JOSI_ENABLE_SUBSCRIPTION_AUTH: 'true' },
    { JOSI_SUBSCRIPTION_AUTH: '1' },
    { JOSI_DISABLED_CAPABILITIES: '' },
    // The narrowing variable itself, misused as a grant list.
    { JOSI_DISABLED_CAPABILITIES: 'hosted', JOSI_EDITION: 'ce' },
    { NODE_ENV: 'development', JOSI_EDITION: 'ce' },
  ];

  it('no environment turns a hosted build into a CE one', () => {
    for (const env of WIDENING_ATTEMPTS) {
      const profile = computeProfile({ stamp: 'hosted', env });
      expect(profile.edition, JSON.stringify(env)).toBe('hosted');
      expect(profile.capabilities, JSON.stringify(env)).toEqual([]);
    }
  });

  it('narrowing works, because an operator asking for less should get it', () => {
    const narrowed = computeProfile({
      stamp: 'ce',
      env: { JOSI_DISABLED_CAPABILITIES: 'subscription_auth' },
    });
    expect(narrowed.edition).toBe('ce');
    expect(narrowed.capabilities).toEqual(['local_command_execution']);
  });

  it('disabling a prerequisite disables what depends on it', () => {
    // Naming only the prerequisite must not leave the dependent capability
    // enabled with its foundation removed — that is the shape where a feature
    // half-works and the half that works is the dangerous half.
    const narrowed = computeProfile({
      stamp: 'ce',
      env: { JOSI_DISABLED_CAPABILITIES: 'local_command_execution' },
    });
    expect(narrowed.capabilities).toEqual([]);
  });

  it('an unknown capability name in the narrowing list is ignored, not fatal', () => {
    const profile = computeProfile({
      stamp: 'ce',
      env: { JOSI_DISABLED_CAPABILITIES: 'nonsense, , subscription_auth ,also_nonsense' },
    });
    // Ignoring an unknown name cannot widen anything, and refusing to start
    // because a later version removed a capability an operator had disabled
    // would be an outage caused by tidying up.
    expect(profile.capabilities).toEqual(['local_command_execution']);
  });
});

describe('the resolved profile cannot be edited at runtime (L4.4)', () => {
  it('the profile and its capability list are frozen', () => {
    expect(Object.isFrozen(EDITION_PROFILE)).toBe(true);
    expect(Object.isFrozen(EDITION_PROFILE.capabilities)).toBe(true);
  });

  it('pushing onto the capability list of a hosted profile does nothing', () => {
    const hosted = computeProfile({ stamp: 'hosted', env: CLEAN });
    // Both spellings a handler would reach for. In a module (strict mode) these
    // throw; the assertion that matters is the state afterwards either way.
    expect(() => (hosted.capabilities as string[]).push('subscription_auth')).toThrow();
    expect(() => {
      (hosted as { edition: string }).edition = 'ce';
    }).toThrow();
    expect(hosted.capabilities).toEqual([]);
    expect(hosted.edition).toBe('hosted');
    expect(hasCapability('subscription_auth', hosted)).toBe(false);
  });

  it('describeEdition hands out a copy, so a caller cannot mutate the source', () => {
    const described = describeEdition(EDITION_PROFILE);
    described.capabilities.length = 0;
    expect(EDITION_PROFILE.capabilities.length).toBeGreaterThan(0);
  });
});

describe('assertCapability refuses rather than returning false', () => {
  it('throws a typed error naming the capability and the edition', () => {
    const hosted = computeProfile({ stamp: 'hosted', env: CLEAN });
    let thrown: unknown;
    try {
      assertCapability('subscription_auth', hosted);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CapabilityUnavailable);
    expect((thrown as CapabilityUnavailable).capability).toBe('subscription_auth');
    expect((thrown as CapabilityUnavailable).edition).toBe('hosted');
    // The message has to close the door rather than suggest a knob.
    expect((thrown as Error).message).toContain('no setting can add it');
  });

  it('passes on CE', () => {
    const ce = computeProfile({ stamp: 'ce', env: CLEAN });
    expect(() => assertCapability('subscription_auth', ce)).not.toThrow();
  });
});

describe('type guards', () => {
  it('recognise exactly the declared values', () => {
    for (const e of EDITIONS) expect(isEdition(e)).toBe(true);
    for (const c of CAPABILITIES) expect(isCapability(c)).toBe(true);
    for (const junk of [null, undefined, 42, {}, 'CE', 'subscription-auth', 'toString']) {
      expect(isEdition(junk)).toBe(false);
      expect(isCapability(junk)).toBe(false);
    }
  });
});

describe('the stamp script and the module agree (L4.1)', () => {
  const script = readFileSync(join(ROOT, 'scripts/stamp-edition.mjs'), 'utf8');

  it('the script validates against the same edition list', () => {
    // The script refuses an unrecognised edition and the module falls closed on
    // one. If the two lists drift, a legitimate edition becomes un-stampable or
    // a stamped one becomes unrecognised — both silent until someone builds.
    const listed = /const EDITIONS = \[([^\]]*)\]/.exec(script)?.[1] ?? '';
    const names = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(names.sort()).toEqual([...EDITIONS].sort());
  });

  it('the script refuses to write a stamp it could not verify afterwards', () => {
    // The one silent failure that would ship a CE-capable hosted image is a
    // replace that matched nothing and left the previous value in place.
    expect(script).toContain('could not stamp the');
    expect(script).toContain('process.exit(3)');
  });

  it('the Dockerfile stamps before it compiles', () => {
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    const stampAt = dockerfile.indexOf('scripts/stamp-edition.mjs');
    const compileAt = dockerfile.indexOf('RUN npx tsc -b');
    expect(stampAt).toBeGreaterThan(-1);
    expect(compileAt).toBeGreaterThan(-1);
    // Stamping after the compile would put the constant in the source and the
    // OLD constant in the bundle — the artefact would lie about itself.
    expect(stampAt).toBeLessThan(compileAt);
  });

  it('source builds fail closed while supported releases stamp the publisher licence verifier', () => {
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    const workflow = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    const publisherKey = readFileSync(
      join(ROOT, 'publisher/licence-verification-key.b64'),
      'utf8',
    ).trim();

    // A raw Ed25519 public key is 32 bytes. The private signing key must never
    // be present in this public repository or passed to Docker.
    expect(publisherKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(publisherKey, 'base64')).toHaveLength(32);
    expect(dockerfile).toContain('ARG JOSI_LICENCE_KEY=none');
    expect(dockerfile).toContain('--licence-key "$JOSI_LICENCE_KEY"');
    expect(workflow).toContain('publisher/licence-verification-key.b64');
    expect(workflow).toContain('JOSI_LICENCE_KEY=${{ steps.licence-key.outputs.value }}');
    expect(workflow).not.toMatch(/PRIVATE[_ -]?KEY/i);
  });

  it('the packaging stamp embeds the public verifier only when explicitly supplied', () => {
    const root = mkdtempSync(join(tmpdir(), 'josi-licence-stamp-'));
    const target = join(root, 'packages/core/src/buildStamp.ts');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(ROOT, 'scripts/stamp-edition.mjs'), join(root, 'scripts/stamp-edition.mjs'));
    cpSync(join(ROOT, 'packages/core/src/buildStamp.ts'), target);
    const publisherKey = readFileSync(
      join(ROOT, 'publisher/licence-verification-key.b64'),
      'utf8',
    ).trim();

    try {
      execFileSync(process.execPath, [
        join(root, 'scripts/stamp-edition.mjs'),
        '--build-id', 'supported-test',
        '--licence-key', publisherKey,
      ]);
      expect(readFileSync(target, 'utf8')).toContain(
        `BUILD_LICENCE_PUBLIC_KEY: string | null = ${JSON.stringify(publisherKey)}`,
      );

      // Reset to the committed source stamp, then run the ordinary source-build
      // path. Absence must mean null, never a test key or permissive fallback.
      cpSync(join(ROOT, 'packages/core/src/buildStamp.ts'), target);
      execFileSync(process.execPath, [
        join(root, 'scripts/stamp-edition.mjs'),
        '--build-id', 'source-test',
      ]);
      expect(readFileSync(target, 'utf8')).toContain(
        'BUILD_LICENCE_PUBLIC_KEY: string | null = null',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
