// Containment, tested against a real filesystem with real symlinks.
//
// These are not unit tests over string handling. A traversal defence that works
// on strings and fails on a symlink is the usual way this goes wrong, so the
// fixtures below build actual links — including one pointing at /etc, and one
// sibling directory whose name is a prefix of the mapped one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PathEscape, extensionOf, isInside, resolveWithin, safeRelativePath } from '../src/paths.js';

let base: string;
let root: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'josi-paths-'));
  root = join(base, 'docs');
  await mkdir(join(root, 'reports', 'q3'), { recursive: true });
  await writeFile(join(root, 'reports', 'q3', 'summary.txt'), 'inside');

  // A sibling whose name starts with the root's name. The classic `startsWith`
  // bug lets this through.
  await mkdir(join(base, 'docs-private'), { recursive: true });
  await writeFile(join(base, 'docs-private', 'salaries.csv'), 'SECRET');

  // A link inside the mapped folder pointing out of it, both to the sibling
  // and to a system path.
  await symlink(join(base, 'docs-private'), join(root, 'escape'));
  await symlink('/etc', join(root, 'etc-link'));
  // A link that stays inside, which must keep working.
  await symlink(join(root, 'reports'), join(root, 'reports-alias'));
});

afterAll(async () => { await rm(base, { recursive: true, force: true }); });

describe('safeRelativePath', () => {
  it('accepts ordinary relative paths', () => {
    expect(safeRelativePath('reports/q3/summary.txt')).toBe('reports/q3/summary.txt');
    expect(safeRelativePath('')).toBe('');
    expect(safeRelativePath('a//b')).toBe('a/b');
  });

  it('refuses traversal in every spelling', () => {
    for (const bad of [
      '../secrets', 'a/../../b', './a', 'a/./b', '..', '../', 'a/..',
    ]) {
      expect(() => safeRelativePath(bad), bad).toThrow(PathEscape);
    }
  });

  it('refuses absolute paths, drive letters and backslashes', () => {
    for (const bad of ['/etc/passwd', 'C:/Windows', 'a\\b', '\\\\server\\share']) {
      expect(() => safeRelativePath(bad), bad).toThrow(PathEscape);
    }
  });

  it('refuses a null byte', () => {
    // These deliberately contain NO traversal. An earlier version of this test
    // used "ok.txt\0../../etc/passwd", which the ".." check rejected on its own
    // — so the assertion passed while proving nothing about null bytes. Mutation
    // testing found it: deleting the null-byte guard broke no test.
    //
    // The risk is real: a NUL truncates the path in some syscalls but not in
    // the JavaScript that validated it, so the bytes after it can be invisible
    // to the check and visible to the kernel.
    for (const bad of ['ok.txt\0', 'ok\0.txt', 'reports\0/summary.txt']) {
      expect(() => safeRelativePath(bad), JSON.stringify(bad)).toThrow(PathEscape);
    }
  });
});

describe('isInside', () => {
  it('is structural, not textual', () => {
    // The whole point: "docs-private" starts with "docs" and is not inside it.
    expect(isInside('/data/roots/docs', '/data/roots/docs-private')).toBe(false);
    expect(isInside('/data/roots/docs', '/data/roots/docs/a')).toBe(true);
    expect(isInside('/data/roots/docs', '/data/roots/docs')).toBe(true);
    expect(isInside('/data/roots/docs', '/data/roots')).toBe(false);
  });
});

describe('resolveWithin', () => {
  it('resolves a real file inside the folder', async () => {
    const r = await resolveWithin(root, 'reports/q3/summary.txt', { mustExist: true });
    expect(r.relative).toBe('reports/q3/summary.txt');
    expect(r.absolute).toContain('summary.txt');
  });

  it('follows a symlink that stays inside', async () => {
    const r = await resolveWithin(root, 'reports-alias/q3/summary.txt', { mustExist: true });
    expect(r.absolute).toContain('summary.txt');
  });

  it('refuses a symlink that leaves the folder', async () => {
    // This is the test that a string-only implementation fails.
    await expect(resolveWithin(root, 'escape/salaries.csv', { mustExist: true }))
      .rejects.toThrow(PathEscape);
  });

  it('refuses a symlink to a system directory', async () => {
    await expect(resolveWithin(root, 'etc-link/passwd', { mustExist: true }))
      .rejects.toThrow(PathEscape);
  });

  it('refuses traversal even when the target exists', async () => {
    await expect(resolveWithin(root, '../docs-private/salaries.csv', { mustExist: true }))
      .rejects.toThrow(PathEscape);
  });

  it('allows a not-yet-existing file inside the folder', async () => {
    const r = await resolveWithin(root, 'reports/q3/new-file.txt', { mustExist: false });
    expect(r.absolute).toContain('new-file.txt');
    expect(r.absolute.startsWith(await realRoot())).toBe(true);
  });

  it('refuses a not-yet-existing file under an escaping link', async () => {
    // Creating INTO a symlinked-out directory is how a write escapes.
    await expect(resolveWithin(root, 'escape/new-file.txt', { mustExist: false }))
      .rejects.toThrow(PathEscape);
  });

  it('refuses when the folder itself is gone', async () => {
    await expect(resolveWithin(join(base, 'no-such-root'), 'a.txt', { mustExist: true }))
      .rejects.toThrow(PathEscape);
  });
});

async function realRoot(): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(root);
}

describe('extensionOf', () => {
  it('takes the last extension, lower-cased', () => {
    expect(extensionOf('report.PDF')).toBe('pdf');
    // The file an allowlist exists to refuse.
    expect(extensionOf('report.pdf.exe')).toBe('exe');
    expect(extensionOf('a/b/c.tar.gz')).toBe('gz');
  });

  it('treats a dotfile as having none', () => {
    expect(extensionOf('.bashrc')).toBe('');
    expect(extensionOf('README')).toBe('');
  });
});
