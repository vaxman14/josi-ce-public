// GENERATED FILE — the values stamped into an image at build time.
//
// `scripts/stamp-edition.mjs` rewrites this file during `docker build` from
// build arguments. It is committed with the Community Edition defaults so that
// a plain `tsc -b` from a source checkout produces a working CE build without
// anything extra.
//
// WHY A FILE AND NOT AN ENVIRONMENT VARIABLE
//
// The edition decides whether a capability exists at all, and an environment
// variable is whatever the person who started the container says it is. A
// hosted operator who can set `JOSI_EDITION=ce` on a hosted image has not
// crossed a boundary, they have read a label. A constant compiled into the
// bundle is a property of the artefact: changing it means rebuilding, and a
// rebuild is a different image with a different digest.
//
// Nothing in this file is a secret. The release public key is public by
// definition, and the edition is printed in the UI.

/** Which edition this artefact is. Validated by `edition.ts`; an unrecognised
 * value resolves to the LEAST capable edition, never to CE. */
export const BUILD_EDITION = 'ce';

/** Base64 Ed25519 public key (raw 32 bytes) that release manifests must be
 * signed with.
 *
 * `null` by default, and that is deliberate rather than unfinished: a build
 * with no stamped key can verify no release, so `checkForUpdate` reports that
 * this build cannot verify updates instead of accepting an unsigned one. The
 * publisher stamps their key when they build the official image; an operator
 * building from source stamps their own or has no update channel, which is the
 * honest pair of options. */
export const BUILD_RELEASE_PUBLIC_KEY: string | null = null;

/** Base64 Ed25519 public key (raw 32 bytes) that LICENCES must be signed with.
 *
 * Separate from the release key on purpose: they are different authorities over
 * different things, and a build that can verify a release is not thereby
 * entitled to decide what is licensed. Stamped by the publisher when they build
 * the supported image.
 *
 * `null` here for the same reason as above — a source build cannot verify a
 * licence, and says so, rather than accepting an unverified one. */
export const BUILD_LICENCE_PUBLIC_KEY: string | null = null;

/** Free-text build identifier — a git sha for an official build, `source` for
 * a local one. Shown in diagnostics. Never used for a security decision. */
export const BUILD_ID = 'source';
