import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('Test List 6 items 6–11 UI contracts', () => {
  it('keeps Telegram inside the shared authenticated shell', () => {
    const app = read('apps/web/src/App.tsx');
    expect(app).toContain('<Route path="/app" element={<RequireAuth><Shell /></RequireAuth>}>');
    expect(app).toContain('<Route path="channels/telegram" element={<Telegram />} />');
    expect(app).toContain('<Route path="/admin" element={<RequireAuth admin><Shell /></RequireAuth>}>');
    expect(app).toContain('<Route path="telegram" element={<AdminTelegram />} />');
  });

  it('preserves destination fields on Change and separates confirmed removal', () => {
    const page = read('apps/web/src/pages/admin/Backups.tsx');
    expect(page).toContain('label: destination.label');
    expect(page).toContain('bucket: destination.bucket');
    expect(page).toContain("window.confirm('Remove this backup destination?");
    expect(page).toContain('Remove destination');
  });

  it('shows persistent backup progress and guided NAS controls', () => {
    const page = read('apps/web/src/pages/admin/Backups.tsx');
    expect(page).toContain('Back up now');
    expect(page).toContain('aria-label="Backup progress"');
    expect(page).toContain('Connect and browse');
    expect(page).toContain("['smb', 'nfs']");
    expect(page).toContain('Encrypt off-site backups');
  });

  it('uses one Integrations hub with the requested catalog and request banner', () => {
    const page = read('apps/web/src/pages/admin/DeveloperServices.tsx');
    for (const label of ['Integrations', 'GitLab', 'Cloudflare', 'Docker Hub', 'GitHub Container Registry', 'Railway', 'Render', 'Sentry', 'Notion', 'Obsidian', 'Linear', 'Jira', 'Custom API']) {
      expect(page).toContain(label);
    }
    // A catalog logo is not an implementation. Unsupported named providers
    // must be described as planned native work, never routed through Custom API.
    expect(page).toContain("coming_soon: 'Native · coming soon'");
    expect(page).toContain('roman@socalreceptionist.com');
  });
});
