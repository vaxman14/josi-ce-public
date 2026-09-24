// LB12 — plumbing is behind a label, not on the screen.
//
// The failure this prevents is small and constant: a screen renders
// `insufficient_scope`, or `needs_reconnect`, or `awaiting_owner`, because that
// is what the column holds. Each one is correct, none is a sentence, and the
// person reading it has to know the schema to act on it.
//
// The rule is NOT "hide it". LB12.4 is explicit that warnings, consent,
// security choices and failure detail survive the simplification — so the
// checks below assert both halves: no bare identifier reaches a screen, AND the
// sentences that carry the same information are still there.
//
// The vocabulary is checked against the DATABASE rather than maintained by
// hand. A state added in SQL with no plain-language entry fails here, which is
// the only way a mapping like this stays true as the schema moves.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { VOCABULARIES, plain, plainDetail } from '../../web/src/lib/plainLanguage.js';

const root = join(import.meta.dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** Every migration, concatenated in order. */
const migrations = readdirSync(join(root, 'packages/db/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => read(`packages/db/migrations/${f}`))
  .join('\n');

/** The values a column's CHECK constraint permits.
 *
 * Handles both shapes the schema uses: a column inside `create table`, and one
 * added later by `alter table ... add column`. */
function checkValues(table: string, column: string): string[] {
  // `alter table <t> add column ... <c> text ... check (<c> in ('a','b'))`
  // `check (col in (...))` and `check (col is null or col in (...))` — a
  // nullable enum is still an enum, and missing it silently skipped a whole
  // vocabulary.
  const alter = new RegExp(
    `alter\\s+table\\s+${table}\\s+add\\s+column[^;]*?\\b${column}\\b[^;]*?check\\s*\\([^;]*?${column}\\s+in\\s*\\(([^)]*)\\)`,
    'is',
  ).exec(migrations);
  if (alter) return literals(alter[1]);

  // Inside `create table <t> ( ... );`
  const block = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i')
    .exec(migrations);
  if (!block) throw new Error(`no create table for ${table}`);
  const inside = new RegExp(`\\b${column}\\b[^,]*?check\\s*\\([^)]*?${column}\\s+in\\s*\\(([\\s\\S]*?)\\)\\s*\\)`, 'i')
    .exec(block[1]);
  if (!inside) throw new Error(`no CHECK for ${table}.${column}`);
  return literals(inside[1]);
}

const literals = (raw: string): string[] =>
  [...raw.matchAll(/'([a-z0-9_]+)'/gi)].map((m) => m[1]);

// ---------------------------------------------------------------- vocabulary

describe('the vocabulary matches the database', () => {
  const sqlBacked = Object.entries(VOCABULARIES)
    .filter(([, v]) => 'migrationTable' in v.source)
    .map(([name, v]) => [name, v, v.source as { migrationTable: string; column: string }] as const);

  it('covers something', () => {
    expect(sqlBacked.length).toBeGreaterThan(4);
  });

  it.each(sqlBacked.map(([name]) => name))('%s labels every value the column permits', (name) => {
    const [, vocab, source] = sqlBacked.find(([n]) => n === name)!;
    const permitted = checkValues(source.migrationTable, source.column);
    expect(permitted.length, `${source.migrationTable}.${source.column} has no values`).toBeGreaterThan(1);

    for (const value of permitted) {
      expect(
        vocab.labels[value],
        `${name}: ${source.migrationTable}.${source.column} can be '${value}' and nothing says what that means`,
      ).toBeTruthy();
    }
  });

  it.each(sqlBacked.map(([name]) => name))('%s invents no value the column cannot hold', (name) => {
    // A label for a state that cannot happen is a label nobody maintains.
    const [, vocab, source] = sqlBacked.find(([n]) => n === name)!;
    const permitted = new Set(checkValues(source.migrationTable, source.column));
    for (const value of Object.keys(vocab.labels)) {
      expect(permitted.has(value), `${name}: '${value}' is not a value ${source.migrationTable}.${source.column} can hold`).toBe(true);
    }
  });

  it('keeps the connector error list in step with the type it describes', () => {
    // Not a database column, so it is asserted against the union's own source.
    const source = read('packages/connectors/src/providers.ts');
    const union = /export type ErrorCategory =([\s\S]*?);/.exec(source)?.[1] ?? '';
    const members = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(members.length).toBeGreaterThan(3);

    const labels = VOCABULARIES.connector_error.labels;
    for (const member of members) {
      expect(labels[member], `connector_error: nothing says what '${member}' means`).toBeTruthy();
    }
    expect(Object.keys(labels).sort()).toEqual([...members].sort());
  });

  it('keeps the model provider list in step with the type it describes', () => {
    // `llm_providers.provider` carries no CHECK — it is validated in code — so
    // the union is the source of truth and this is what notices a new one.
    const types = read('packages/llm/src/types.ts');
    const union = /export type ProviderKind =([\s\S]*?);/.exec(types)?.[1] ?? '';
    const members = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(members.length).toBeGreaterThan(3);

    const labels = VOCABULARIES.model_provider.labels;
    for (const member of members) {
      expect(labels[member], `model_provider: nothing says what '${member}' means`).toBeTruthy();
    }
    expect(Object.keys(labels).sort()).toEqual([...members].sort());
  });

  it('says something a person could act on, not a prettier identifier', () => {
    for (const [name, vocab] of Object.entries(VOCABULARIES)) {
      for (const [value, label] of Object.entries(vocab.labels)) {
        // "needs_reconnect" -> "Needs reconnect" would pass a naive check and
        // teach nobody anything.
        expect(label, `${name}.${value} is just the identifier`).not.toBe(value);
        // A multi-word identifier whose label is just the identifier tidied
        // up — `needs_reconnect` -> "Needs reconnect" — has told the reader
        // nothing they did not already see. That is allowed only when a
        // sentence underneath explains it, which is the case for genuinely
        // well-named states like `import_only`.
        const mechanical = label.replace(/\s+/g, '_').toLowerCase() === value;
        if (value.includes('_') && mechanical) {
          expect(
            vocab.detail?.[value],
            `${name}.${value}: the label is the identifier with spaces and nothing explains it`,
          ).toBeTruthy();
        }
        expect(label.length, `${name}.${value} is too short to say anything`).toBeGreaterThan(2);
      }
    }
  });

  it('falls back to the raw value rather than rendering nothing', () => {
    // A screen that shows nothing for an unknown state hides a state. The test
    // above is what stops an unknown one existing; this is what happens if it
    // does anyway.
    expect(plain('connection_status', 'active')).toBe('Working');
    expect(plain('connection_status', 'something_new')).toBe('something_new');
    expect(plain('connection_status', null)).toBe('');
    expect(plainDetail('connection_status', 'active')).toBeNull();
  });
});

// ------------------------------------------------------------- the screens

/** Every page component. */
function pageSources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(root, rel)).isDirectory()) { walk(rel); continue; }
      if (name.endsWith('.tsx')) out.push([rel, read(rel)]);
    }
  };
  walk('apps/web/src/pages');
  return out;
}

