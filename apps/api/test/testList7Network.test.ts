import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Test List 7 network and canonical address contracts', () => {
  it('labels the current-password reauthentication field and explains non-persistence', () => {
    const page = read('apps/web/src/pages/admin/Network.tsx');
    expect(page).toContain('>Admin password</label>');
    expect(page).toContain('autoComplete="current-password"');
    expect(page).toContain('placeholder="Enter your current admin password"');
    expect(page).toContain('is never saved');
  });

  it('opens the maintenance URL only after the helper readiness contract succeeds', () => {
    const helper = read('services/installer/maintenance_helper.py');
    expect(helper).toContain("'-p',f'{advertised}:8080:8080'");
    expect(helper).toContain('self.wait_ready()');
    expect(helper).toContain("urlopen('https://127.0.0.1:8080/health'");
    expect(helper).toContain("docker','rm','-f',self.name");
    expect(helper).toContain('reachable_host');
    expect(helper).toContain("'openssl','req','-x509'");
    expect(helper).toContain("'--user',f'{self.uid}:{self.gid}'");
    expect(helper).toContain("'--group-add',str(self.docker_gid)");
  });

  it('repairs every persisted APP_URL derivative before the API becomes ready', () => {
    const sync = read('apps/api/src/setup/publicAddress.ts');
    const server = read('apps/api/src/server.ts');
    expect(sync).toContain('update deployment_config');
    expect(sync).toContain("jsonb_set(coalesce(settings, '{}'::jsonb), '{publicAddress}', to_jsonb($3::text)");
    expect(sync).toContain("'/api/connections/' || provider || '/callback'");
    expect(sync).toContain("$3 || '/telegram/webhook'");
    expect(sync).toContain('webhook_set_at = null');
    expect(server.indexOf('await reconcilePublicAddress')).toBeLessThan(server.indexOf('app.listen'));
  });

  it('makes failed readiness restore files, proxy shape, and previous metadata', () => {
    const controller = read('services/installer/controller.py');
    expect(controller).toContain("ROOT / '.env'");
    expect(controller).toContain("ROOT / 'docker-compose.noproxy.yml'");
    expect(controller).toContain('rollback = ["docker", "compose"');
    expect(controller).toContain('"up", "-d", "--wait"');
    expect(controller).toContain('verify_public_origin(str(plan["appUrl"]))');
    expect(controller).toContain('rollback += ["--scale", "caddy=0"]');
  });
});
