import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('public help and legal coverage', () => {
  const shell = read('apps/web/src/components/layout/Shell.tsx');
  const login = read('apps/web/src/pages/Login.tsx');
  const setup = read('apps/web/src/pages/Setup.tsx');
  const family = read('apps/web/src/pages/Family.tsx');
  const parental = read('apps/web/src/pages/admin/ParentalControls.tsx');
  const terms = read('docs/TERMS_OF_USE.md');
  const privacy = read('docs/PRIVACY_NOTICE.md');
  const cookies = read('docs/COOKIE_NOTICE.md');
  const help = read('docs/HELP.md');
  const site = read('docs-site/body.html');

  it('keeps Help persistent in the signed-in shell', () => {
    expect(shell).toContain('href={HELP_URL}');
    expect(shell).toContain('Help');
    expect(read('apps/web/src/components/LegalLinks.tsx')).toContain('#help');
  });

  it('shows legal notices before setup completion and at sign-in', () => {
    for (const surface of [login, setup]) {
      expect(surface).toContain('<LegalLinks');
      expect(surface).toMatch(/Terms/);
      expect(surface).toMatch(/Privacy/);
      expect(surface).toMatch(/Cookie/);
    }
  });

  it('labels every Family entry and both management pages as Coming Soon', () => {
    expect(shell).toContain("label: 'Family (Coming Soon)'");
    expect(shell).toContain("label: 'Parental controls (Coming Soon)'");
    for (const surface of [family, parental]) {
      expect(surface).toContain('Coming Soon');
      expect(surface).toMatch(/No supervision, schedules, limits, monitoring, or child-safety enforcement/i);
      expect(surface).toContain('roman@socalreceptionist.com');
    }
  });

  it('documents every current product capability and external data path', () => {
    const corpus = `${terms}\n${privacy}\n${help}`.toLowerCase();
    for (const capability of [
      'conversation', 'task', 'approval', 'contact', 'personalization', 'memory',
      'usage', 'mail', 'document', 'backup', 'restore', 'telemetry', 'diagnostic',
      'google', 'microsoft', 'telegram', 'slack', 'whatsapp', 'signal',
      'voice box', 'developer', 'parental', 'pwa', 'system checkup',
    ]) expect(corpus, `missing legal/help coverage for ${capability}`).toContain(capability);
  });

  it('describes the two real cookies and denies tracking claims', () => {
    expect(cookies).toContain('authentication session cookie');
    expect(cookies).toContain('CSRF cookie');
    expect(cookies).toMatch(/not used for advertising/i);
    expect(cookies).toMatch(/PWA caches versioned application files/i);
  });

  it('publishes help, terms, privacy, cookies and licence sections on the docs site', () => {
    for (const id of ['help', 'terms-of-use', 'privacy-notice', 'cookie-notice', 'software-and-paid-feature-licences']) {
      expect(site).toContain(`id="${id}"`);
    }
  });
});
