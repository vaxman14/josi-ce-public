# Josi CE installation and operations manual

This manual describes how to install the Josi CE Community Preview from this
repository. It is intentionally explicit. Commands are written for a Linux
server unless a section says otherwise.

> **Release warning**
>
> Josi CE 0.1 is a Community Preview. The application and one-shot installer
> are published for Linux amd64 and arm64. A clean published-image install and
> live multi-user isolation test are recorded in `docs/ACCEPTANCE.md`.
>
> Things that are genuinely absent rather than merely rough, as of this
> paragraph:
>
> - **No update has ever been applied.** The rollback path is verified against
>   a real database, but no release has been downloaded and installed by the
>   product, so the in-product upgrade is logic rather than a measurement.
> - **Document processing is bounded, not magical.** Supported files can be
>   extracted, scanned, indexed, searched and cited; configured cloud sources
>   can synchronize. Unsupported, encrypted, unsafe or over-limit files are
>   skipped with an explicit reason. OCR and ClamAV remain optional services.
>
> Do not treat this preview as production-ready merely because the containers
> start.

## 0. Install Josi — the short path

This is the normal installation. It needs a Linux server with Docker on it and
nothing else: no repository access, no Node.js, no build tools, and no knowledge
of how this project is laid out. Everything after this section is the reference
manual, and you do not have to read it to install.

A domain name pointing at this server, with ports 80 and 443 reachable, enables
automatic HTTPS. It is optional for a trusted local evaluation; read §0.4 for
that path.

### 0.1 Install

```bash
mkdir -p /opt/josi && cd /opt/josi
docker run --rm \
  -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD:$PWD" -w "$PWD" \
  romanvaxman/josi-ce-installer:latest
```

The version-pinned container prints a local HTTPS URL and one-time setup code.
Open it in a browser, accept the temporary self-signed certificate, and choose
LAN access, automatic HTTPS, or an existing reverse proxy. The wizard detects
usable LAN addresses, checks the requested ports, shows the exact final URL,
and asks for confirmation before changing anything.

After confirmation it atomically persists the choices in `.env`, creates
`secrets/master.key` and `secrets/db_password`, pulls the published images,
starts and verifies the isolated Compose services, and exits. No Docker-socket
controller remains running.

> **Back up `secrets/master.key` now, somewhere other than this server.**
> Every credential Josi stores — provider keys, OAuth secrets, SMTP passwords —
> is encrypted with it. A database backup alone cannot restore them. This is
> deliberate: it is what makes a stolen database dump useless. See §15.1.

Select **Open Josi** when the installer reports success. The application wizard creates the
first account, which becomes the super admin, and tests each thing it configures
rather than only saving it. That button carries a one-time setup handoff in the
URL fragment; it is removed immediately and is never sent in HTTP logs. Setup
routes return 404 in any browser that did not complete the installer pairing.

### 0.2 Change the address later

Open **Admin → Network & address**. After fresh administrator-password confirmation, Josi asks its
narrow maintenance supervisor to launch a short-lived browser controller on port 8080. The normal
web container never receives the Docker socket or access to the host `.env`. The controller previews
LAN, automatic-HTTPS, reverse-proxy, and port changes; progress survives the normal origin restarting.
If the new origin does not become healthy, the controller restores the previous configuration and
recreates the previous stack automatically. The one-time setup code expires with that session.

The password field is a genuine reauthentication prompt: enter the current **Admin password**. Josi
does not save it. The supervisor binds the temporary controller to the host's LAN interface, proves
its HTTPS health endpoint is ready, and only then opens the one-time LAN URL. If port 8080 is occupied
or the controller exits, Josi stays on the current page and reports the startup failure instead of
opening a dead tab. The controller is never routed through Josi's public domain.

Before the changed API becomes ready, Josi treats `APP_URL` as the canonical browser-facing origin
and atomically repairs `deployment_config`, Workspace public-address metadata, configured OAuth
callback URLs, and the stored Telegram webhook URL. A changed certificate is no longer reported as
verified, and a moved Telegram webhook is shown as needing registration rather than falsely showing
the old registration time. The Connectors page builds new callbacks from that same origin, including
external-proxy and Cloudflare Tunnel installations.

API readiness is the transaction boundary for a network change. If metadata synchronization, Caddy,
the external-proxy Compose shape, or another health check fails, the controller restores the previous
`.env` and Compose overrides and recreates the previous stack. That stack starts with the previous
`APP_URL` and atomically restores the previous deployment, Workspace, OAuth, and webhook metadata.
Josi does not contact Telegram during startup: after DNS and TLS work at the new address, use
**Admin → Telegram → Register the webhook** to commit the remote provider-side change.

Password managers remain available on genuine login, password-confirmation, and password-reset
fields. Configuration secrets (Vault entries, SMTP, backup credentials, and integration tokens)
explicitly opt out of login autofill so extensions such as 1Password do not repeatedly open sign-in
prompts while an administrator edits settings.

### 0.4 If you do not have a domain

Josi still installs, but two things change and both are worth understanding
before you choose this.

- **No automatic HTTPS.** Caddy cannot obtain a certificate for an IP address or
  for a name that only resolves on your LAN. Traffic between browsers and Josi
  on your network is unencrypted.
- **Google and Microsoft cannot be connected.** Both require an HTTPS redirect
  URI on a real domain. Josi will tell you this on the connector screen rather
  than generating a callback that cannot work. See §12A.

The default install is already LAN/local HTTP. Set the address other devices use
in `.env`, then apply it:

```bash
sed -i 's#^JOSI_APP_URL=.*#JOSI_APP_URL=http://192.168.1.50#' .env
docker compose up -d
```

Cookies are marked non-secure automatically when `JOSI_APP_URL` is `http://`,
because a secure cookie is never sent over plain HTTP and sign-in would fail
with no visible reason.

Adding a domain later is supported: set `JOSI_DOMAIN` and `JOSI_APP_URL`, then
run `docker compose up -d`. Nothing needs to be reinstalled.

### 0.5 What to change, and what not to

Almost every installation sets exactly one value. The rest have working
defaults, and `.env.example` documents each of them.

