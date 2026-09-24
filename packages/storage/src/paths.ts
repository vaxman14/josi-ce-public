// Containment. Every filesystem access in Josi CE goes through this file.
//
// THE THREAT
//
// A mapped folder is a standing grant to read somebody's files. The grant names
// a directory; the attacker's goal is to make a path that looks like it is
// inside that directory and is not. The ways in are well known and all of them
// have to be closed at once:
//
//   * `../` in the requested path
//   * an absolute path supplied where a relative one was expected
//   * a symlink inside the folder pointing out of it
//   * a path that only escapes after normalisation ("a/../../b")
//   * a prefix that matches textually but not structurally ("/data/roots/docs"
//     vs "/data/roots/docs-private" — the second starts with the first)
//   * NUL bytes, which truncate the path in some syscalls but not in the
//     JavaScript that checked it
//
// The last two are the ones that get missed. A `startsWith` check on the parent
// path is the classic wrong answer, and it is wrong specifically for sibling
// directories whose names share a prefix.
//
// The answer here is: normalise first, then compare against the root plus a
// separator, then resolve symlinks and check AGAIN. Checking once before
// resolution is checking the wrong string.
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export class PathEscape extends Error {}

/** Segments a path may never contain, whatever the platform. */
const FORBIDDEN_SEGMENTS = new Set(['..', '.']);

/** Cleans a caller-supplied relative path, or refuses it.
 *
 * Refusing is the common case for anything unusual. A legitimate filename this
 * rejects is a support ticket; a traversal it accepts is somebody else's
 * documents.
 */
export function safeRelativePath(input: string): string {
  if (typeof input !== 'string') throw new PathEscape('that is not a path');
  if (input.includes('\0')) throw new PathEscape('that path contains a null byte');
  if (isAbsolute(input)) throw new PathEscape('that path must be relative to the mapped folder');
  // Windows-style separators and drive letters, refused rather than translated:
  // CE runs in Linux containers, so anything shaped like a Windows path is a
  // caller doing something unexpected.
  if (/^[A-Za-z]:/.test(input) || input.includes('\\')) {
    throw new PathEscape('that path is not in the expected form');
  }

  const parts = input.split('/').filter((p) => p.length > 0);
  for (const part of parts) {
    if (FORBIDDEN_SEGMENTS.has(part)) throw new PathEscape('that path may not contain "." or ".."');
  }
  const cleaned = parts.join('/');
  // The empty path is the mapped folder itself, which is a legitimate thing to
  // ask for — `normalize('')` is '.', so this has to be answered before the
  // normal-form check rather than by it.
  if (cleaned === '') return '';
  // Normalising after the segment check, not before: `normalize` would happily
  // collapse "a/../b" into "b" and hide the fact that the caller sent a "..".
  if (normalize(cleaned) !== cleaned) throw new PathEscape('that path is not in normal form');
  return cleaned;
}

/** True when `child` is the same as, or genuinely inside, `parent`.
 *
 * Structural, not textual. "/data/roots/docs-private" is NOT inside
 * "/data/roots/docs", though it starts with the same characters.
 */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (c === p) return true;
  const rel = relative(p, c);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

export interface ResolvedPath {
  /** The path to actually open. Symlinks already resolved. */
  absolute: string;
  /** Where it sits relative to the root, for storing and displaying. */
  relative: string;
}

/**
 * Turns (root, relative path) into an absolute path that is proven to be inside
 * the root — including after every symlink on the way has been followed.
 *
 * `mustExist: false` is for creating a file: the leaf will not resolve yet, so
 * the deepest existing ancestor is checked instead. That is the containment
 * question that matters, because a file cannot be created outside a directory
 * that is itself inside the root — unless the leaf name is a symlink, which is
 * why the leaf is re-checked after creation by the caller that writes.
 */
export async function resolveWithin(
  rootPath: string,
  relativePath: string,
  opts: { mustExist?: boolean; realpathImpl?: (p: string) => Promise<string> } = {},
): Promise<ResolvedPath> {
  const rp = opts.realpathImpl ?? realpath;
  const cleanRelative = safeRelativePath(relativePath);
  const rootReal = await rp(rootPath).catch(() => {
    throw new PathEscape('that mapped folder is not available');
  });

  const candidate = cleanRelative ? join(rootReal, cleanRelative) : rootReal;
  // First check: the lexical path, before touching the filesystem. Cheap, and
  // it rejects the obvious cases without a syscall.
  if (!isInside(rootReal, candidate)) throw new PathEscape('that path is outside the mapped folder');

  // Second check: after symlinks. This is the one that catches a link inside
  // the folder pointing at /etc, which no amount of string handling would.
  let real: string;
  try {
    real = await rp(candidate);
  } catch (err) {
    if (opts.mustExist) throw new PathEscape('no such file in that folder');
    // The leaf does not exist yet. Walk up to something that does and check
    // that instead — a nonexistent leaf inside a contained directory is fine.
    real = await resolveDeepestExisting(rootReal, cleanRelative, rp);
  }
  if (!isInside(rootReal, real)) {
    throw new PathEscape('that path leaves the mapped folder through a link');
  }

  return { absolute: real === rootReal ? rootReal : join(rootReal, relative(rootReal, real)), relative: cleanRelative };
}

async function resolveDeepestExisting(
  rootReal: string,
  cleanRelative: string,
  rp: (p: string) => Promise<string>,
): Promise<string> {
  const parts = cleanRelative.split('/').filter(Boolean);
  for (let depth = parts.length - 1; depth >= 0; depth -= 1) {
    const ancestor = join(rootReal, ...parts.slice(0, depth));
    try {
      const realAncestor = await rp(ancestor);
      // Rebuild the full path under the RESOLVED ancestor. This is the control:
      // returning `join(rootReal, cleanRelative)` here would hand back a path
      // that only LOOKS contained, because the caller's containment check is
      // lexical once the leaf does not exist. A symlinked parent would smuggle
      // the remainder straight out of the folder.
      //
      // The caller re-checks the result, so an escaping ancestor is refused
      // there; that check and this one are deliberately both present.
      return join(realAncestor, ...parts.slice(depth));
    } catch (err) {
      if (err instanceof PathEscape) throw err;
      // Keep walking up.
    }
  }
  return rootReal;
}

/** The extension used for allowlist decisions.
 *
 * Lower-cased, without the dot, and taken from the LAST dot only:
 * "report.pdf.exe" is an `exe`, which is exactly the file an allowlist exists
 * to refuse. A dotfile with no extension ("`.bashrc`") has none. */
export function extensionOf(filename: string): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** Splits a path into the segments used for display, refusing anything the
 * resolver would refuse. Used by the UI so it cannot render a path the rest of
 * the system would never open. */
export function displaySegments(relativePath: string): string[] {
  return safeRelativePath(relativePath).split('/').filter(Boolean);
}

export { sep as pathSeparator };
