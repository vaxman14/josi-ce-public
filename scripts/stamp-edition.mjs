#!/usr/bin/env node
// Writes packages/core/src/buildStamp.ts from build arguments.
//
// Run inside `docker build`, BEFORE `tsc -b`, so the constant is compiled into
// the bundle rather than read at start. That is the whole point: see the
// comment at the top of edition.ts.
//
//   node scripts/stamp-edition.mjs --edition hosted --build-id "$(git rev-parse --short HEAD)"
//   node scripts/stamp-edition.mjs --release-key "$(cat release-signing.pub.b64)"
//
// Refuses an unrecognised edition rather than writing it. `edition.ts` also
// fails closed on an unrecognised stamp, but a build that was meant to be
// `hosted` and silently became `hosted-because-typo` is a build whose operator
// learns about the typo from a support ticket. Two chances to notice.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'packages/core/src/buildStamp.ts');

// Kept in step with EDITIONS in edition.ts by a test, not by hope.
const EDITIONS = ['ce', 'hosted', 'business', 'white_label'];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  const env = process.env[`JOSI_${name.toUpperCase().replace(/-/g, '_')}`];
  return env !== undefined && env !== '' ? env : fallback;
}

const edition = arg('edition', 'ce');
if (!EDITIONS.includes(edition)) {
  console.error(
    `stamp-edition: "${edition}" is not an edition. One of: ${EDITIONS.join(', ')}`,
  );
  process.exit(2);
}

const buildId = arg('build-id', 'source');
if (!/^[A-Za-z0-9._-]{1,64}$/.test(buildId)) {
  console.error('stamp-edition: --build-id must be 1-64 chars of [A-Za-z0-9._-]');
  process.exit(2);
}

// Empty string and the literal "none" both mean "no key", so a Dockerfile can
// pass an unset build arg through without special-casing it.
function publicKeyArg(name) {
  const raw = arg(name, '');
  if (!raw || raw === 'none') return 'null';
  // A raw Ed25519 public key is 32 bytes: 44 base64 characters with padding.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    console.error(
      `stamp-edition: --${name} must be a base64 raw Ed25519 public key (32 bytes)`,
    );
    process.exit(2);
  }
  return JSON.stringify(raw);
}

const releaseKey = publicKeyArg('release-key');
// Separate from the release key on purpose: different authorities over
// different things. A build that can verify a release is not thereby entitled
// to decide what is licensed.
const licenceKey = publicKeyArg('licence-key');

// Preserve the file's prose and rewrite only the three values, so the reasoning
// at the top of buildStamp.ts survives every rebuild.
const original = readFileSync(TARGET, 'utf8');
let out = original
  .replace(/export const BUILD_EDITION = '[^']*';/, `export const BUILD_EDITION = '${edition}';`)
  .replace(
    /export const BUILD_RELEASE_PUBLIC_KEY: string \| null = [^;]*;/,
    `export const BUILD_RELEASE_PUBLIC_KEY: string | null = ${releaseKey};`,
  )
  .replace(
    /export const BUILD_LICENCE_PUBLIC_KEY: string \| null = [^;]*;/,
    `export const BUILD_LICENCE_PUBLIC_KEY: string | null = ${licenceKey};`,
  )
  .replace(/export const BUILD_ID = '[^']*';/, `export const BUILD_ID = '${buildId}';`);

// A replace that matched nothing would leave the previous edition in place —
// the single most dangerous silent failure this script has, because it would
// ship a CE-capable hosted image.
for (const [what, needle] of [
  ['edition', `export const BUILD_EDITION = '${edition}';`],
  ['release key', `export const BUILD_RELEASE_PUBLIC_KEY: string | null = ${releaseKey};`],
  ['licence key', `export const BUILD_LICENCE_PUBLIC_KEY: string | null = ${licenceKey};`],
  ['build id', `export const BUILD_ID = '${buildId}';`],
]) {
  if (!out.includes(needle)) {
    console.error(`stamp-edition: could not stamp the ${what} — buildStamp.ts is not the shape this script expects`);
    process.exit(3);
  }
}

writeFileSync(TARGET, out);
console.log(
  `stamped edition=${edition} build-id=${buildId} `
  + `release-key=${releaseKey === 'null' ? 'none' : 'set'} `
  + `licence-key=${licenceKey === 'null' ? 'none' : 'set'}`,
);
