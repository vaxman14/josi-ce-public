// The installation is a product surface, so it is asserted rather than reviewed.
//
// Every check here corresponds to a launch blocker row in
// `docs/IMPLEMENTATION_PLAN.md` (LB1) and exists because the property it
// asserts was wrong at some point on a real host:
//
//   - the published install required a repository checkout and a source build;
//   - the permission check printed filesystem `stat` diagnostics as a mode,
//     because on GNU coreutils `stat -f` succeeds and the BSD-first chain never
//     reached its fallback;
//   - a healthy multi-terabyte disk warned that it was nearly full, because
//     `df -h` prints "1.8T" and 1.8 is less than the threshold;
//   - Ubuntu's Snap Docker produced a root:root socket and no `docker` group,
//     so the advice every search result gives could not work.
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const release = parse(read('docker-compose.release.yml')) as any;
const dev = parse(read('docker-compose.yml')) as any;
const preflight = read('scripts/preflight.sh');
const installer = read('scripts/install.sh');
const cleanInstall = read('scripts/acceptance/clean-install.sh');
const dockerTest = read('scripts/test-docker.sh');

/** Every shell script that reads a file's permission mode. */
const MODE_READING_SCRIPTS: Array<[string, string]> = [
  ['scripts/preflight.sh', preflight],
  ['scripts/install.sh', installer],
  ['scripts/acceptance/clean-install.sh', cleanInstall],
  ['scripts/test-docker.sh', dockerTest],
];

describe('LB1.1 — the published install pulls a release rather than building one', () => {
  it('builds nothing', () => {
    for (const [name, svc] of Object.entries<any>(release.services)) {
      expect(svc.build, `${name} must not build from source in the published install`).toBeUndefined();
    }
  });

  it('gives every service an image', () => {
    for (const [name, svc] of Object.entries<any>(release.services)) {
      expect(svc.image, `${name} has no image`).toBeTruthy();
    }
  });

  it('pins every image to a version rather than a floating tag', () => {
    // An appliance that changes version when it restarts is not an appliance.
    for (const [name, svc] of Object.entries<any>(release.services)) {
      const image: string = svc.image;
      expect(image, `${name} must carry a tag`).toContain(':');
      const tag = image.slice(image.lastIndexOf(':') + 1);
      expect(tag, `${name} must not float on latest`).not.toBe('latest');
      expect(tag, `${name} must not have an empty tag`).not.toBe('');
    }
  });

  it('defaults the Josi image tag to a concrete version, not to `local`', () => {
    // `local` is what the development compose defaults to, and it only exists
    // on a machine that has built it. A downloaded file defaulting to `local`
    // fails with "image not found" on every clean host.
    for (const name of ['web', 'worker', 'migrate']) {
      expect(release.services[name].image, name).toMatch(/:\$\{JOSI_TAG:-\d+\.\d+\.\d+\}$/);
    }
  });

  it('runs the same image for web, worker and migrate', () => {
    const images = new Set(['web', 'worker', 'migrate'].map((n) => release.services[n].image));
    expect(images.size, 'one image, three commands').toBe(1);
  });
});