const pages = pageSources();

describe('LB12.2 — no screen renders a bare database value', () => {
  /** Fields that hold an enum rather than something a person wrote. */
  const PLUMBING = [
    'status', 'state', 'conflict_state', 'source', 'sync_mode', 'syncMode',
    'last_error_category', 'lastErrorCategory', 'category', 'provider',
  ];

  it('renders none of them directly', () => {
    const offenders: string[] = [];
    for (const [file, src] of pages) {
      // `{thing.field}` on its own — the shape that puts a raw identifier on
      // screen. Anything wrapped in a call, a map lookup or a ternary is not
      // matched, because that is the fix.
      for (const match of src.matchAll(/(^|[^$=])\{\s*([a-zA-Z_$][\w$]*)\.([a-zA-Z_$][\w$]*)\s*\}/g)) {
        // Two things that look like a render and are not: `${x.y}` is
        // template-literal interpolation, and `key={x.y}` / `id={x.y}` is an
        // attribute. Neither is text a person reads.
        if (!PLUMBING.includes(match[3])) continue;
        offenders.push(`${file}: {${match[2]}.${match[3]}}`);
      }
    }
    expect(
      offenders,
      `render these through plain(): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('uses the shared vocabulary where it shows one', () => {
    // A page that shows a connection status must go through the vocabulary,
    // not build its own map — two maps is how one of them goes stale.
    for (const [file, src] of pages) {
      if (!/lastErrorCategory|last_error_category/.test(src)) continue;
      expect(src, `${file} shows a connector error without the shared vocabulary`)
        .toMatch(/plain(Detail)?\(\s*'connector_error'/);
    }
  });
});

describe('LB12.2 — what must be pasted elsewhere can be copied', () => {
  it('gives the OAuth callback a copy control', () => {
    // A redirect URL transcribed by hand and the one the server honours have
    // to be the same string; a mismatch produces the provider's error page
    // rather than ours, which is the hardest connector failure to diagnose.
    const connectors = read('apps/web/src/pages/admin/Connectors.tsx');
    expect(connectors).toMatch(/<Copyable[\s\S]{0,200}suggested/);
  });

  it('has one Copyable, not one per page', () => {
    const ui = read('apps/web/src/components/ui/index.tsx');
    expect(ui).toMatch(/export function Copyable/);
    for (const [file, src] of pages) {
      expect(src, `${file} defines its own Copyable`).not.toMatch(/function Copyable\s*\(/);
    }
  });
});

describe('LB12.2 — advanced detail is behind a label, and reachable', () => {
  it('puts the redirect-URL override behind a labelled disclosure', () => {
    const connectors = read('apps/web/src/pages/admin/Connectors.tsx');
    expect(connectors).toMatch(/<details/);
    expect(connectors).toMatch(/Advanced — override the redirect URL/);
    // Still editable: an installation behind a path-rewriting proxy needs it.
    expect(connectors).toMatch(/name="redirectUri"/);
  });

  it('puts the exact model identifier behind one in the wizard', () => {
    // The model step now lives in the shared ProviderForm (so the admin Model
    // page can offer the same choices — round-2 item 8); the disclosure moved
    // with it and the wizard renders it unchanged.
    const form = read('apps/web/src/components/ProviderForm.tsx');
    expect(form).toMatch(/Show technical details/);
    expect(form, 'the identifier is still reachable').toMatch(/Model identifier/);
  });
});

describe('LB12.4 — nothing necessary was removed', () => {
  const setup = read('apps/web/src/pages/Setup.tsx');
  const connectors = read('apps/web/src/pages/admin/Connectors.tsx');

  it('keeps the consent the server refuses to proceed without', () => {
    // M89. Simplifying this away would leave the server refusing a step for a
    // reason the screen no longer explains. The model step lives in the shared
    // ProviderForm now; the wizard still renders it.
    const form = read('apps/web/src/components/ProviderForm.tsx');
    expect(form).toMatch(/leaves this server and is processed under/i);
    expect(form).toMatch(/name="ack"/);
  });

  it('keeps the master-key warning', () => {
    const checklist = read('apps/web/src/pages/admin/LaunchChecklist.tsx');
    expect(`${setup}${checklist}`).toMatch(/master.key|copied it somewhere safe/i);
  });

  it('keeps failure detail rather than a generic apology', () => {
    // Every screen that can fail shows what the server said, not "something
    // went wrong".
    for (const [file, src] of pages) {
      if (!/ErrorNote/.test(src)) continue;
      expect(src, `${file} discards the server's message`).toMatch(/err instanceof (Api)?Error \? err\.message|resource\.message|\{error\}|\{.*\.detail\}|\{.*message\}/);
    }
  });

  it('keeps the security choices on the connector policy screen', () => {
    expect(connectors).toMatch(/can only take permissions away/i);
    expect(connectors).toMatch(/does not switch it on for anyone/i);
  });

  it('still says what a scope will let Josi do', () => {
    // Least privilege is only meaningful if the person is told what they are
    // granting; hiding the scopes entirely would be simplification that costs
    // consent.
    //
    // Asserted against the admin page rather than the wizard: registering the
    // Google and Microsoft applications left setup, because it cannot be done
    // before a public HTTPS domain exists. The disclosure had to travel with
    // it, and this test is what makes sure it did rather than being quietly
    // dropped along with the step.
    expect(connectors).toMatch(/Permissions this will ask each person for/);
    expect(connectors).toMatch(/Read-only/);
  });
});