| Value | When you set it |
|---|---|
| `JOSI_DOMAIN` | Always, unless you are on the LAN-only path above. |
| `JOSI_APP_URL` | Only when Josi is not reached at `https://$JOSI_DOMAIN` — a different port, a path prefix, or the LAN-only path. |
| `JOSI_HTTP_PORT`, `JOSI_HTTPS_PORT` | Only when something else already uses 80/443. |
| `JOSI_TAG` | To pin or move between releases. Defaults to the version this file shipped with; it never floats. |
| `POSTGRES_DB`, `POSTGRES_USER` | Almost never. Cosmetic. |
| `JOSI_OCR_*`, `JOSI_CLAMAV_*` | Only if you enable those optional profiles (§11). |

### 0.6 Everyday commands

```bash
docker compose ps                     # what is running
docker compose logs -f web            # follow the application log
docker compose restart web            # restart after a config change
docker compose pull && docker compose up -d   # move to a newer JOSI_TAG
docker compose down                   # stop everything, keep all data
```

`docker compose down` keeps your data. Only `docker compose down -v` destroys
it, and it destroys all of it. Uninstalling is §14.2.

### 0.7 When the short path is not enough

Everything below this section is the reference manual. Go there for: building
from source, an external PostgreSQL, running behind an existing reverse proxy,
custom networks, firewall rules, backup and restore procedures, upgrades and
rollback, and the full troubleshooting index.

The separate command-line client is not required to run the server. If you want
it, follow the pinned, signature-verifying installation in
[`CLI.md`](CLI.md); do not copy the repository's development script directly
onto an operational host.

---

## 1. What the standard installation creates

The default Compose deployment creates five service roles:

| Service | Purpose | Host exposure |
|---|---|---|
| `db` | PostgreSQL 16 database | None |
| `migrate` | Applies database migrations, then exits | None |
| `web` | API and browser application | Through Caddy only |
| `worker` | Background jobs | None |
| `caddy` | HTTP/HTTPS reverse proxy and certificate renewal | Ports 80 and 443 |

Two optional services are disabled unless explicitly selected:

| Service | Compose profile | Purpose |
|---|---|---|
| `ocr` | `ocr` | Optical character recognition |
| `clamav` | `clamav` | Malware scanning |

The database is attached only to the private `data` network. Caddy is attached
only to the `edge` network. The worker is not reachable through the proxy.

## 2. Supported deployment shapes

Choose one deployment shape before changing configuration.

### 2.1 Public HTTPS with bundled Caddy

Use this for the usual single-server installation. You need a public DNS name,
inbound TCP ports 80 and 443, and no other process already using those ports.
Caddy obtains and renews the TLS certificate.

### 2.2 Existing reverse proxy

Use this when nginx, Traefik, HAProxy, a load balancer, or another Caddy instance
already terminates HTTPS. Josi publishes its web service on a configurable host
port. Your proxy forwards HTTPS traffic to that port.

### 2.3 Local HTTP evaluation

Use this only on a trusted machine or trusted LAN for evaluation. Secure
cookies must be disabled for plain HTTP. Never expose this mode to the public
Internet.

## 3. Host requirements

### 3.1 Operating system and architecture

Use a 64-bit Linux host supported by Docker Engine. The application image is
intended for `linux/amd64` and `linux/arm64`.

Do not use a 32-bit operating system. Raspberry Pi installations require a
64-bit OS. Josi does not publish capacity claims yet; workload, connector use,
and local inference change resource requirements substantially.

### 3.2 Required software

Install:

- Git
- Docker Engine
- Docker Compose v2, invoked as `docker compose`
- OpenSSL, or a readable `/dev/urandom`
- `curl` for host-side verification

Confirm each dependency:

```bash
git --version
docker version
docker compose version
openssl version
curl --version
```

`docker-compose` with a hyphen is the retired Compose v1 client. This manual
uses Compose v2.

### 3.3 Docker access

Run Docker as root, or configure the installation account to access the Docker
daemon. Membership in the `docker` group is effectively root-level access to
the host. Treat it accordingly.

Verify access:

```bash
docker run --rm hello-world
```

### 3.4 Network requirements

For bundled Caddy:

- Create an `A` record pointing the chosen hostname to the server's public IPv4
  address.
- Create an `AAAA` record only if IPv6 actually reaches the server.
- Forward TCP 80 and 443 through the router or firewall.
- Permit outbound DNS and HTTPS so Caddy can reach the ACME certificate
  authority and Josi can reach configured providers.

Check DNS from a machine outside the server's LAN:

```bash
dig +short A josi.example.com
dig +short AAAA josi.example.com
```

Replace `josi.example.com` everywhere in this manual with the real hostname.

If an incorrect `AAAA` record exists, some clients and certificate validation
requests may use broken IPv6 even while IPv4 works. Remove the record or fix
IPv6 routing.

## 4. Obtain the source — advanced only

> **Most installations do not need this section.** The normal path is §0: three
> downloaded files and `docker compose up -d`, with no repository access and no
> build. Come here only if you are modifying Josi, building an image for a
> platform that is not published, or auditing the source you are running.

Choose a permanent directory. Do not run a long-lived installation from a
Downloads folder.

```bash
sudo mkdir -p /opt/josi-ce
sudo chown "$(id -u):$(id -g)" /opt/josi-ce
git clone <REPOSITORY-URL> /opt/josi-ce
cd /opt/josi-ce
```

Until the repository is public, replace `<REPOSITORY-URL>` with the private
clone URL available to the operator. Do not put access tokens directly in the
command or shell history.

Confirm the checkout and inspect its state:

```bash
git remote -v
git status --short --branch
git log -1 --oneline
```

For a release, check out its signed or documented release tag instead of an
arbitrary moving branch:

```bash
git fetch --tags
git checkout <RELEASE-TAG>
```

## 5. Read the configuration before starting

The repository includes these deployment files:

- `docker-compose.yml`: default stack and optional profiles
- `docker-compose.noproxy.yml`: publishes the web service for an existing proxy
- `Caddyfile`: bundled reverse proxy configuration
- `.env.example`: non-secret operator settings
- `scripts/install.sh`: generates the master key and database password

Validate the Compose model before creating anything:

```bash
docker compose config --quiet
```

This command expands configuration but does not start containers.

## 6. Configure `.env`

Copy the example and restrict its permissions:

```bash
cp .env.example .env
chmod 600 .env
```

The current `.env` contains no secrets, but restrictive permissions prevent a
future operator-added value from becoming broadly readable.

Edit it with your preferred editor:

```bash
nano .env
```

### 6.1 Domain and application URL

Public HTTPS example:

```dotenv
JOSI_DOMAIN=josi.example.com
JOSI_APP_URL=https://josi.example.com
JOSI_COOKIE_SECURE=
JOSI_HTTP_PORT=80
JOSI_HTTPS_PORT=443
```

`JOSI_DOMAIN` is the hostname Caddy serves. Do not include `https://`, a path,
or a trailing slash.

`JOSI_APP_URL` is the browser-facing origin. Include the scheme. Do not add a
trailing slash. OAuth redirect URLs and security checks depend on this value
being the actual external URL.

Leave `JOSI_COOKIE_SECURE` empty for the normal path. Josi infers secure cookies
from the `https://` scheme in `JOSI_APP_URL`. An explicit `true` or `false` is
an advanced override. A browser refuses to send a Secure cookie over plain
HTTP, so the URL scheme must be accurate.

Local HTTP evaluation example:

```dotenv
JOSI_DOMAIN=
JOSI_APP_URL=http://192.168.1.10:8080
JOSI_COOKIE_SECURE=
JOSI_HTTP_PORT=8080
JOSI_HTTPS_PORT=8443
```

`JOSI_DOMAIN` is **empty** here, and that is the whole point of this example.
Caddy reads the site address as `:80` — plain HTTP, no certificate, no
redirect. Putting a bare hostname in it (`localhost` included) turns automatic
HTTPS on instead, and Caddy then answers plain HTTP with a `308` redirect to
`https://` on the standard port — which, behind a mapped port, is nowhere. Use
a name here only when that name resolves publicly and you want a certificate
for it.

Do not explicitly set `JOSI_COOKIE_SECURE=false` on a public deployment.

### 6.2 Host ports

`JOSI_HTTP_PORT` maps the host's chosen port to Caddy port 80.
`JOSI_HTTPS_PORT` maps the host's chosen port to Caddy port 443.

The normal public values are 80 and 443. Changing them means users must include
the nonstandard port in the URL unless another device forwards standard ports.

Check for conflicts before starting:

```bash
sudo ss -lntp | grep -E ':(80|443)[[:space:]]' || true
```

### 6.3 Database names

Defaults:

```dotenv
POSTGRES_DB=josi
POSTGRES_USER=josi
```

These values are identifiers, not passwords. Changing either after the database
volume has been initialized does not rename the existing database or user. Set
them once before first start and leave them stable.

### 6.4 Application image

Defaults:

```dotenv
JOSI_IMAGE=josi-ce
JOSI_TAG=local
```

The current Compose file builds from the local checkout and tags the resulting
image `josi-ce:local`. A future published release may provide a registry image
and immutable version tag. Do not use a floating `latest` tag for a controlled
deployment.

### 6.5 Optional-service limits

Defaults:

```dotenv
JOSI_OCR_CPUS=1.0
JOSI_OCR_MEMORY=512m
JOSI_CLAMAV_MEMORY=1500m
```

These are container ceilings. OCR and ClamAV do not start merely because the
values exist. Their Compose profiles must also be selected.

ClamAV needs substantial memory while loading and updating signatures. Do not
enable it on a constrained host without observing memory pressure.

## 7. Generate installation secrets

Run:

```bash
./scripts/install.sh
```

The script creates:

- `secrets/master.key`: encrypts stored provider, OAuth, and mail credentials
- `secrets/db_password`: authenticates the application to PostgreSQL

The directory is mode `0700`; each file is mode `0600`. Values are deliberately
not printed.

Verify without changing anything:

```bash
./scripts/install.sh --check
```

The installer is idempotent: rerunning it leaves existing secret files alone.
It never rotates the master key.

### 7.1 Master-key warning

The master key is not stored in PostgreSQL. That protects credentials if a
database dump is stolen, but it creates an operational obligation:

**Losing `secrets/master.key` makes encrypted credentials permanently
unreadable.** A database backup alone is insufficient.

Before continuing, copy the master key to encrypted storage on a different
device. Example using removable media already mounted at `/mnt/secure-backup`:

```bash
install -m 600 secrets/master.key /mnt/secure-backup/josi-master.key
```

Do not email the key, paste it into chat, store it in Git, or include it in a
normal unencrypted cloud folder. Record which installation it belongs to.

Check that Git ignores the generated directory:

```bash
git check-ignore -v secrets/master.key secrets/db_password
```

## 8. Build and start the default stack

Review the resolved configuration. This output should contain file paths but
must not contain the secret values:

```bash
docker compose config
```

Build the application image:

```bash
docker compose build --pull
```

Start in detached mode:

```bash
docker compose up -d
```

Watch startup:

```bash
docker compose ps
docker compose logs -f --tail=200
```

Press `Ctrl+C` to stop following logs. This does not stop the containers.

Expected state:

- `db`, `web`, `worker`, and `caddy` are running.
- `migrate` exited with code 0 after applying migrations.
- `ocr` and `clamav` do not exist unless their profiles were enabled.

Inspect a failed service without restarting the whole stack:

```bash
docker compose logs --tail=300 <SERVICE>
docker compose ps -a
```

Replace `<SERVICE>` with `db`, `migrate`, `web`, `worker`, or `caddy`.

## 9. Verify the installation

### 9.1 Container health

```bash
docker compose ps
```

Do not equate "running" with "ready." The health and readiness endpoints test
different layers.

### 9.2 Liveness

For public HTTPS:

```bash
curl -fsS https://josi.example.com/health
```

For localhost evaluation:

```bash
curl -fsS http://localhost/health
```

Liveness means the API process answers.

### 9.3 Readiness

```bash
curl -fsS https://josi.example.com/ready
```

Readiness additionally checks the database, migrations, and master-key
availability. A live but unready service should not receive normal traffic.

### 9.4 TLS and redirects

```bash
curl -I http://josi.example.com
curl -I https://josi.example.com
openssl s_client -connect josi.example.com:443 -servername josi.example.com </dev/null
```

If certificate issuance fails, check DNS, inbound ports, Caddy logs, router
port forwarding, firewall policy, and incorrect IPv6 records.

### 9.5 Optional services remain absent

```bash
docker compose ps --all
docker ps --format '{{.Names}}' | grep -E '(ocr|clamav)' && echo unexpected || echo absent
```

## 10. Complete the setup wizard

Open `JOSI_APP_URL` in a browser. A fresh installation exposes the setup wizard
and refuses normal application routes until setup completes.

