// Channels in the navigation.
//
// Telegram had top-level sidebar items of its own while also being the one
// entry in packages/channels — the first transport presented as though it were
// a category. Those are duplicates: the same thing named twice at two different
// levels, and they would have forced every later channel to be either another
// top-level item or an inconsistency.
//
// These read the source rather than a rendered page because what is being
// asserted is structural: which entries the sidebar declares, and where the
// routes point. A screenshot test would not fail if Telegram came back as a
// second top-level item beside Channels.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const shell = read('apps/web/src/components/layout/Shell.tsx');
const app = read('apps/web/src/App.tsx');
const channels = read('apps/web/src/pages/Channels.tsx');

/** The member sidebar array, as declared. */
function memberNav(): string {
  const start = shell.indexOf('const MEMBER_NAV');
  const end = shell.indexOf('];', start);
  expect(start, 'MEMBER_NAV must still be findable').toBeGreaterThan(-1);
  return shell.slice(start, end);
}

/** The administrator sidebar array, as declared. */
function adminNav(): string {
  const start = shell.indexOf('const ADMIN_NAV');
  const end = shell.indexOf('];', start);
  expect(start, 'ADMIN_NAV must still be findable').toBeGreaterThan(-1);
  return shell.slice(start, end);
}

describe('one Channels parent, not one item per transport', () => {
  it('gives the member sidebar a Channels entry', () => {
    expect(memberNav()).toContain("{ to: '/app/channels', label: 'Channels' }");
  });

  it('does not also carry Telegram at the top level', () => {
    const nav = memberNav();
    expect(nav).not.toContain("label: 'Telegram'");
    expect(nav).not.toContain("/app/telegram");
  });

  it('does not give administrators a second top-level Telegram entry', () => {
    const nav = adminNav();
    expect(nav).not.toContain("label: 'Telegram'");
    expect(nav).not.toContain('/admin/telegram');
  });

  it('opens the individual user\'s Telegram flow from that page', () => {
    // The Channels page links into the channel's own setup rather than
    // configuring anything itself.
    expect(channels).toContain("/app/channels/telegram");
    expect(app).toContain('<Route path="channels" element={<Channels />} />');
    expect(app).toContain('<Route path="channels/telegram" element={<Telegram />} />');
  });

  it('keeps the old path working instead of dropping it on the catch-all', () => {
    // A bookmark from before the move should land on the page, not be swept to
    // Home by the trailing redirect.
    expect(app).toMatch(
      /<Route path="telegram" element={<Navigate to="\/app\/channels\/telegram" replace \/>} \/>/,
    );
  });

  it('does not reintroduce an installation-wide Telegram account for members', () => {
    // The settled architecture is per-user: each person links their own
    // Telegram. The member-facing channel pages must not offer a bot token or
    // any other installation-level credential.
    const telegram = read('apps/web/src/pages/Telegram.tsx');
    for (const source of [channels, telegram]) {
      expect(source).not.toMatch(/bot token/i);
      expect(source).not.toMatch(/botToken/);
    }
  });
});