describe('LB1.1 — the published install keeps the development stack’s security shape', () => {
  // A second compose file is a second place for a security property to be
  // forgotten. Each of these is asserted on the DEV file elsewhere; here they
  // are asserted again on the file operators actually run, so the two cannot
  // drift apart silently.

  it('never publishes the database', () => {
    expect(release.services.db.ports).toBeUndefined();
    expect(release.services.db.networks).toEqual(['data']);
  });

  it('publishes only the proxy', () => {
    const published = Object.entries<any>(release.services)
      .filter(([, svc]) => Array.isArray(svc.ports) && svc.ports.length)
      .map(([name]) => name);
    expect(published).toEqual(['caddy']);
  });

  it('keeps both secrets as files rather than environment variables', () => {
    expect(release.secrets.josi_master_key.file).toBe('${JOSI_MASTER_KEY_FILE:-./secrets/master.key}');
    expect(release.secrets.josi_db_password.file).toBe('${JOSI_DB_PASSWORD_FILE:-./secrets/db_password}');
    for (const [name, svc] of Object.entries<any>(release.services)) {
      const env = svc.environment ?? {};
      for (const forbidden of ['MASTER_KEY', 'CREDENTIALS_KEY', 'POSTGRES_PASSWORD', 'PGPASSWORD']) {
        expect(Object.keys(env), `${name}.${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('supports prepare-only mode for appliance stack UIs', () => {
    const aio = read('scripts/aio-install.sh');
    expect(aio).toContain('JOSI_PREPARE_ONLY');
    expect(aio).toContain('no services were started');
  });

  it('lets stack UIs use absolute host paths for all bind-mounted release files', () => {
    expect(release.services.caddy.volumes).toContain(
      '${JOSI_CADDYFILE:-./Caddyfile}:/etc/caddy/Caddyfile:ro',
    );
  });

  it('hardens the application containers exactly as the development stack does', () => {
    for (const name of ['web', 'worker']) {
      expect(release.services[name].read_only, name).toBe(true);
      expect(release.services[name].cap_drop, name).toContain('ALL');
      expect(release.services[name].security_opt, name).toContain('no-new-privileges:true');
    }
    expect(release.services.caddy.cap_add).toEqual(['NET_BIND_SERVICE']);
  });

  it('connects the web app to the installer-managed Voice Box helper', () => {
    expect(release.services.web.environment.JOSI_VOICE_HELPER_SOCKET).toBe('/run/josi-voice/helper.sock');
    expect(release.services.web.environment.JOSI_STORAGE_HELPER_SOCKET).toBe('/run/josi-storage/helper.sock');
    expect(release.services.web.volumes).toContain(
      '${JOSI_VOICE_SOCKET_DIR:-./voice-helper-socket}:/run/josi-voice:ro',
    );
  });

  it('keeps required services off profiles and optional ones on them', () => {
    for (const name of ['web', 'worker', 'db', 'caddy', 'migrate']) {
      expect(release.services[name].profiles, `${name} must not be profile-gated`).toBeUndefined();
    }
    expect(release.services.ocr.profiles).toEqual(['ocr']);
    expect(release.services.clamav.profiles).toEqual(['clamav']);
  });

  it('waits for migrations before starting the app', () => {
    for (const name of ['web', 'worker']) {
      expect(release.services[name].depends_on.migrate.condition).toBe('service_completed_successfully');
    }
  });

  it('defines every service the development stack defines', () => {
    // A service that exists only in development is a service nobody who
    // installs Josi has ever run.
    expect(Object.keys(release.services).sort()).toEqual(Object.keys(dev.services).sort());
  });

  it('keeps the subscription login on its own durable volume', () => {
    // A device login that a container replacement destroys is a device login
    // the operator has to repeat on every update.
    for (const name of ['web', 'worker']) {
      expect(release.services[name].volumes, name).toContain('josi_codex:/data/codex');
      expect(release.services[name].environment.CODEX_HOME, name).toBe('/data/codex');
    }
    expect(release.volumes).toHaveProperty('josi_codex');
  });

  it('keeps the Claude login on its own durable volume too', () => {
    // Same property, second vendor. Anthropic's CLI writes its login into
    // CLAUDE_CONFIG_DIR; if that were container-local, every update would sign
    // the operator out and the screen would offer to reconnect forever.
    for (const name of ['web', 'worker']) {
      expect(release.services[name].volumes, name).toContain('josi_claude:/data/claude');
      expect(release.services[name].environment.CLAUDE_CONFIG_DIR, name).toBe('/data/claude');
    }
    expect(release.volumes).toHaveProperty('josi_claude');
  });

  it('gives the two CLIs separate volumes', () => {
    // Sharing one would mean signing out of one vendor could destroy the
    // other's login, and removing either would be indivisible from the other.
    expect(release.services.web.environment.CODEX_HOME)
      .not.toBe(release.services.web.environment.CLAUDE_CONFIG_DIR);
  });
});

describe('LB2.2 — the published image carries a pinned Claude Code CLI', () => {
  const dockerfile = read('Dockerfile');

  it('installs Anthropic\u2019s own CLI, unmodified', () => {
    expect(dockerfile).toMatch(/npm install -g[^\n]*@anthropic-ai\/claude-code@/);
    // From the published package, with no patch step of any kind. Modifying the
    // binary is the difference between shipping Claude Code and shipping
    // something that impersonates it.
    const install = /@anthropic-ai\/claude-code@[^\s"']*/.exec(dockerfile)?.[0] ?? '';
    expect(install).not.toMatch(/latest/);
  });

  it('pins an exact version rather than a moving tag', () => {
    // The sign-in flow is driven by READING what this CLI prints, so a reworded
    // prompt is a broken sign-in. The fixtures in
    // packages/llm/test/claudeLogin.test.ts are captures of this exact version.
    const pin = /ARG JOSI_CLAUDE_VERSION=([^\s]*)/.exec(dockerfile)?.[1];
    expect(pin, 'the version must be a concrete default').toMatch(/^\d+\.\d+\.\d+$/);
    const instructions = dockerfile.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(instructions).not.toMatch(/@anthropic-ai\/claude-code@latest/);
  });

  it('creates the CLI\u2019s home with the right owner', () => {
    // Created root:root by the daemon and written by `node` is the permission
    // failure that every unit test passes through.
    expect(dockerfile).toMatch(/mkdir -p[^\n]*\/data\/claude/);
    expect(dockerfile).toMatch(/chown -R node:node \/data/);
  });
});

describe('LB2.2 — the published image carries a pinned Codex CLI', () => {
  const dockerfile = read('Dockerfile');

  it('installs OpenAI’s own CLI', () => {
    expect(dockerfile).toMatch(/npm install -g[^\n]*@openai\/codex@/);
  });

  it('pins an exact version rather than a moving tag', () => {
    // The wizard reads what this CLI PRINTS in order to show a sign-in code.
    // `@latest` would mean the interface changing under a running
    // installation, and a reworded prompt is a broken sign-in.
    const pin = /ARG JOSI_CODEX_VERSION=([^\s]*)/.exec(dockerfile)?.[1];
    expect(pin, 'the version must be a concrete default').toMatch(/^\d+\.\d+\.\d+$/);
    // Comments stripped: explaining why `@latest` is wrong requires writing it.
    const instructions = dockerfile.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(instructions).not.toMatch(/@openai\/codex@latest/);
    expect(instructions).not.toMatch(/@openai\/codex["\s]/);
  });

  it('is the version the login parser was written against', () => {
    // The device-login test fixture is a byte-for-byte capture from this
    // version. Moving one without the other is how the parser silently stops
    // matching, so both name it and this is what fails.
    const pin = /ARG JOSI_CODEX_VERSION=([^\s]*)/.exec(dockerfile)?.[1];
    const fixture = read('packages/llm/test/codexLogin.test.ts');
    expect(fixture, `the login fixture must be captured from ${pin}`).toContain(pin!);
  });

  it('fails the build rather than continuing without it', () => {
    // `npm install -g` exits non-zero on an unresolvable version, and `codex
    // --version` right after proves the binary is actually runnable rather
    // than merely downloaded.
    expect(dockerfile).toMatch(/&& codex --version/);
  });

  it('gives the CLI a durable home, owned by the runtime user', () => {
    // A named volume inherits ownership from the image path it covers. Without
    // this the daemon creates it root-owned, the app runs as `node`, and the
    // login fails to write — the same defect that broke backups in Phase 10.
    expect(dockerfile).toMatch(/mkdir -p [^\n]*\/data\/codex/);
    expect(dockerfile).toMatch(/chown -R node:node \/data/);
  });

  it('mounts that home in both compose files, so a login survives an update', () => {
    for (const [name, compose] of [['development', dev], ['release', release]] as const) {
      for (const service of ['web', 'worker']) {
        expect(compose.services[service].volumes, `${name}/${service}`)
          .toContain('josi_codex:/data/codex');
        expect(compose.services[service].environment.CODEX_HOME, `${name}/${service}`)
          .toBe('/data/codex');
      }
      expect(compose.volumes, name).toHaveProperty('josi_codex');
    }
  });

  it('keeps the login out of the database volume, so removing one is not removing the other', () => {
    expect(release.services.web.volumes).not.toContain('db_data:/data/codex');
    expect(Object.keys(release.volumes)).toContain('josi_codex');
    expect(Object.keys(release.volumes)).toContain('db_data');
  });
});

describe('LB1.5 — a permission mode is a number, never a filesystem-stat dump', () => {
  it('asks GNU coreutils before BSD in every script that reads a mode', () => {
    // The ordering is the whole defect. On GNU, `stat -f` means "display file
    // system status" and SUCCEEDS, so `stat -f … || stat -c …` never evaluates
    // its fallback and returns `?p` — which was then printed to operators as
    // the file's permission mode on every Linux host.
    for (const [name, src] of MODE_READING_SCRIPTS) {
      const bsdFirst = /stat\s+-f\s+'%Lp'[^\n]*\|\|\s*stat\s+-c/.test(src);
      expect(bsdFirst, `${name} asks BSD stat before GNU stat`).toBe(false);
      expect(src, `${name} should try GNU stat -c first`).toMatch(/stat\s+-c\s+'%a'/);
    }
  });

  it('validates the result is octal before showing it as a mode', () => {
    // Belt and braces: even with the ordering right, a filesystem that reports
    // nothing useful must produce "unknown", not junk formatted as a mode.
    for (const [name, src] of MODE_READING_SCRIPTS) {
      expect(src, `${name} must reject a non-octal mode`).toMatch(/\*\[!0-7\]\*/);
    }
  });

  it('reads a real file’s mode as plain octal digits', () => {
    // The property, executed rather than pattern-matched.
    //
    // This used to read `secrets/master.key`, which exists in a working
    // checkout and does not exist in a fresh clone or in CI — so it passed
    // locally for an incidental reason and failed the moment the suite ran
    // anywhere else. It now makes its own file, which also lets it assert that
    // the helper reports what is REALLY there rather than a constant.
    const dir = mkdtempSync(join(tmpdir(), 'josi-mode-'));
    try {
      for (const mode of [0o600, 0o644, 0o400]) {
        const file = join(dir, `f${mode.toString(8)}`);
        writeFileSync(file, 'x', { mode });
        chmodSync(file, mode);
        expect(execPreflightHelper(`file_mode '${file}'`)).toBe(mode.toString(8));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports nothing rather than junk when there is no mode to read', () => {
    // A missing file must not produce a "mode" at all. The original defect was
    // exactly this shape: a failed stat whose output was printed as a mode.
    expect(() => execPreflightHelper('file_mode /nonexistent/file/here')).toThrow();
  });
});

describe('LB1.6 — a healthy disk does not warn', () => {
  it('measures free space in fixed units rather than parsing human output', () => {
    // `df -h` on a healthy 1.8 TB volume prints "1.8T". Compared numerically
    // that is 1.8, which is below every sane threshold, so the check warned
    // that a nearly-empty multi-terabyte disk was almost full.
    expect(preflight, 'use df -Pk for a machine-readable figure').toMatch(/df\s+-Pk/);
    const diskFn = preflight.slice(preflight.indexOf('disk_free_mb()'), preflight.indexOf('total_mem_mb()'));
    expect(diskFn, 'the disk check must not parse `df -h`').not.toMatch(/df\s+-h/);
  });

  it('reports this host’s real free space as a plain integer', () => {
    const mb = execPreflightHelper('disk_free_mb .');
    expect(mb, 'free space is whole megabytes').toMatch(/^\d+$/);
    // This repository lives on a normal disk with room on it. The assertion is
    // the point of the row: a large healthy disk must not read as nearly full.
    expect(Number(mb)).toBeGreaterThan(5120);
  });
});

describe('LB1.3 — preflight checks what fails installations', () => {
  const required = [
    ['architecture', /uname -m/],
    ['operating system', /\/etc\/os-release/],
    ['Docker Engine', /command -v docker/],
    ['Compose v2', /docker compose version/],
    ['daemon access', /docker info/],
    ['ports', /port_in_use/],
    ['disk', /disk_free_mb/],
    ['memory', /total_mem_mb/],
    ['filesystem permissions', /file_mode/],
  ] as const;

  for (const [what, pattern] of required) {
    it(`checks ${what}`, () => {
      expect(preflight, `preflight does not check ${what}`).toMatch(pattern);
    });
  }

  it('changes nothing on the host', () => {
    // The reason an operator can be told to run it before reading the rest of
    // the manual: no package installed, no image pulled, no file removed.
    //
    // Preflight has to NAME those commands, because telling somebody how to
    // repair a broken Docker installation means printing `apt-get` and
    // `snap remove`. So the advice is stripped before the check: comments go,
    // then every quoted string literal — which is where a remedy lives — and
    // what remains is the code that actually executes.
    //
    // This is a static approximation and worth stating as one. It proves no
    // mutating command is written outside a string; it cannot prove one is not
    // assembled at runtime. Nothing in this script builds a command that way,
    // and the `record`-only structure is what keeps that reviewable.
    const executable = preflight
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
      .replace(/"(?:[^"\\]|\\[\s\S])*"/g, '""')
      .replace(/'(?:[^'])*'/g, "''");

    for (const forbidden of [
      /\bapt(-get)?\s+(install|remove|purge)\b/,
      /\bsnap\s+(install|remove)\b/,
      /\bdocker\s+(pull|run|create|compose\s+up)\b/,
      /\bgroupadd\b|\busermod\b|\bchown\b|\bchmod\b/,
      /\brm\s+-[rf]/,
      /\bsystemctl\s+(start|enable|restart)\b/,
    ]) {
      const offenders = executable.split('\n').filter((l) => forbidden.test(l));
      expect(offenders, `preflight must not mutate the host: ${offenders.join(' | ')}`).toEqual([]);
    }
  });

  it('exits non-zero when it found a blocker', () => {
    expect(preflight).toMatch(/\[ \$BLOCKERS -gt 0 \] && exit 1/);
  });
});

describe('LB1.4 — the Snap-Docker failure is named, not guessed at', () => {
  it('detects the snap build', () => {
    expect(preflight).toMatch(/snap list docker/);
    expect(preflight).toMatch(/\/snap\/bin\/docker/);
  });

  it('detects the root:root socket with no docker group', () => {
    expect(preflight).toMatch(/root:root/);
    expect(preflight).toMatch(/getent group docker/);
  });

  it('prints the exact supported repair rather than a generic permission error', () => {
    // The failure mode is that `usermod -aG docker $USER` is the universal
    // advice and cannot work here, because the snap creates no such group.
    expect(preflight).toMatch(/snap remove docker/);
    expect(preflight).toMatch(/groupadd -f docker/);
    expect(preflight).toMatch(/newgrp docker/);
  });

  it('never suggests making the socket world-writable', () => {
    // `chmod 666 /var/run/docker.sock` is the other popular answer, and it
    // grants every local account root-equivalent control of the host.
    const suggestions = preflight
      .split('\n')
      .filter((l) => /chmod\s+6?666/.test(l))
      .filter((l) => !/Do not|never|do NOT/i.test(l));
    expect(suggestions, 'preflight must not recommend chmod 666 on the socket').toEqual([]);
  });
});

describe('LB1.7 — the published installer remains inspectable and pinned', () => {
  it('never asks anyone to pipe a URL into a shell', () => {
    for (const [name, src] of [
      ['docker-compose.release.yml', read('docker-compose.release.yml')],
      ['scripts/preflight.sh', preflight],
      ['scripts/install.sh', installer],
      ['docs/INSTALLATION.md', read('docs/INSTALLATION.md')],
    ] as const) {
      const piped = src
        .split('\n')
        .filter((l) => /curl[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/.test(l))
        // Naming the anti-pattern in order to reject it is allowed.
        .filter((l) => !/not|never|Do NOT|instead of/i.test(l));
      expect(piped, `${name} pipes a download into a shell: ${piped.join(' | ')}`).toEqual([]);
    }
  });

  it('runs a concrete installer image temporarily and exposes the socket explicitly', () => {
    const docs = `${read('README.md')}\n${read('docs/QUICK_START.md')}\n${read('docs/INSTALLATION.md')}`;
    expect(docs).toContain('romanvaxman/josi-ce-installer:latest');
    expect(docs).toContain('-v /var/run/docker.sock:/var/run/docker.sock');
    expect(docs).toMatch(/docker run --rm/);
    expect(read('services/installer/controller.py')).toContain('threading.Timer(45, lambda: os._exit(0))');
  });
});

describe('LB1 — the installer works outside a repository checkout', () => {
  it('does not blindly cd out of its own directory', () => {
    // Downloaded on its own into ~/josi, `cd "$(dirname "$0")/.."` puts the
    // installation's secrets in the parent directory.
    expect(installer, 'install.sh must not unconditionally cd ..').not.toMatch(/^cd "\$\(dirname "\$0"\)\/\.\."$/m);
    expect(installer).toMatch(/basename "\$script_dir"\D+scripts/);
  });

  it('still resolves the repository root when it is run from a checkout', () => {
    expect(installer).toMatch(/-f "\$\{script_dir\}\/\.\.\/docker-compose\.yml"/);
  });
});

// --------------------------------------------------------------------------

/** Run one of preflight's helper functions in isolation.
 *
 * The functions are sourced out of the real script rather than reimplemented,
 * so this exercises the code an operator runs. The script's body is not
 * executed: everything after the helper definitions is dropped.
 */
function execPreflightHelper(call: string): string {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const start = preflight.indexOf('file_mode() {');
  const end = preflight.indexOf('port_in_use()');
  expect(start, 'helper block not found in preflight.sh').toBeGreaterThan(0);
  expect(end, 'helper block end not found in preflight.sh').toBeGreaterThan(start);
  const helpers = preflight.slice(start, end);
  return execFileSync('bash', ['-c', `${helpers}\n${call}`], { cwd: root, encoding: 'utf8' }).trim();
}