The wizard covers:

1. Host checks
2. Super-admin account
3. Domain and HTTPS review
4. LLM provider
5. System and Josi mail profiles
6. Security and privacy choices
7. Explicit telemetry choice
8. Review and completion

Google and Microsoft are deliberately not among them. Registering either
application requires a public HTTPS domain, which a LAN-only installation does
not have while it is being set up, so the step could only ever be skipped. They
are registered afterwards from **Admin → Connectors**, which says so plainly
until a domain exists. See §12A.

Setup is single-use. After completion, setup routes return 404 and cannot be
used to create another super administrator.

Record recovery information in the organization's password manager. Do not put
provider keys, OAuth secrets, SMTP passwords, or recovery material in this
repository.

## 11. Enable optional OCR and ClamAV profiles

Profiles may be combined.

OCR only:

```bash
docker compose --profile ocr up -d
```

ClamAV only:

```bash
docker compose --profile clamav up -d
```

Both:

```bash
docker compose --profile ocr --profile clamav up -d
```

Verify:

```bash
docker compose --profile ocr --profile clamav ps
docker compose logs --tail=200 ocr clamav
```

ClamAV's first signature load can take several minutes. Its healthcheck allows
a five-minute start period.

To stop and remove an optional service while leaving the core running:

```bash
docker compose stop ocr
docker compose rm -f ocr
```

Use `clamav` in place of `ocr` for the malware scanner. Removing the ClamAV
container does not remove the named signature volume unless you deliberately
remove volumes.

### Configure document storage

Open **Admin → Storage** to control the workspace-wide indexing limits. The
page includes maximum file size, total indexed storage per person, maximum file
count, and the extension allowlist. Extensions are entered without a leading
dot and separated by commas or spaces.

Archive indexing is disabled by default. **Admin → Storage → Archives** enables
it and exposes the safety bounds for entry count, expanded size, nesting depth,
and processing time. Archive entries still pass the normal file-type,
encryption, and malware gates; enabling archives does not turn unknown or
unsafe file types into accepted documents.

Raise limits carefully. Larger files and archives increase CPU, memory, and
disk use, especially on Pi-class installations. Files skipped under the old
policy are reconsidered on a later sync when their source reports them again.

## 12. Use an existing reverse proxy

Create `.env` with the real public URL and a local published port:

```dotenv
JOSI_DOMAIN=josi.example.com
JOSI_APP_URL=https://josi.example.com
JOSI_COOKIE_SECURE=true
JOSI_WEB_PORT=8080
```

Start with the override and scale bundled Caddy to zero:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.noproxy.yml \
  up -d --scale caddy=0
```

Josi is then available to the host proxy at `http://127.0.0.1:8080` if Docker
binds to loopback. The current override publishes on all host interfaces. If
the machine is not protected by a firewall, tighten the port mapping in a local
override:

```yaml
services:
  web:
    ports:
      - "127.0.0.1:${JOSI_WEB_PORT:-8080}:8080"
```

Save that as `docker-compose.local.yml` and include it last:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.noproxy.yml \
  -f docker-compose.local.yml \
  up -d --scale caddy=0
```

The external proxy must:

- Terminate HTTPS with a valid certificate.
- Preserve the original `Host` header.
- Forward `X-Forwarded-For`.
- Forward `X-Forwarded-Proto: https`.
- Support normal long-lived HTTP responses used by the application.
- Apply sensible request-size and timeout limits without truncating supported
  application traffic.

Minimal nginx location:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

After proxy changes, verify `/health`, `/ready`, login, logout, and a browser
refresh on an authenticated route.

## 12A. Google and Microsoft on a LAN-only installation

Referenced from §0.4. The short answer is that you cannot connect them without
a domain name, and Josi will tell you so rather than generating a callback that
cannot work.

### Why

Both providers require the OAuth redirect URI to be an **HTTPS URL on a
resolvable domain**. Neither accepts:

- an IP address, with or without TLS — no publicly trusted certificate authority
  will issue for one;
- `localhost` or a `.local` name, which their servers cannot resolve;
- plain HTTP on any host other than `localhost`, which is reserved for
  development clients rather than web applications.

So there is no redirect URI a LAN-only installation could register. This is why
the two applications are not part of setup at all: a wizard step whose only
available outcome is "continue without them" is not a step. **Admin →
Connectors** states the requirement and draws no credential fields until a
public domain exists, instead of generating `https://192.168.1.50/...` and
letting Google reject it — a failure that produces the provider's error page
rather than ours, and is the hardest connector problem to diagnose from the
outside.

### What still works without them

Everything except Google and Microsoft. The assistant, tasks, approvals,
conversations, contacts you add yourself, documents, Telegram and the model
provider are all unaffected. The launch checklist shows the connectors as
**Not available here** with the reason, rather than as outstanding work you
cannot do.

### The supported ways to get one

1. **A public domain pointing at this server.** The normal path. Set
   `JOSI_DOMAIN`, restart, and Caddy obtains a certificate automatically.
2. **A public domain that resolves to a private address (split-horizon DNS).**
   This works for the browser but **not** for the providers: the redirect goes
   through the user's browser, so the address only has to be reachable from
   *their* machine, not from Google. A public DNS name with a private `A` record
   and a certificate obtained by DNS-01 challenge is a supported shape. Caddy
   can do the DNS-01 part with a provider plugin; that is outside what the
   bundled image includes, so it means bringing your own proxy (§12).
3. **A tunnel.** Anything that gives the installation a stable public HTTPS
   hostname — Cloudflare Tunnel, Tailscale Funnel, an SSH reverse tunnel to a
   VPS — is sufficient, because the provider only ever sees the hostname.

Josi does not favour any of these and ships none of them. What it requires is
that `JOSI_APP_URL` is `https://` on a name a browser can resolve.

### Adding it later

Nothing needs reinstalling. Set the domain, restart, and register the
applications from **Settings → Connectors**, which shows the exact callback URL
to paste with a copy button. Contacts, conversations and everything else are
untouched.

On that page, **Member permissions** controls which connector features members
are allowed to enable for their own accounts. Allowing a permission does not
turn it on for anyone or grant access by itself; each member must still connect
their own account and enable the feature.

## 13. Firewall guidance

Bundled Caddy normally needs only:

- TCP 22 from trusted administration addresses, if SSH is used
- TCP 80 from the Internet
- TCP 443 from the Internet

