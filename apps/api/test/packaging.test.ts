// The compose file and Dockerfile encode security properties, so they are
// asserted here rather than trusted to review. A future edit that publishes the
// database port, puts the master key in an environment variable, or starts
// ClamAV by default fails the suite instead of shipping.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { CONTENT_SECURITY_POLICY } from '../src/http/staticApp.js';

const root = join(import.meta.dirname, '../../..');
const compose = parse(readFileSync(join(root, 'docker-compose.yml'), 'utf8')) as any;
const releaseCompose = parse(readFileSync(join(root, 'docker-compose.release.yml'), 'utf8')) as any;
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
const caddyfile = readFileSync(join(root, 'Caddyfile'), 'utf8');
const installer = readFileSync(join(root, 'scripts/install.sh'), 'utf8');

const service = (name: string) => compose.services[name];

/** Every workspace that actually exists on disk, derived rather than listed.
 *
 * A hardcoded list is how both of the packaging defects below got in: the list
 * was written when the workspaces were what they were, and the next package
 * nobody remembered to add was invisible to the check. */
const workspaces: string[] = (
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces: string[] }
).workspaces.flatMap((pattern) => {
  const dir = pattern.replace(/\/\*$/, '');
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, dir, e.name, 'package.json')))
    .map((e) => `${dir}/${e.name}`);
});

describe('the stack has the four required services', () => {
  it('defines web, worker, db and caddy', () => {
    for (const name of ['web', 'worker', 'db', 'caddy']) {
      expect(compose.services, name).toHaveProperty(name);
    }
  });

  it('runs migrations as a separate step the app waits for', () => {
    expect(service('migrate')).toBeDefined();
    // Starting against an unmigrated database should be impossible, not just
    // unlikely.
    expect(service('web').depends_on.migrate.condition).toBe('service_completed_successfully');
    expect(service('worker').depends_on.migrate.condition).toBe('service_completed_successfully');
  });
});

describe('optional components are inert unless asked for', () => {
  it('puts OCR and ClamAV behind profiles', () => {
    expect(service('ocr').profiles).toEqual(['ocr']);
    expect(service('clamav').profiles).toEqual(['clamav']);
  });

  it('does not put a required service behind a profile', () => {
    // Compose treats the active profile set as a whole: naming any profile
    // deactivates the empty one. Caddy previously carried profiles ["",
    // "default"], so `docker compose --profile ocr up -d` — the documented way
    // to enable OCR — silently dropped the reverse proxy and took HTTPS
    // offline. A required service must have no `profiles` key at all.
    for (const name of ['web', 'worker', 'db', 'caddy', 'migrate']) {
      expect(service(name).profiles, `${name} must not be profile-gated`).toBeUndefined();
    }
  });

  it('offers bring-your-own-proxy as an override rather than a profile', () => {
    const override = parse(readFileSync(join(root, 'docker-compose.noproxy.yml'), 'utf8')) as any;
    // The override publishes web directly, since Caddy is scaled to zero.
    expect(override.services.web.ports).toBeDefined();
  });

  it('does not list them as dependencies of anything that starts by default', () => {
    for (const name of ['web', 'worker', 'db', 'caddy', 'migrate']) {
      const deps = Object.keys(service(name).depends_on ?? {});
      expect(deps, name).not.toContain('ocr');
      expect(deps, name).not.toContain('clamav');
    }
  });

  it('caps the resources of the component most likely to hurt a small machine', () => {
    // OCR is the one that eats a Raspberry Pi alive.
    expect(service('ocr').deploy.resources.limits).toHaveProperty('memory');
    expect(service('ocr').deploy.resources.limits).toHaveProperty('cpus');
    expect(service('clamav').deploy.resources.limits).toHaveProperty('memory');
  });
});

