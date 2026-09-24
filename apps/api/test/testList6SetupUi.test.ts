import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('test list 6 setup items 1–5', () => {
  it('masks the Vault key while preserving explicit copy and download actions', () => {
    const page = read('apps/web/src/pages/Setup.tsx');
    expect(page).toContain('Recovery key ending in');
    expect(page).toContain("recovery.key.slice(-4)");
    expect(page).toContain("navigator.clipboard.writeText(recovery.key)");
    expect(page).toContain("download = `josi-vault-recovery-");
    expect(page).not.toContain('select-all">{vaultRecovery.key}');
  });

  it('uses the enlarged setup workspace and keeps review on the review surface', () => {
    const page = read('apps/web/src/pages/Setup.tsx');
    expect(page).toContain('max-w-3xl');
    expect(page).toContain("review && (!current || current.id === 'review')");
  });

  it('tests the saved model before loading the next setup step', () => {
    const page = read('apps/web/src/pages/Setup.tsx');
    expect(page).toMatch(/if \(step === 'llm'\) \{[\s\S]*api\.post\('\/setup\/verify\/llm'/);
    expect(page).toContain('Save and run the five-part test');
  });

  it('uses the configured browser origin for reset links', () => {
    const routes = read('apps/api/src/http/authRoutes.ts');
    expect(routes).toContain("return ctx.appUrl.replace(/\\\/$/, '')");
    expect(routes).not.toContain('return domain ? `https://${domain}`');
  });

  it('ships the masked-input offline password reset command in the installer', () => {
    const script = read('scripts/reset-password.sh');
    const image = read('Dockerfile.aio');
    expect(script).toContain("read -r -s -p 'New Josi password: '");
    expect(script).toContain('set password_hash');
    expect(script).toContain('revoked_at = now()');
    expect(script).toContain('used_at = now()');
    expect(image).toContain('reset-password.sh /opt/josi-ce-release/reset-password.sh');
  });
});