Do not expose PostgreSQL. The Compose file publishes no database port.

Example UFW policy, only after confirming SSH access and adjusting the SSH rule
for the actual environment:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Firewall changes can lock you out. Keep an existing SSH session open and test a
second session before closing the first.

## 14. Normal operations

Show status:

```bash
docker compose ps
```

Follow all logs:

```bash
docker compose logs -f --tail=200
```

Follow one service:

```bash
docker compose logs -f --tail=200 web
```

Restart one service:

```bash
docker compose restart web
```

Stop without deleting containers or volumes:

```bash
docker compose stop
```

Start stopped containers:

```bash
docker compose start
```

Recreate containers from the current configuration:

```bash
docker compose up -d
```

### 14.1 Commands that are intentionally not routine

`docker compose down` removes containers and networks but preserves named
volumes unless `--volumes` is supplied.

**Never run `docker compose down --volumes` as an ordinary troubleshooting
step.** It deletes the PostgreSQL data volume and other named volumes.

Do not delete `secrets/master.key`. Do not regenerate it to fix a startup
problem. A replacement key cannot decrypt existing credentials.

### 14.2 Uninstall

Uninstalling has three levels, and the difference between them is what happens
to your data. They are written out separately because "uninstall" and "delete
everything I ever put into this" are different intentions, and a single command
that does both is how people lose a database.

**Level 1 — stop Josi, keep everything.** Reversible with `docker compose up -d`.

```bash
cd /opt/josi
docker compose down
```

Containers and networks are removed. Named volumes — the database, backups,
recovery copies, the Codex login — are untouched.

**Level 2 — remove Josi's images too.** Still keeps your data.

```bash
docker compose down --rmi all
```

**Level 3 — destroy the installation and all of its data. Irreversible.**

Take a backup first if there is any chance you want the data (§15), and copy the
backup and `secrets/master.key` off this machine before you continue — the
backup is useless without the key.

```bash
cd /opt/josi
docker compose down --volumes --rmi all
cd .. && rm -rf /opt/josi
```

That removes the containers, the networks, the images, every named volume
(`db_data`, `josi_versions`, `josi_backups`, `josi_diagnostics`, `josi_codex`,
`caddy_data`, `caddy_config`) and the installation directory including
`secrets/master.key`.

Confirm nothing is left:

```bash
docker ps -a  --filter 'label=com.docker.compose.project=josi-ce'
docker volume ls --filter 'label=com.docker.compose.project=josi-ce'
```

Both should print only their header row.

Josi installs nothing outside its own Compose project and its own directory. It
adds no systemd unit, no user account, no file under `/etc`, and no cron entry,
so there is nothing else to undo. Any folder you mounted into `/data/roots`
belongs to you and is not touched by any of the above.

## 15. Backup and restore

Backup and restore are implemented and have passed a destructive acceptance
test: on a real host, a credential is sealed through the application, a real
`pg_dump` is taken, **the database schema is dropped**, the archive is restored,
and the credential is proven to decrypt with the master key and to be unusable
without it.

Take a backup from **Settings → Administration → Backups**, or:

```bash
curl -fsS -X POST https://josi.example.com/api/ops/admin/backups \
  -H 'content-type: application/json' \
  -b "$COOKIES" -H "x-josi-csrf: $CSRF" \
  -d '{"kind":"full","masterKeyConfirmed":true}'
```

Two kinds exist:

| Kind | Contains | Use |
|---|---|---|
| `full` | Every table, configuration, uploads, retained recovery copies | Restoring this installation |
| `portable` | Current data and files; **no** recovery copies or version history | Taking your data elsewhere |

Archives are written to the `josi_backups` named volume, at `/data/backups`
inside the container, with mode `0600`. Copy them off the host.

### 15.1 The master key is not in the backup

This is deliberate. A stolen archive is useless to anyone who does not also have
the key — and the cost of that property is that **a backup restored without the
key brings back your data but not your credentials.** Saved provider keys,
connected accounts and mail passwords stay encrypted and unreadable.

Back up `secrets/master.key` separately, and store it somewhere other than your
database backups. A backup and a key kept in the same place protect against disk
failure but not against theft.

A complete backup set is therefore:

- The Josi archive (`full`)
- The exact `secrets/master.key`, held separately
- A note of the Josi release the archive came from

### 15.2 Restoring

Restoring **replaces the current database** and requires an explicit
confirmation:

```bash
curl -fsS -X POST https://josi.example.com/api/ops/admin/restore \
  -H 'content-type: application/json' \
  -b "$COOKIES" -H "x-josi-csrf: $CSRF" \
  -d '{"backupId":"<id>","confirm":"restore"}'
```

The response reports two separate facts, and they are not the same thing:

- `rowsRestored` — your data came back
- `credentialsRecovered` — whether the master key was present to decrypt it

If `credentialsRecovered` is `false`, the restore still succeeded. Put the
original key back and the credentials work again; without it they must be
entered afresh.

Restoring is applied in a single transaction, so a restore that fails leaves the
database as it was rather than half-replaced.

> **Not yet checked:** a restore does not verify that an archive came from *this*
> installation. Restoring another installation's backup will apply it.

## 16. Upgrade and rollback

**Josi never updates itself.** There is no setting that enables automatic
updating — not one defaulting to off, because a setting that exists can be
flipped. Nothing changes until an administrator approves it.

The update sequence is fixed, and each step gates the next:

1. **Back up first.** An update that cannot take a backup does not start.
2. Download and apply.
3. **Health check.** Without it, "the container started" would count as success,
   which is exactly what a broken migration leaves behind.
4. **Roll back on failure**, keeping the recorded version at the old one.

That sequence, including rollback and the refusal to proceed without a backup,
is verified against a real database.

> **Not implemented:** nothing downloads a release. `POST
> /api/ops/admin/update/check` reports the current version and finds nothing,
> because no update channel is configured. **There is no in-product upgrade
> yet.**

Until there is, do not improvise an in-place production upgrade. Pulling new
source and running `docker compose up -d --build` applies database migrations
that are not reversible. Take a `full` backup first, confirm you hold the master
key separately, and be prepared to restore.

## 17. Troubleshooting

### 17.1 Compose cannot read a secret file

Symptoms include `secrets/master.key not found` or `secrets/db_password not
found`.

```bash
./scripts/install.sh --check
ls -ld secrets
ls -l secrets/master.key secrets/db_password
```