describe('secrets are files, never environment variables', () => {
  it('declares both secrets as files', () => {
    expect(compose.secrets.josi_master_key.file).toBe('./secrets/master.key');
    expect(compose.secrets.josi_db_password.file).toBe('./secrets/db_password');
  });

  it('gives web and worker the master key as a mounted secret', () => {
    for (const name of ['web', 'worker']) {
      expect(service(name).secrets, name).toContain('josi_master_key');
      expect(service(name).environment.MASTER_KEY_FILE, name).toMatch(/^\/run\/secrets\//);
    }
  });

  it('never places key material in any service environment', () => {
    for (const [name, svc] of Object.entries<any>(compose.services)) {
      const env = svc.environment ?? {};
      for (const forbidden of ['MASTER_KEY', 'CREDENTIALS_KEY', 'POSTGRES_PASSWORD', 'PGPASSWORD']) {
        expect(Object.keys(env), `${name}.${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('has postgres read its password from a file too', () => {
    expect(service('db').environment.POSTGRES_PASSWORD_FILE).toMatch(/^\/run\/secrets\//);
  });

  it('never bakes a secret into the image', () => {
    expect(dockerfile).not.toMatch(/master\.key/);
    expect(dockerfile).not.toMatch(/COPY\s+secrets/);
    // No ENV at all whose name looks like a credential. The path default lives
    // in code instead, so BuildKit's SecretsUsedInArgOrEnv check stays useful
    // rather than being suppressed file-wide.
    const envNames = [...dockerfile.matchAll(/^ENV\s+([A-Z0-9_]+)=/gm)].map((m) => m[1]);
    for (const name of envNames) {
      expect(name, `ENV ${name}`).not.toMatch(/KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL/i);
    }
  });

  it('keeps the master-key path default in code, not in the image', () => {
    const masterKeySrc = readFileSync(join(root, 'packages/core/src/masterKey.ts'), 'utf8');
    expect(masterKeySrc).toMatch(/DEFAULT_MASTER_KEY_PATH = '\/run\/secrets\/josi_master_key'/);
  });

  it('generates the key from a CSPRNG and never prints it', () => {
    expect(installer).toMatch(/openssl rand -base64 32|head -c 32 \/dev\/urandom/);
    expect(installer).toMatch(/umask 077/);
    // Repository/manual installs remain owner-readable only. The AIO wrapper
    // explicitly opts into 0644 for file-backed Compose secrets, whose 0700
    // parent directory still prevents access by other host users.
    expect(installer).toMatch(/SECRET_MODE=600/);
    expect(installer).toMatch(/JOSI_COMPOSE_SECRETS.*SECRET_MODE=644/);
    expect(installer).toMatch(/chmod "\$SECRET_MODE" "\$MASTER_KEY"/);
    // Refuses to clobber an existing key: a new one orphans every stored
    // credential rather than rotating it.
    expect(installer).toMatch(/already exists .*leaving it alone/s);
    // No `cat`/`echo` of the key file anywhere.
    expect(installer).not.toMatch(/cat\s+"?\$?\{?MASTER_KEY/);
  });
});

describe('least-privilege networking', () => {
  it('never publishes the database', () => {
    expect(service('db').ports).toBeUndefined();
  });

  it('keeps the database on the data network only', () => {
    expect(service('db').networks).toEqual(['data']);
  });

  it('keeps the proxy on the edge network only, so it cannot reach the database', () => {
    expect(service('caddy').networks).toEqual(['edge']);
  });

  it('keeps the worker off the edge network', () => {
    expect(service('worker').networks).toEqual(['data']);
    expect(service('worker').ports).toBeUndefined();
  });

  it('publishes only the proxy', () => {
    const published = Object.entries<any>(compose.services)
      .filter(([, svc]) => Array.isArray(svc.ports) && svc.ports.length)
      .map(([name]) => name);
    expect(published).toEqual(['caddy']);
  });
});

describe('container hardening', () => {
  it('drops capabilities and forbids privilege escalation on the app services', () => {
    for (const name of ['web', 'worker', 'migrate']) {
      expect(service(name).cap_drop, name).toContain('ALL');
      expect(service(name).security_opt, name).toContain('no-new-privileges:true');
    }
  });

  it('runs the app with a read-only root filesystem', () => {
    for (const name of ['web', 'worker']) {
      expect(service(name).read_only, name).toBe(true);
      // A read-only rootfs still needs somewhere to write, and it must be a
      // tmpfs rather than a volume that survives.
      expect(service(name).tmpfs, name).toBeDefined();
    }
  });

  it('runs the image as a non-root user', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
  });

  it('normalizes copied source modes before switching to the non-root user', () => {
    // Directory permissions are not tracked by Git. A private build worktree
    // previously produced an image where node could not traverse packages/db,
    // so the migrator failed with MODULE_NOT_FOUND despite the file existing.
    expect(dockerfile).toMatch(/RUN chmod -R a\+rX \/app\/node_modules \/app\/packages \/app\/apps \/app\/web/);
    expect(dockerfile.indexOf('RUN chmod -R a+rX')).toBeLessThan(dockerfile.indexOf('USER node'));
  });

  it('gives Caddy exactly the one capability it needs and no more', () => {
    // Binding 80/443 as a non-root process is the single reason it keeps any
    // capability at all.
    expect(service('caddy').cap_drop).toContain('ALL');
    expect(service('caddy').cap_add).toEqual(['NET_BIND_SERVICE']);
  });

  it('sets restart policies on everything long-running', () => {
    for (const name of ['web', 'worker', 'db', 'caddy']) {
      expect(service(name).restart, name).toBe('unless-stopped');
    }
    // The migrator is a one-shot; restarting it forever would be wrong.
    expect(service('migrate').restart).toBe('no');
  });

  it('health-checks every long-running service', () => {
    for (const name of ['web', 'worker', 'db', 'caddy']) {
      expect(service(name).healthcheck, name).toBeDefined();
      expect(service(name).healthcheck.test, name).toBeTruthy();
    }
  });

  it('uses named volumes so data survives a container being replaced', () => {
    expect(compose.volumes).toHaveProperty('db_data');
    expect(service('db').volumes).toContain('db_data:/var/lib/postgresql/data');
  });
});

describe('storage mounts — M45, M60', () => {
  /** Phase 9's runtime run on a real host found the compose file had no /data
   * mount at all: nowhere to bind a shared folder, and nowhere for a recovery
   * copy to live. Every unit test passed, because none of them mount anything. */
  it('gives the app a durable place for its own recovery copies', () => {
    for (const name of ['web', 'worker']) {
      const volumes: string[] = service(name).volumes ?? [];
      expect(volumes, `${name} must mount /data/versions`)
        .toContain('josi_versions:/data/versions');
    }
    // A named volume, so replacing a container does not destroy the only copy
    // of a file somebody deleted.
    expect(compose.volumes).toHaveProperty('josi_versions');
  });

  it('installs a pg client whose major version matches the database', () => {
    // pg_dump refuses to dump a server newer than itself. Debian bookworm ships
    // client 15 against postgres:16, so every backup failed with a generic
    // error on a real host while every unit test passed.
    const image: string = service('db').image;
    const serverMajor = /postgres:(\d+)/.exec(image)?.[1];
    expect(serverMajor, `could not read the postgres major from ${image}`).toBeTruthy();
    expect(dockerfile, `the image must install postgresql-client-${serverMajor}`)
      .toContain(`postgresql-client-${serverMajor}`);
  });

  it('creates its writable directories in the image, owned by the runtime user', () => {
    // A named volume inherits ownership from the image path it covers. Without
    // this the daemon creates them root-owned and every backup fails on a real
    // installation — found by a runtime run, invisible to every unit test.
    expect(dockerfile).toMatch(/mkdir -p \/data\/backups/);
    expect(dockerfile).toMatch(/chown -R node:node \/data/);
    const mkdirAt = dockerfile.indexOf('mkdir -p /data/backups');
    const userAt = dockerfile.lastIndexOf('USER node');
    expect(mkdirAt, 'directories must be created before dropping to USER node')
      .toBeLessThan(userAt);
  });

  it('mounts no shared folder by default', () => {
    // M45 is deny-by-default at the mount layer too. An installation that ships
    // with somebody's documents already mounted has made the decision for them.
    for (const name of ['web', 'worker']) {
      const volumes: string[] = service(name).volumes ?? [];
      const roots = volumes.filter((v) => v.includes('/data/roots'));
      expect(roots, `${name} must not mount a shared folder by default`).toEqual([]);
    }
  });

  it('passes explicit workspace authority into both development and release app services', () => {
    for (const candidate of [compose, releaseCompose]) {
      for (const name of ['web', 'worker']) {
        expect(candidate.services[name].environment).toMatchObject({
          JOSI_WORKSPACE_ENABLED: '${JOSI_WORKSPACE_ENABLED:-0}',
          JOSI_WORKSPACE_MODE: '${JOSI_WORKSPACE_MODE:-ro}',
        });
      }
    }
  });

  it('documents the example mount as read-only', () => {
    // The application has its own per-root writable flag, but `:ro` is the one
    // the kernel enforces, so the example an operator copies must carry it.
    const raw = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
    const examples = raw.split('\n').filter((l) => l.includes('/data/roots/') && l.trim().startsWith('#'));
    expect(examples.length).toBeGreaterThan(0);
    for (const line of examples) {
      expect(line, `example mount must be read-only: ${line.trim()}`).toMatch(/:ro\s*$/);
    }
  });
});

/**
 * Docker Compose's `${VAR}`, `${VAR:-default}` and `${VAR:+alternate}`
 * interpolation — enough of it to evaluate what a compose file actually hands a
 * container, rather than to eyeball the template and hope.
 * Compose treats unset and empty alike for both the `:-` and `:+` forms.
 */
function expandCompose(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([A-Z0-9_]+)(?::([-+])([^}]*))?\}/g, (_m, name, op, arg) => {
    const set = Boolean(env[name]);
    if (op === '-') return set ? env[name] : expandCompose(arg, env);
    if (op === '+') return set ? expandCompose(arg, env) : '';
    return set ? env[name] : '';
  });
}

describe('the proxy', () => {
  it('is templated on a domain rather than hard-coded to anything', () => {
    expect(caddyfile).toMatch(/\{\$JOSI_SITE_ADDRESS/);
    // No hosted-product hostname may appear here.
    expect(caddyfile).not.toMatch(/heyjosi|socalreceptionist/i);
  });

  it('sets the security headers a private workspace tool should send', () => {
    for (const header of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'X-Robots-Tag']) {
      expect(caddyfile, header).toContain(header);
    }
  });

  it('binds its admin API to loopback', () => {
    expect(caddyfile).toMatch(/admin 127\.0\.0\.1:2019/);
  });

  it('does not turn on automatic HTTPS by default', () => {
    // A BARE hostname as the site address makes Caddy issue itself a
    // certificate and answer plain HTTP with a 308 to a port it has dropped.
    // `localhost` was the default, so every LAN install was broken and no
    // static test saw it — the first acceptance run that booted the stack
    // failed 36 of 55 checks on this one line.
    //
    // The address must therefore carry a scheme or a port. `:80` is HTTP with
    // automatic HTTPS off; `https://host` asks for it deliberately.
    const site = /^\s*\{\$JOSI_SITE_ADDRESS:([^}]*)\}/m.exec(caddyfile);
    expect(site, 'the site address must be an env substitution with a default').toBeTruthy();
    expect(site![1], 'the default must be a port or carry a scheme').toMatch(/^(:\d+|https?:\/\/)/);

    // And the compose files must produce a usable address for BOTH cases. This
    // is evaluated rather than pattern-matched, because the first fix here
    // matched a perfectly good-looking pattern and still took the stack down:
    // it produced an EMPTY value when no domain was set, and Caddy's
    // `{$VAR:default}` falls back only when the variable is UNSET. An empty one
    // substitutes nothing, the site block becomes `{ … }`, Caddy rejects it
    // ("server block without any key is global configuration") and refuses to
    // start — so every request returned 000 rather than 308. Trading one total
    // outage for another is not a fix, and only evaluation sees the difference.
    for (const name of ['docker-compose.yml', 'docker-compose.release.yml']) {
      const raw = readFileSync(join(root, name), 'utf8');
      const assigned = /^\s*JOSI_SITE_ADDRESS:\s*(.+?)\s*$/m.exec(raw)?.[1];
      expect(assigned, `${name} must set JOSI_SITE_ADDRESS`).toBeTruthy();

      expect(expandCompose(assigned!, {}), `${name} with no domain`).toBe(':80');
      expect(expandCompose(assigned!, { JOSI_DOMAIN: '' }), `${name} with an empty domain`).toBe(':80');
      expect(expandCompose(assigned!, { JOSI_DOMAIN: 'josi.example.com' }), `${name} with a domain`)
        .toBe('https://josi.example.com');
    }
  });

  it('never ships `JOSI_DOMAIN=localhost` anywhere an operator will copy it', () => {
    // The compose files are fixed above, but the value reaches Caddy from
    // whatever the operator's .env says — so the defect also lives in every
    // file that TELLS them what to put there. It did: the documented LAN
    // example set `JOSI_DOMAIN=localhost`, and the acceptance script exported
    // the same thing, which is how a run meant to catch this was configured
    // into reproducing it.
    //
    // A domain is for a name that resolves publicly. Anything else must leave
    // it empty.
    const files = [
      '.env.example',
      'docs/INSTALLATION.md',
      'README.md',
      'scripts/install.sh',
      'scripts/acceptance/clean-install.sh',
      'docker-compose.yml',
      'docker-compose.release.yml',
    ];
    for (const name of files) {
      const text = readFileSync(join(root, name), 'utf8');
      for (const line of text.split('\n')) {
        // Skip prose explaining why this is wrong — it has to name the value.
        if (/^\s*(#|\/\/|>)/.test(line)) continue;
        expect(
          line,
          `${name} must not set JOSI_DOMAIN to a non-resolving name`,
        ).not.toMatch(/JOSI_DOMAIN[:=]\s*"?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1)/);
      }
    }
  });

  it('never passes a bare, defaultless env substitution as a directive argument', () => {
    // Caddy substitutes an unset variable with nothing, so `email {$FOO}` with
    // FOO unset becomes a bare `email` — a parse error that restart-loops the
    // container on every install that did not set it. Cost a real boot to find.
    // Either give the substitution a default, or do not emit the line.
    const offenders = caddyfile
      .split('\n')
      .map((line, i) => [i + 1, line.trim()] as const)
      .filter(([, line]) => !line.startsWith('#'))
      // A directive whose only argument is {$VAR} with no `:default`.
      .filter(([, line]) => /^[a-z_]+\s+\{\$[A-Z0-9_]+\}\s*$/.test(line));
    expect(offenders, `defaultless substitution(s): ${JSON.stringify(offenders)}`).toEqual([]);
  });
});

describe('no capacity claims are made anywhere', () => {
  it('publishes no user or concurrency numbers before benchmarks exist', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    // Phrases that would be a claim rather than a description.
    for (const pattern of [/supports up to \d+/i, /\d+\s*(concurrent )?users/i, /handles \d+/i]) {
      expect(readme, String(pattern)).not.toMatch(pattern);
    }
  });
});

describe('the image can actually be built', () => {
  /** Found the hard way in Phase 4: `packages/llm` was added to the workspace
   * but not to the Dockerfile's dependency layer. `tsc -b` passed locally
   * against an already-linked node_modules and the image build failed on a
   * clean host with "cannot find module @josi-ce/llm".
   *
   * npm creates a workspace's node_modules symlink only if its package.json
   * exists at `npm ci` time, so every workspace must be COPYed before it. */
  it('copies every workspace package.json before npm ci', () => {
    expect(workspaces.length).toBeGreaterThan(2);
    const beforeInstall = dockerfile.split('RUN npm ci')[0];
    for (const ws of workspaces) {
      // The API and worker share one image; whichever workspaces exist, each
      // one's manifest has to be present before the install.
      expect(beforeInstall, `${ws}/package.json is not COPYed before npm ci`)
        .toContain(`${ws}/package.json`);
    }
  });

  /** Found the hard way AGAIN in Phase 9, and it is worth naming why the test
   * above did not catch it.
   *
   * `packages/storage` was added to the workspaces and to the Dockerfile, so the
   * COPY assertion passed. But `package-lock.json` had never been regenerated,
   * and `npm ci` — unlike `npm install` — refuses to proceed when the lockfile
   * and the manifests disagree. The build died on a clean host while every local
   * check was green, because local `node_modules` already had the workspace
   * symlink.
   *
   * Two independent things must both be true for a clean build, and the earlier
   * test only asserted one of them. */
  it('lists every workspace in the lockfile, so npm ci does not refuse', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { name?: string; link?: boolean; resolved?: string }>;
    };

    for (const ws of workspaces) {
      expect(lock.packages, `${ws} is missing from package-lock.json — run npm install`)
        .toHaveProperty(ws);
    }

    // And the node_modules link that makes `@josi-ce/x` resolvable at all.
    for (const ws of workspaces) {
      const pkgName = (
        JSON.parse(readFileSync(join(root, ws, 'package.json'), 'utf8')) as { name: string }
      ).name;
      const linkKey = `node_modules/${pkgName}`;
      expect(lock.packages, `${linkKey} is missing from package-lock.json`).toHaveProperty(linkKey);
      expect(lock.packages[linkKey].link, `${linkKey} should be a workspace link`).toBe(true);
    }
  });
});

describe('the web app ships with the image', () => {
  it('builds the bundle in the image rather than trusting a committed one', () => {
    // A committed dist is a build nobody can reproduce and a place for stale
    // code to hide. It is built from the source in this image or not at all.
    expect(dockerfile).toMatch(/npm run build --workspace @josi-ce\/web/);
    expect(dockerfile).toMatch(/apps\/web\/dist \.\/web/);
  });

  it('points the API at the bundle', () => {
    expect(compose.services.web.environment.WEB_DIR).toBe('/app/web');
  });

  it('loads nothing from a third-party origin', () => {
    // The whole point of the CSP. The engine's page pulls fonts from Google;
    // a self-hosted product doing that tells a third party the IP of everyone
    // who opens it, and breaks air-gapped. This asserts the source, so a CDN
    // link added later fails here rather than in someone's firewall log.
    const html = readFileSync(join(root, 'apps/web/index.html'), 'utf8');
    expect(html).not.toMatch(/https?:\/\//);
    const css = readFileSync(join(root, 'apps/web/src/index.css'), 'utf8');
    expect(css).not.toMatch(/@import\s+url\(|https?:\/\//);
  });

  it('sets a content security policy that forbids external origins', () => {
    // Asserted against the real header value, not the source text: a directive
    // is only worth what the browser receives.
    const directives = new Map(
      CONTENT_SECURITY_POLICY.split(';').map((d) => {
        const [name, ...rest] = d.trim().split(/\s+/);
        return [name, rest.join(' ')];
      }),
    );
    expect(directives.get('default-src')).toBe("'self'");
    expect(directives.get('script-src')).toBe("'self'");
    expect(directives.get('connect-src')).toBe("'self'");
    expect(directives.get('font-src')).toBe("'self'");
    expect(directives.get('frame-ancestors')).toBe("'none'");
    expect(directives.get('object-src')).toBe("'none'");
    // No wildcard anywhere, and no inline-script exemption. `style-src` does
    // carry 'unsafe-inline' — React sets a style attribute for the visual
    // viewport height — but that still forbids an external stylesheet, which is
    // the property this policy exists for.
    expect(CONTENT_SECURITY_POLICY).not.toContain('*');
    expect(directives.get('script-src')).not.toContain('unsafe-inline');
    expect(directives.get('style-src')).toBe("'self' 'unsafe-inline'");
  });

  it('keeps the official brand assets byte-for-byte', () => {
    // The identity was approved once and preserved as a master; CE must not
    // regenerate or substitute it, and self-hosters may not replace it.
    for (const asset of ['josi-mark.png', 'josi-wordmark.png']) {
      const bytes = readFileSync(join(root, 'apps/web/public/brand', asset));
      expect(bytes.length, asset).toBeGreaterThan(1000);
      // PNG magic. A swapped-in placeholder of another format fails here.
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }
  });
});

describe('jsonb is never hand-serialised', () => {
  /** The Phase 6 browser run found the admin model page crashing on
   * `probeSteps.map is not a function`. A route had written a jsonb column with
   * `JSON.stringify(...)` and a `::jsonb` cast instead of the `json()` helper.
   *
   * Under postgres.js that stores a jsonb STRING SCALAR rather than an array,
   * and reading it back yields a string. `packages/core/src/db.ts` says exactly
   * this — "silent in tests and permanent in production" — and it is: the unit
   * suite passes against pglite with the bug present, which was verified by
   * re-introducing it.
   *
   * So the unit suite cannot catch the behaviour. It can catch the SHAPE, which
   * is what this does: no source file may pair a hand-serialised value with a
   * jsonb cast, because `json()` is the thing that exists for it. */
  it('no route pairs JSON.stringify with a ::jsonb cast', () => {
    // Derived from the workspaces, not listed. The hardcoded version of this
    // line covered five directories and silently skipped every package added
    // after it was written — including the three that Phases 7, 8 and 9 added.
    const roots = workspaces.map((ws) => `${ws}/src`);
    const offenders: string[] = [];

    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) out.push(...walk(rel));
        else if (entry.name.endsWith('.ts')) out.push(rel);
      }
      return out;
    };

    for (const dir of roots) {
      if (!existsSync(join(root, dir))) continue;
      for (const file of walk(dir)) {
        const src = readFileSync(join(root, file), 'utf8');
        // db.ts documents the trap and is allowed to name it.
        if (file.endsWith('core/src/db.ts')) continue;
        // Two shapes, because the first version of this check only knew one.
        //
        //   1. `JSON.stringify(x)` next to an explicit `::jsonb` cast.
        //   2. `JSON.stringify(x)` inside a query's parameter array at all.
        //
        // The second is what actually bit twice: writing a jsonb COLUMN needs
        // no cast in the SQL, so a hand-serialised parameter sailed past a
        // check looking for `::jsonb`. postgres.js serialises the value itself,
        // so passing an already-stringified string stores a jsonb string
        // scalar — invisible under pglite, permanent in production. Found in
        // Phase 6, and again in Phase 12 in a different package.
        if (/::jsonb/.test(src) && /JSON\.stringify\(/.test(src)) {
          offenders.push(file);
          continue;
        }
        for (const call of src.matchAll(/db\.query[\s\S]{0,4000}?\n\s*\[([\s\S]{0,600}?)\][,)]/g)) {
          if (/JSON\.stringify\(/.test(call[1])) {
            offenders.push(`${file} (hand-serialised query parameter)`);
            break;
          }
        }
      }
    }
    expect(offenders, `use json() from @josi-ce/core instead: ${offenders.join(', ')}`).toEqual([]);
  });
});
