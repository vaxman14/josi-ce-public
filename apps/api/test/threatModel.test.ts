// Phase 11's acceptance criterion, executed.
//
//   "every threat-model entry links to a control and a test or is explicitly
//    accepted with a reason."
//
// A threat model is the easiest document in a project to let rot. Entries get
// written once, the code moves, and two releases later it describes a system
// that no longer exists — while still reading as though somebody checked.
//
// So it is parsed rather than read. Every entry must name a control file that
// EXISTS and a test that IS IN THE SUITE, or be marked accepted with a reason.
// A control that gets deleted, a test that gets renamed, or an entry somebody
// adds without either, all fail here.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../../..');
const source = readFileSync(join(root, 'docs/THREAT_MODEL.md'), 'utf8');

interface Entry {
  id: string;
  title: string;
  control?: string;
  test?: string;
  accepted?: string;
  attacker?: string;
  impact?: string;
}

/** Every `### T-nn Title` block and the fields under it. */
function parse(md: string): Entry[] {
  const entries: Entry[] = [];
  // The template inside "How to read an entry" is a fenced block; skip fences
  // so the example is not parsed as a real entry.
  const withoutFences = md.replace(/```[\s\S]*?```/g, '');

  const blocks = withoutFences.split(/^### /m).slice(1);
  for (const block of blocks) {
    const [heading, ...rest] = block.split('\n');
    const match = /^(T-\d+)\s+(.*)$/.exec(heading.trim());
    if (!match) continue;
    const body = rest.join('\n');

    const field = (name: string): string | undefined => {
      const re = new RegExp(`\\*\\*${name}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*|\\n---|$)`, 'i');
      const found = re.exec(body)?.[1]?.trim();
      return found || undefined;
    };

    entries.push({
      id: match[1],
      title: match[2].trim(),
      attacker: field('Attacker'),
      impact: field('Impact'),
      control: field('Control'),
      test: field('Test'),
      accepted: field('Accepted'),
    });
  }
  return entries;
}

const entries = parse(source);

/** Every `it(...)` and `describe(...)` title in the suite. */
function allTestTitles(): string[] {
  const titles: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.test\.ts$/.test(name)) continue;
      const src = readFileSync(full, 'utf8');
      // Single, double and template quotes; `it`, `it.each`, and `describe`.
      // `((?:\\.|[^\\])*?)` rather than `[\s\S]*?`: a title containing an
      // escaped apostrophe — "a colleague\'s document" — otherwise ends the
      // match early and the title is never found. That produced a failure
      // claiming a test did not exist when it did.
      for (const m of src.matchAll(/\b(?:it|test|describe)(?:\.each\([^)]*\))?\s*\(\s*(['"`])((?:\\.|[^\\])*?)\1/g)) {
        titles.push(m[2].replace(/\\'/g, "'").replace(/\s+/g, ' ').trim());
      }
    }
  };
  for (const dir of ['apps', 'packages']) walk(join(root, dir));
  return titles;
}

const testTitles = allTestTitles();

describe('the threat model is a document about this system', () => {
  it('has entries at all', () => {
    expect(entries.length).toBeGreaterThan(20);
  });

  it('numbers them uniquely', () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size, `duplicate ids: ${ids.join(', ')}`).toBe(ids.length);
  });

  it('covers every surface the phase plan names', () => {
    // Phase 11: "setup, auth, connectors, mapped folders, archive extraction,
    // OCR, ClamAV, backup/restore, update/rollback, diagnostics upload, LLM tool
    // execution."
    const text = source.toLowerCase();
    for (const surface of [
      'setup', 'sign-in', 'session', 'connector', 'mapped', 'archive',
      'ocr', 'scanner', 'backup', 'restore', 'update', 'rollback',
      'diagnostics', 'telemetry',
    ]) {
      expect(text, `no entry mentions ${surface}`).toContain(surface);
    }
  });
});

describe('every entry names a control and a test, or is accepted', () => {
  it.each(entries.map((e) => [e.id, e] as const))('%s', (_id, entry) => {
    if (entry.accepted) {
      // An accepted risk needs a REASON, not the word "accepted". A one-word
      // acceptance is how a threat model launders a decision nobody made.
      expect(entry.accepted.length, `${entry.id} is accepted without a reason`)
        .toBeGreaterThan(60);
      return;
    }

    expect(entry.control, `${entry.id} names no control and is not accepted`).toBeTruthy();
    expect(entry.test, `${entry.id} names no test and is not accepted`).toBeTruthy();
    expect(entry.attacker, `${entry.id} does not say who the attacker is`).toBeTruthy();
    expect(entry.impact, `${entry.id} does not say what the impact is`).toBeTruthy();
  });
});

describe('the controls exist', () => {
  const withControls = entries.filter((e) => e.control && !e.accepted);

  it.each(withControls.map((e) => [e.id, e] as const))('%s names a real file', (_id, entry) => {
    // "path/to/file.ts — prose". Take the path.
    const path = entry.control!.split(/[\s—]/)[0].replace(/[`,]/g, '');
    expect(path, `${entry.id}: control does not start with a path`).toMatch(/\.(ts|sql|sh)$/);
    expect(
      existsSync(join(root, path)),
      `${entry.id}: control file ${path} does not exist`,
    ).toBe(true);
  });

  it('explains the mechanism rather than just pointing', () => {
    for (const entry of withControls) {
      const prose = entry.control!.split('—').slice(1).join('—').trim();
      expect(prose.length, `${entry.id}: control names a file but not a mechanism`)
        .toBeGreaterThan(25);
    }
  });
});

describe('the tests exist', () => {
  const withTests = entries.filter((e) => e.test && !e.accepted);

  // The one that keeps the document honest as the code moves. Renaming a test
  // without updating the threat model fails here.
  it.each(withTests.map((e) => [e.id, e] as const))('%s names a test in the suite', (_id, entry) => {
    const wanted = entry.test!.replace(/\s+/g, ' ').trim();
    const found = testTitles.some((t) => t === wanted || t.includes(wanted));
    expect(
      found,
      `${entry.id}: no test titled "${wanted}". A threat model that names a test `
      + 'which does not exist is worse than one that names none.',
    ).toBe(true);
  });
});

describe('accepted risks are honest', () => {
  const accepted = entries.filter((e) => e.accepted);

  it('there are some', () => {
    // A threat model with no accepted risks is a threat model that has not been
    // thought about. Every real system has residual risk.
    expect(accepted.length).toBeGreaterThan(2);
  });

  it('none of them claims a control it does not have', () => {
    for (const entry of accepted) {
      expect(entry.control, `${entry.id} is accepted AND claims a control`).toBeFalsy();
    }
  });

  it('the host-compromise and administrator cases are among them', () => {
    // Both are genuinely outside what self-hosted software can offer, and a
    // threat model that quietly omits them is overclaiming.
    const text = accepted.map((e) => `${e.title} ${e.accepted}`).join(' ').toLowerCase();
    expect(text).toContain('root on the host');
    expect(text).toContain('administrator');
  });
});