Run commands from the repository root. Do not solve permission errors by making
the secrets world-readable.

### 17.2 Database is unhealthy

```bash
docker compose ps db
docker compose logs --tail=300 db
docker inspect --format '{{json .State.Health}}' josi-ce-db-1
```

Container names can vary with the Compose project name. Use `docker compose ps
-q db` when scripting:

```bash
docker inspect --format '{{json .State.Health}}' "$(docker compose ps -q db)"
```

Common causes are disk exhaustion, filesystem permission problems, corrupt
storage, and changing database identifiers after initialization.

### 17.3 Migrator exited nonzero

```bash
docker compose ps -a migrate
docker compose logs --tail=500 migrate
```

Do not repeatedly delete the database volume. Preserve the evidence, identify
the failing migration, and use the release's documented recovery path.

### 17.4 Web is running but `/ready` fails

```bash
docker compose logs --tail=300 web
curl -i http://127.0.0.1/ready
./scripts/install.sh --check
```

Readiness distinguishes database, migrations, and master-key failures. Fix the
reported dependency instead of masking the check.

### 17.5 Login works locally but fails through a proxy

Confirm:

- `JOSI_APP_URL` exactly matches the browser's HTTPS origin.
- `JOSI_APP_URL` starts with `https://`; with the normal empty
  `JOSI_COOKIE_SECURE`, Josi derives the correct cookie setting from it.
- The proxy sends `X-Forwarded-Proto: https`.
- The browser is not being redirected between different hostnames.
- System time is correct.

For plain HTTP evaluation, use an `http://` `JOSI_APP_URL` and leave
`JOSI_COOKIE_SECURE` empty. If an explicit override was previously set, remove
it, recreate the web container, and clear cookies for the host.

### 17.6 Caddy restarts or cannot issue a certificate

```bash
docker compose ps caddy
docker compose logs --tail=500 caddy
dig +short A josi.example.com
dig +short AAAA josi.example.com
```

Check that ports 80 and 443 reach this server, that another service is not
already bound to them, and that DNS does not contain a stale address.

`JOSI_ACME_EMAIL` in `.env` is currently informational. The supplied Caddyfile
does not interpolate it because an empty `email` directive makes Caddy fail to
parse. Certificate issuance works without an ACME contact address.

### 17.7 Port already in use

