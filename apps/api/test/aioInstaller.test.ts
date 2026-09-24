import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../../..');
const dockerfile = readFileSync(join(root, 'Dockerfile.aio'), 'utf8');
const installer = readFileSync(join(root, 'scripts/aio-install.sh'), 'utf8');
const envExample = readFileSync(join(root, '.env.example'), 'utf8');

describe('the browser-first AIO installer', () => {
  it('runs a temporary TLS browser controller and exits after handoff', () => {
    expect(dockerfile).toMatch(/^FROM docker:29-cli$/m);
    expect(dockerfile).toMatch(/ENTRYPOINT \["\/usr\/local\/bin\/josi-ce-aio-install"\]/);
    expect(dockerfile).toContain('services/installer/controller.py');
    expect(dockerfile).toContain('services/installer/index.html');
    expect(installer).toContain('exec python3 /opt/josi-installer/controller.py');
    const controller = readFileSync(join(root, 'services/installer/controller.py'), 'utf8');
    expect(controller).toContain('ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)');
    expect(controller).toContain('threading.Timer(45, lambda: os._exit(0))');
  });

  it('requires an explicit Docker socket and proves the host path mapping', () => {
    expect(installer).toMatch(/\[\[ -S \/var\/run\/docker\.sock \]\]/);
    expect(installer).toMatch(/docker run --rm -v "\$PWD:\/josi-install:ro"/);
    expect(installer).toContain('-v "$PWD:$PWD" -w "$PWD"');
    expect(installer).toContain('~/.docker/run/docker.sock');
  });

  it('moves all interactive choices into the browser', () => {
    const page = readFileSync(join(root, 'services/installer/index.html'), 'utf8');
    expect(page).toContain('How will you open Josi?');
    expect(page).toContain('On this local network');
    expect(page).toContain('Public domain with automatic HTTPS');
    expect(page).toContain('Existing reverse proxy');
    expect(page).toContain('Review installation');
    expect(page).not.toContain('.innerHTML');
    expect(page).toContain('replaceChildren');
    expect(installer).not.toMatch(/\bread\s+-[rp]/);
  });

  it('protects the LAN setup UI with TLS and a one-time high-entropy code', () => {
    const controller = readFileSync(join(root, 'services/installer/controller.py'), 'utf8');
    expect(installer).toContain('openssl rand -hex 16');
    expect(installer).toContain('https://${host_ip}:${INSTALLER_PORT}');
    expect(controller).toContain('hmac.compare_digest');
    expect(controller).toContain('HttpOnly; Secure; SameSite=Strict');
    expect(controller).toContain('X-Josi-Installer');
  });

  it('refreshes managed files, preserves operator Caddy config, and backs up upgrades', () => {
    expect(installer).toContain('policy="${4:-replace}"');
    expect(installer).toContain('Caddyfile 0644 preserve');
    expect(installer).toContain('${target}.pre-${VERSION}');
    expect(installer).toContain('.env.pre-${VERSION}');
    expect(installer).toContain('JOSI_COMPOSE_SECRETS=1 bash ./install.sh');
    expect(installer).toContain('chown -R "$INSTALL_UID:$INSTALL_GID" secrets');
  });

  it('pins the published stack instead of silently floating on latest', () => {
    expect(dockerfile).toContain('ARG JOSI_VERSION=0.1.0');
    expect(dockerfile).toContain('ENV JOSI_VERSION=$JOSI_VERSION');
    expect(installer).toContain('readonly VERSION="${JOSI_VERSION:-0.1.0}"');
    expect(installer).toContain('JOSI_TAG=${VERSION}');
    expect(installer).not.toMatch(/JOSI_TAG=latest/);
  });

  it('uses the anonymously pullable Docker Hub release for nested helpers and the stack', () => {
    expect(installer).toContain(
      'JOSI_INSTALLER_IMAGE:-docker.io/romanvaxman/josi-ce-installer:${VERSION}',
    );
    expect(envExample).toMatch(/^JOSI_REGISTRY=docker\.io\/romanvaxman$/m);
    expect(installer).not.toContain('ghcr.io/vaxman14/josi-ce-installer');
  });

  it('points the default browser URL at the proxy port that is actually published', () => {
    expect(envExample).toMatch(/^JOSI_APP_URL=http:\/\/localhost$/m);
    expect(envExample).not.toMatch(/^JOSI_APP_URL=http:\/\/localhost:8080$/m);
  });

  it('never accepts or prints secret values', () => {
    expect(installer).not.toMatch(/MASTER_KEY=/);
    expect(installer).not.toMatch(/POSTGRES_PASSWORD=/);
    expect(installer).not.toMatch(/cat .*secrets\//);
  });

  it('lets only the installer controller provision the narrow Voice Box helper', () => {
    expect(dockerfile).toContain('services/voice-box/host_helper.py');
    expect(dockerfile).toContain('python3');
    const controller = readFileSync(join(root, 'services/installer/controller.py'), 'utf8');
    expect(controller).toContain('josi-ce-voice-helper-');
    expect(controller).toContain('/opt/josi-voice-box/host_helper.py');
    expect(controller).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(controller).toContain('"--network", "none"');
    expect(controller).toContain('voice-helper-socket/helper.sock');
    expect(controller).toContain('josi-ce-storage-helper-');
    expect(controller).toContain('storage-helper-socket/helper.sock');
    expect(controller).toContain('storage_helper.py');
    const storageHelper = readFileSync(join(root, 'services/installer/storage_helper.py'), 'utf8');
    expect(storageHelper).toContain('if username or password or not cred.exists()');
    expect(storageHelper).toContain("docker-compose.workspace.yml");
    expect(storageHelper).toContain("docker-compose.noproxy.yml");
    expect(storageHelper).toContain("self.compose_files(False)");
  });
});
