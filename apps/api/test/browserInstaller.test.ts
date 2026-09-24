import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = join(import.meta.dirname, '../../..');
const controller = join(root, 'services/installer/controller.py');
const html = join(root, 'services/installer/index.html');

function python(source: string, installRoot: string) {
  return spawnSync('python3', ['-c', source], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      JOSI_INSTALL_ROOT: installRoot,
      JOSI_INSTALLER_HTML: html,
      JOSI_INSTALL_UID: String(process.getuid?.() ?? 0),
      JOSI_INSTALL_GID: String(process.getgid?.() ?? 0),
    },
  });
}

describe('browser installer controller', () => {
  it('commits only after the browser-facing origin passes health verification', () => {
    const dir = mkdtempSync(join(tmpdir(), 'josi-installer-'));
    try {
      const result = python(`
import importlib.util, json
s=importlib.util.spec_from_file_location('c', ${JSON.stringify(controller)})
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
class Response:
 status=200
 def __enter__(self): return self
 def __exit__(self,*_): pass
 def read(self,_): return b'{"ok":true}'
seen=[]
def open_ok(request,timeout):
 seen.append({'url':request.full_url,'timeout':timeout,'agent':request.headers.get('User-agent')})
 return Response()
m.urllib.request.urlopen=open_ok
m.verify_public_origin('https://ce.example.test')
print(json.dumps(seen))
`, dir);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([{
        url: 'https://ce.example.test/health', timeout: 5, agent: 'josi-ce-installer-readiness/1',
      }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fails a public-origin transition when DNS, TLS, or routing never becomes ready', () => {
    const dir = mkdtempSync(join(tmpdir(), 'josi-installer-'));
    try {
      const result = python(`
import importlib.util
s=importlib.util.spec_from_file_location('c', ${JSON.stringify(controller)})
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
m.urllib.request.urlopen=lambda *_args,**_kwargs: (_ for _ in ()).throw(OSError('private detail'))
ticks=iter([0,.5,2])
m.time.monotonic=lambda: next(ticks)
m.time.sleep=lambda _: None
try: m.verify_public_origin('https://ce.example.test',timeout=1)
except RuntimeError as exc:
 assert 'DNS, TLS, or routing' in str(exc)
 assert 'private detail' not in str(exc)
 print('rolled-back')
`, dir);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('rolled-back');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('accepts only safe LAN, domain, and reverse-proxy addresses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'josi-installer-'));
    try {
      const result = python(`
import importlib.util, json
s=importlib.util.spec_from_file_location('c', ${JSON.stringify(controller)})
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
m.occupied_ports=lambda: {}
good=[
 m.validate({'mode':'lan','lanAddress':'192.168.1.20','httpPort':80,'httpsPort':443,'webPort':8081}),
 m.validate({'mode':'domain','domain':'josi.example.com','httpPort':80,'httpsPort':443,'webPort':8081}),
 m.validate({'mode':'proxy','publicUrl':'https://josi.example.com','httpPort':80,'httpsPort':443,'webPort':8081})]
bad=[]
for value in [
 {'mode':'lan','lanAddress':'127.0.0.1'},
 {'mode':'domain','domain':'bad;touch /tmp/nope'},
 {'mode':'proxy','publicUrl':'http://josi.example.com'},
 {'mode':'proxy','publicUrl':'https://user:pass@josi.example.com'},
 {'mode':'proxy','publicUrl':'https://josi.example.com%0aJOSI_TAG=evil'}]:
 try: m.validate(value)
 except (ValueError, TypeError): bad.append(True)
print(json.dumps({'urls':[x['appUrl'] for x in good], 'bad':len(bad)}))
`, dir);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        urls: ['http://192.168.1.20', 'https://josi.example.com', 'https://josi.example.com'],
        bad: 5,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('atomically persists the chosen URL, preserves secrets, and backs up reruns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'josi-installer-'));
    writeFileSync(join(dir, '.env'), 'UNCHANGED_SECRET=keep-me\nJOSI_APP_URL=http://old\n', { mode: 0o600 });
    try {
      const result = python(`
import importlib.util, json, pathlib
s=importlib.util.spec_from_file_location('c', ${JSON.stringify(controller)})
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
m.write_env({'mode':'lan','appUrl':'http://192.168.50.20:8088','domain':'','httpPort':8088,'httpsPort':8443,'webPort':8081}, 'a'*64)
p=pathlib.Path(${JSON.stringify(dir)})
print(json.dumps({'env':(p/'.env').read_text(), 'backups':len(list(p.glob('.env.pre-browser-*'))), 'mode':oct((p/'.env').stat().st_mode & 0o777)}))
`, dir);
      expect(result.status, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout);
      expect(value.env).toContain('UNCHANGED_SECRET=keep-me');
      expect(value.env).toContain('JOSI_APP_URL=http://192.168.50.20:8088');
      expect(value.env).toContain(`JOSI_SETUP_TOKEN_SHA256=${'a'.repeat(64)}`);
      expect(value.backups).toBe(1);
      expect(value.mode).toBe('0o600');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never interpolates browser input into a shell command', () => {
    const source = readFileSync(controller, 'utf8');
    expect(source).toContain('subprocess.run(args');
    expect(source).not.toMatch(/shell\s*=\s*True/);
    expect(source).not.toMatch(/os\.system\(/);
  });

  it('claims the installing state before starting the privileged worker', () => {
    const source = readFileSync(controller, 'utf8');
    expect(source).toMatch(/with START_LOCK:[\s\S]*PROGRESS\.update\(\{"state": "installing"[\s\S]*threading\.Thread/);
  });

  it('consumes the one-time pairing code under a lock', () => {
    const source = readFileSync(controller, 'utf8');
    expect(source).toMatch(/with PAIR_LOCK:[\s\S]*TOKEN_FILE\.exists\(\)[\s\S]*TOKEN_FILE\.unlink/);
  });

  it('shows accessible animated installation progress with named steps', () => {
    const page = readFileSync(html, 'utf8');
    const source = readFileSync(controller, 'utf8');
    expect(page).toContain('role="progressbar"');
    expect(page).toContain('aria-valuenow');
    expect(page).toContain('progress-shimmer');
    expect(page).toContain('Step ${p.step||1} of ${p.totalSteps||5}');
    expect(source).toContain('"percent": 100');
    expect(source).toContain('"totalSteps": 5');
  });

  it('keeps Open Josi hidden until installation completes', () => {
    const page = readFileSync(html, 'utf8');
    expect(page).toContain('id="openAction" class="actions hidden"');
    expect(page).toContain('.actions.hidden{display:none}');
    expect(page).toMatch(/if\(p\.state==='complete'\)\{\$\('openAction'\)\.classList\.remove\('hidden'\)/);
  });

  it('validates an optional developer workspace and writes a least-privilege compose override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'josi-installer-'));
    const workspace = mkdtempSync(join(tmpdir(), 'josi-workspace-'));
    try {
      const result = python(`
import importlib.util, json, pathlib
s=importlib.util.spec_from_file_location('c', ${JSON.stringify(controller)})
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
m.occupied_ports=lambda: {}
m.run=lambda args, **kwargs: type('R', (), {'returncode':0,'stdout':'','stderr':''})()
p=m.validate({'mode':'lan','lanAddress':'192.168.50.20','httpPort':80,'httpsPort':443,'webPort':8081,'workspaceEnabled':True,'workspacePath':${JSON.stringify(workspace)},'workspaceMode':'rw'})
m.write_workspace_override(p)
print(json.dumps({'plan':p,'override':pathlib.Path(${JSON.stringify(dir)},'docker-compose.workspace.yml').read_text()}))
`, dir);
      expect(result.status, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout);
      expect(value.plan).toMatchObject({ workspaceEnabled: true, workspacePath: workspace, workspaceMode: 'rw' });
      expect(value.override).toContain(`source: "${workspace}"`);
      expect(value.override).toContain('target: /workspace');
      expect(value.override).toContain('read_only: false');
      expect(value.override).toContain('web:');
      expect(value.override).toContain('worker:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('refuses dangerous developer workspace paths and keeps the feature optional', () => {
    const dir = mkdtempSync(join(tmpdir(), 'josi-installer-'));
    try {
      const result = python(`
import importlib.util, json
s=importlib.util.spec_from_file_location('c', ${JSON.stringify(controller)})
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
m.occupied_ports=lambda: {}
base={'mode':'lan','lanAddress':'192.168.50.20','httpPort':80,'httpsPort':443,'webPort':8081}
skipped=m.validate(base)
bad=[]
for path in ['/', '/etc', '/home/example/credentials', '/home/example/.aws', '/var/lib/docker', ${JSON.stringify(dir)}]:
 try: m.validate({**base,'workspaceEnabled':True,'workspacePath':path,'workspaceMode':'rw'})
 except ValueError: bad.append(path)
print(json.dumps({'skipped':skipped['workspaceEnabled'],'bad':bad}))
`, dir);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        skipped: false,
        bad: ['/', '/etc', '/home/example/credentials', '/home/example/.aws', '/var/lib/docker', dir],
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('offers the optional workspace in the browser and includes it in review', () => {
    const page = readFileSync(html, 'utf8');
    expect(page).toContain('Developer workspace');
    expect(page).toContain('id="workspaceEnabled"');
    expect(page).toContain('id="workspacePath"');
    expect(page).toContain('workspaceMode');
    expect(page).toContain('Developer workspace: ${workspace}');
  });
});