```bash
sudo ss -lntp | grep -E ':(80|443|8080)[[:space:]]'
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

Stop the conflicting service, choose different host ports, or use the existing
reverse-proxy deployment shape.

### 17.7.1 Gmail rejects the SMTP username or password

For Gmail, use the full Gmail address as the SMTP username and a Google App
Password created after enabling 2-Step Verification. Do not use the normal
Google account password.

Google displays an App Password as four groups of four lowercase letters. Josi
removes spaces automatically, but must receive exactly 16 letters. Enable
**Show password** before selecting **Save and test** and verify `4-4-4-4`.
Google's copy action can occasionally omit the final character; `4-4-4-3`
means the pasted value is incomplete even when it came directly from Google's
page. Append the missing displayed character or generate a new App Password.

Regenerate any App Password that appears in a screenshot, message, support
ticket, or log. Treat it as exposed even if the test failed.

### 17.8 Docker build fails

```bash
docker compose build --pull --no-cache
docker system df
df -h
df -i
```

Capture the first real compiler or package error, not only the final nonzero
exit line. Do not run broad Docker prune commands on a shared host without
reviewing what they will delete.

### 17.9 Host is out of disk space

Inspect before removing anything:

```bash
df -h
docker system df -v
docker volume ls
docker image ls
```

Do not delete a volume merely because its name looks old. Confirm ownership and
take a restorable backup first.

### 17.10 Host architecture mismatch

```bash
uname -m
docker info --format '{{.Architecture}}'
docker image inspect "${JOSI_IMAGE:-josi-ce}:${JOSI_TAG:-local}" --format '{{.Architecture}}'
```

Use a 64-bit `amd64` or `arm64` OS and matching image.

### 17.11 ClamAV remains unhealthy

```bash
docker compose --profile clamav ps clamav
docker compose --profile clamav logs --tail=500 clamav
docker stats --no-stream
```

Allow time for initial signature loading and verify the host has enough memory.
An out-of-memory kill appears in container state and host kernel logs.

### 17.12 The Telegram bot receives messages but Josi never answers

**Admin → Telegram → Delivery health** groups the last seven days by category.
A run of `unauthorized` means the token was revoked in BotFather. A run of
`blocked_by_user` means that person blocked the bot — Josi revokes the link
rather than retrying forever, and they see it as unlinked.

If nothing appears at all, the webhook is not registered or points at an address
that no longer resolves. Register it again. Josi answers 404 to any delivery
without the correct secret header, so a stale registration produces silence
rather than an error.

### 17.13 "That link code cannot be used"

Every reason gives the same sentence on purpose: used, expired, invalidated and
never-existed are indistinguishable to whoever holds the code, because telling
them which one it was confirms the code was real. Create a new one. The real
reason is in the audit log.

### 17.14 The installed app shows an old version

`sw.js` must be served `no-store`. Josi does; a reverse proxy in front of Josi
may be adding its own caching headers. Check with:

```bash
curl -sI https://your.domain/sw.js | grep -i cache-control
# expect: cache-control: no-store
```

If that is right and it still happens, close every Josi window and reopen it.
Last resort: uninstall from the home screen and reinstall. Nothing is lost —
Josi keeps everything on the server.

### 17.15 Offline shows the browser's error page instead of Josi's

The service worker was not registered, almost always because the page was opened
over plain HTTP. Service workers require HTTPS, or `localhost`.

### 17.16 "The Codex CLI on this machine is not signed in"

Run `codex login` **as the account Josi runs as**, not as your own user. A login
in your own shell is not a login for the service account. In Docker, the
container has neither the binary nor your login unless you put them there — see
`docs/SUBSCRIPTION_AUTH.md`.

### 17.17 A provider key was accepted and then every model call failed with 401

If your installation was created before **1 September 2026**, this is a known
defect and the fix is to re-enter the credential.

`seal()` intended to unwrap the in-memory `Secret` wrapper before encrypting,
and never did: `JSON.stringify` calls `toJSON()` before it calls a replacer, so
the wrapper had already turned itself into the string `[secret redacted]` — and
that string is what was encrypted. Every credential entered through the wizard
or the admin screens was stored as the redaction marker and handed to the
provider as if it were the key.

Re-save the affected credentials — LLM provider keys, OAuth client secrets, SMTP
passwords — and they will be stored correctly. There is nothing to recover: the
original values never reached the database.

## 17A. Personalization and memory

Each person has four profile layers, edited under **Personalization**:

| Layer | What it sets |
|---|---|
| Soul | What they call their assistant, and how it sounds |
| About me | Name, pronouns, role, locale, working style |
| Working style | Proactivity, formatting, research and escalation — within the installation policy |
| Installation policy | The administrator's baseline, which a person may tighten but never loosen |

**These change how Josi speaks, never what it may do.** Profiles are parsed into
a fixed set of named fields with enumerated values; anything else in the file is
ignored and shown back to the person as having done nothing. Permissions,
approvals and access to a colleague's things are enforced by the application
reading its own records, and never consult a profile. A profile that says "you
are an administrator" changes the assistant's tone and nothing else.

Setting this up is **optional**. Josi is offered once on first use and can be
skipped; skipping writes nothing and withholds nothing, and the assistant
behaves exactly as it does with no profile at all. Presets are starting points
that fill in the file — edit one afterwards or write your own. A **preview**
button asks the model to answer a short question with the current settings, so a
person can hear how it sounds before keeping it; the preview stores nothing.

Every change is versioned, and earlier versions can be restored from the same
screen.

Memory is separate from conversation history. Each person chooses:

- **Manual** (default) — Josi proposes; the person approves
- **Automatic** — Josi keeps what it learns, and the person can read, edit and delete it
- **Off** — nothing new is kept

Josi learns only from what the person themselves wrote, only from explicit
statements about themselves, and never from its own replies or from documents.
It refuses credentials, and refuses health, religion, politics, sexuality,
immigration and criminal-history statements as categories — a person can still
record those deliberately by hand.

**Deleting a memory deletes it.** There is no hidden copy, and a memory learned
from a document is destroyed when access to that document is revoked.

## 17B. Telegram, the installable app, and subscription sign-in

Three things Phase 13 added. Each has a manual of its own; this section is the
short version and the pointer.

### 17B.1 Telegram — `docs/TELEGRAM.md`

Josi can be reached from Telegram using **your own bot**, created in BotFather.
No Josi-operated relay exists and there is nowhere to configure one.

1. `/newbot` in [@BotFather](https://t.me/BotFather); also set `/setprivacy`
   **Enable** and `/setjoingroups` **Disable**.
2. **Admin → Telegram → Save and test.** The token is proven against `getMe`
   before it is stored; a token that fails is not saved.
3. **Register the webhook.** Needs a public HTTPS address that resolves.
4. **Turn on.**

Each person then links their own account from **Settings → Telegram**. The link
code works once, expires in fifteen minutes, and is shown once.

An administrator can see that a link exists and revoke it. They cannot read
anything sent over it: the admin surface returns no message text and not even
the chat identifier.

Files over Telegram are **off by default**. When enabled, accepted files enter
the same bounded ingestion, scan, extraction and indexing pipeline as other
uploads. Unsupported, encrypted, unsafe and over-limit files are skipped with
an explicit reason.

### 17B.2 The installable app (PWA) — `docs/PWA.md`

Josi installs to a home screen or a dock. On iOS use Safari → Share → **Add to
Home Screen**; on Android and desktop Chrome, Josi offers an install prompt when
the browser does.

**What is stored on the device:** the JavaScript bundle, the icons, and a static
"Josi is offline" page. **Nothing else, ever** — no API response, no
conversation, no name. A service-worker cache outlives signing out, so anything
in it would be readable by whoever picks the device up next. Offline therefore
shows a page that says it is offline and displays nothing.

Updates never apply themselves. A bar appears saying a new version is ready and
the person presses Reload.

> **If you run your own reverse proxy:** it must not add caching headers to
> `/sw.js`. Josi serves it `no-store` because it is not content-hashed — a
> cached service worker is a pinned service worker, and it keeps its caching
> rules indefinitely. The bundled Caddy config is correct; a hand-written nginx
> config often is not.

### 17B.3 Subscription sign-in — `docs/SUBSCRIPTION_AUTH.md`

**ChatGPT plan: supported.** Josi runs OpenAI's own `codex exec` on this machine,
signed in as you. Install the CLI, run `codex login` **as the account Josi runs
as**, then **Admin → Model → Use this for the primary model** and press Test.

It is per installation rather than per person, shares your own Codex usage
limits, reports no token counts or cost, and calls Josi tools only through the
bundled permission-checked MCP harness — so Josi can
talk but cannot book, send or search on that path. Those limits are shown on the
Model screen, not just here.

**Claude subscription: not available, and not "coming soon".** Anthropic's
policy restricts Claude Free/Pro/Max sign-in to Claude Code and Claude.ai and
does not permit those credentials in any other product, including the Agent SDK;
it was enforced on 4 April 2026. Use an Anthropic API key.

Josi never implements "Sign in with ChatGPT", never reads a credential file, a
keychain or a browser profile, and never stores or forwards a token. A test
walks every source file in the repository and fails the build on any reference
to a credential store.

### 17B.4 Editions

This is a **Community Edition** build. The edition is stamped into the image at
build time and is shown on **Admin → Model**.

Subscription sign-in exists only in CE, because OpenAI's terms permit a personal
plan for individual productivity and exclude using one to power a commercial
service. The boundary is not a setting: the environment can only narrow the
capability set, an unrecognised stamp falls to the least capable edition, and
four independent layers refuse — including for a row inserted directly with
`psql`.

```bash
# A build that structurally cannot enable CE-only capabilities:
docker build --build-arg JOSI_EDITION=hosted -t josi:hosted .
```

## 18. Security checklist

Before considering an installation reachable by other people, confirm:

- [ ] The checkout is an intended release, not an arbitrary dirty branch.
- [ ] `scripts/scan-secrets.sh` passes.
- [ ] `scripts/install.sh --check` passes.
- [ ] The master key has an encrypted off-host copy.
- [ ] `.env` contains the correct public origin.
- [ ] HTTPS works with a valid certificate.
- [ ] Secure cookies remain enabled for HTTPS.
- [ ] PostgreSQL is not published to the host or Internet.
- [ ] Host security updates are enabled and current.
- [ ] SSH uses strong authentication and limited network exposure.
- [ ] Optional OCR and ClamAV services are enabled only when supported and
      resourced.
- [ ] Provider, OAuth, and SMTP credentials belong to the operator.
- [ ] External LLM processing is disclosed to users.
- [ ] Telemetry was explicitly chosen rather than assumed.
- [ ] `/health` and `/ready` are monitored.
- [ ] A `full` backup has been taken, copied off the host, and the master key
      stored separately from it.
- [ ] You have read section 15.1 and accept that a restore without the key
      returns your data but not your credentials.
- [ ] The threat model (`docs/THREAT_MODEL.md`) has no entry without a control
      and a test. This is checked by the build — `apps/api/test/threatModel.test.ts`
      parses the document and fails the suite on a missing link — so the box is
      ticked by running the suite, not by reading.
- [ ] `npm run typecheck && npm test` pass on the checkout being deployed.
- [ ] If Telegram is enabled: the bot's `/setprivacy` is **Enable** and
      `/setjoingroups` is **Disable** in BotFather, and the webhook is
      registered to the current public address. See `docs/TELEGRAM.md`.
- [ ] If the PWA matters to you: `/sw.js` is served `no-store` through your
      proxy, not just by Josi. A proxy that adds its own caching headers pins
      the service worker and its caching rules. See `docs/PWA.md`.
- [ ] The edition reported on **Admin → Model** is the one you meant to build.
      A hosted or white-label build must NOT report `ce`. See
      `docs/SUBSCRIPTION_AUTH.md`.
- [ ] `bash scripts/acceptance/clean-install.sh --profile <yours>` has been run
      on hardware of the class you are deploying to, and its measurements
      recorded in `docs/ACCEPTANCE.md`.

## 19. Collecting useful support information

Josi builds a redacted diagnostics bundle for you. Create one from **Settings →
Support**, or `POST /api/ops/diagnostics`. You are shown the whole bundle before
anything leaves, and it cannot be submitted until you have opened it, approved
it, and it has passed a final secret scan.

A bundle carries the Josi version, a resource summary, which settings are
configured — never their values — and counts of users, conversations and
documents. It **never** carries messages, emails, documents, prompts, database
rows, or credentials. That is structural rather than filtered: the builder can
only produce a fixed list of sections, so a table added later cannot leak
through a redactor nobody updated. Verified on a real installation by seeding a
conversation and confirming its text is absent.

> **Not yet collected:** container health and log lines. The bundle builder
> handles both, with redaction and trimming, but the application has no Docker
> socket by design, so those sections are currently empty.

If you share logs yourself instead, redact them first. Never send:

- `secrets/master.key`
- `secrets/db_password`
- Provider API keys
- OAuth client secrets or access/refresh tokens
- SMTP passwords
- Message, document, contact, calendar, or prompt content

Safe first-line metadata usually includes the Josi commit or release, host OS,
CPU architecture, Docker versions, Compose service state, the failing endpoint,
and the exact error after secrets and user content are removed.

```bash
git rev-parse HEAD
uname -a
docker version
docker compose version
docker compose ps -a
```

### 19.1 Reset an account password without email

From the Josi installation directory, run:

```bash
./reset-password.sh USERNAME_OR_EMAIL
```

The command prompts twice using hidden terminal input, requires at least 12
characters, replaces the password only when exactly one active account matches,
and invalidates that account's existing sessions and unused reset links. It
prints neither the password nor its hash. Exit codes `64`–`69` distinguish bad
usage, invalid input, a missing installation, no matching account, unavailable
services, and other recovery failures.

### 19.2 Optional developer workspace

The browser installer can bind one host folder into Josi at `/workspace` for
coding-agent workflows. It is skipped by default. Choose read-only access for
inspection, or read/write access when Josi must create code, run tools, and use
Git. The installer tests the requested capability through Docker before saving
the configuration and rejects system, credential, secret, and Josi installation
paths. Normal Josi containers receive only this bind mount; they never receive
the Docker socket.

## 20. Uninstallation

There is no supported uninstall-and-preserve-data wizard yet.

Stopping the installation is reversible:

```bash
docker compose stop
```

Removing containers and networks while retaining named volumes:

```bash
docker compose down
```

Deleting named volumes or the installation directory destroys data. Before any
permanent removal, take a `full` backup, copy it off the host, verify it by
restoring it somewhere else, and separately preserve the master key — a backup
you have never restored is not a backup you know you have. This manual
deliberately does not provide a one-line destructive wipe command.

### Network maintenance verification and recovery

The protected Network & address page requires the current administrator
password. Its labelled, masked field uses `current-password` autocomplete;
failed reauthentication never launches a controller.

The supervisor remains isolated with `--network none`. It uses Docker to discover
the workstation's private LAN interface, binds the temporary controller to that
interface on port 8080, and probes HTTPS health inside the controller namespace
before returning a URL. It does not advertise the application's public domain,
a container bridge address, or the supervisor's loopback address. Reach it from
the LAN. The temporary self-signed certificate requires the browser's local
certificate exception; this does not alter the application's public TLS setup.
The one-time pairing code is consumed on use, sessions expire after 15 minutes,
and the controller exits after completion or expiry. Docker removes it on exit.

If it fails to open, check that the appliance has a private LAN route, port 8080
is free, and the supervisor's UID and supplemental Docker group can access the
socket. A public reverse proxy or tunnel does not provide access to this separate
LAN controller. Keep a LAN recovery path available when changing public DNS.

Maintenance preserves the installed image tag and does not pull or upgrade
images. It snapshots the environment, workspace/proxy overrides, and canonical
address metadata. It recreates the selected Compose topology, verifies the
browser-facing health endpoint, then records successful verification. Failed
application restores the old files and runtime, then the exact previous address,
OAuth callback, webhook, and verification metadata. Runtime recovery failures
are reported explicitly; they are never presented as successful rollback.
OAuth providers may also require their external application redirect allowlists
to be updated by the operator. An already-registered Telegram webhook is moved only after new-origin health
passes; failure restores the prior registration and local verification metadata.
Disconnect Telegram's registered webhook before switching to LAN HTTP, which
cannot receive Telegram delivery. An unregistered webhook remains unregistered.

## Persistent chat attachments

See [Chat attachments](CHAT_ATTACHMENTS.md) for supported formats, storage limits,
privacy, retention, installation/upgrade volume provisioning and troubleshooting.
