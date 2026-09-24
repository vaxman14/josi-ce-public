# Josi CE 0.1 — Community Preview

**Your assistant, on your own server.**

A self-hosted AI executive assistant. One workspace, your people, your server,
your credentials.

Created and published by **SOCAL RECEPTIONIST LLC**.

> ### Community Preview
>
> 0.1 is usable but early. It is published so that real usage can show which
> workflows matter. It is not a mature production product, and it carries **no
> support entitlement, no guaranteed response and no SLA**.

---

## Status

**Josi CE 0.1 is a Community Preview.** Setup, isolation, the assistant, the web
app, connectors, mail, documents and storage, and backup and restore are
implemented. Published amd64 and arm64 images have passed clean-install and
live multi-user isolation tests. Each phase carries evidence recording what is
proven and what is not.

| Document | What it is |
|---|---|
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | Phases, acceptance criteria and risks |
| [`docs/DECISION_TRACEABILITY.md`](docs/DECISION_TRACEABILITY.md) | Every product decision, linked to its implementation or marked deferred |
| [`docs/TELEGRAM.md`](docs/TELEGRAM.md) | Reaching Josi from Telegram with your own bot |
| [`docs/PWA.md`](docs/PWA.md) | Installing Josi on a phone or desktop, and exactly what is cached |
| [`docs/SUBSCRIPTION_AUTH.md`](docs/SUBSCRIPTION_AUTH.md) | Using a ChatGPT plan instead of an API key, why Claude cannot be used, and the edition boundary |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) | Clean-install acceptance: what has actually been run, on what hardware |
| [`docs/DEVELOPER_SERVICE_CONNECTIONS.md`](docs/DEVELOPER_SERVICE_CONNECTIONS.md) | Connecting your own GitHub, Netlify, Vercel or Supabase account |
| [`docs/CUSTOM_API_CONNECTIONS.md`](docs/CUSTOM_API_CONNECTIONS.md) | Letting Josi call an external API, one reviewed action at a time |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | Every threat with its control and the test that would fail without it |
| [`docs/HELP.md`](docs/HELP.md) | Current feature help and links to each operator/user guide |
| [`docs/LEGAL.md`](docs/LEGAL.md) | Terms, privacy, cookies, licences, support and security policies |

Phase progress is tracked in the implementation plan. Nothing here is presented
as working before it is.

## What Josi CE is

- **One workspace per installation**, with as many users as your hardware can
  carry. No seat cap.
- **Your credentials.** You bring your own LLM provider, your own Google and
  Microsoft OAuth applications, your own SMTP. Nothing belonging to SOCAL
  RECEPTIONIST LLC ships in this repository.
- **Private by default.** A user's connected accounts, mapped folders and
  operational email threads are theirs. Workspace membership does not grant
  access to a colleague's content, and neither does being the super admin.
- **Policy, not surveillance.** The super admin decides what capabilities exist
  and can switch them off. That is a different thing from being able to read
  people's mail, and Josi CE treats it as a different thing.

## What Josi CE is not

- One workspace per installation. Multi-tenant hosting is not supported by the
  current architecture; the AGPL does not prohibit operating the software as a
  network service.
- Not a white-label product. You may fork it and put your own identity on it —
  the AGPL grants that and the trademark policy expects it. What is not on offer
  is *us* standing behind a rebranded build; that is a commercial arrangement.
  See `TRADEMARK.md`.
- Not an enterprise product. The initial market is SMB.
- No voice or SMS receptionist in 0.1.
- No audio/video transcription or media indexing in 0.1.
- No plugin sideloading or marketplace in 0.1.
- Native companion apps are **Coming soon** — there is no download to offer
  yet. Josi does install to a home screen as a Progressive Web App, and can be
  reached from Telegram; see below.

## Getting to Josi from a phone

Two ways, both shipped:

- **Install it.** Josi is a Progressive Web App. Safari → Share → Add to Home
  Screen on iOS; an install prompt on Android and desktop Chrome. It stores the
  app bundle on the device and **no data at all** — offline shows a page that
  says it is offline, because a service-worker cache outlives signing out.
  See [`docs/PWA.md`](docs/PWA.md).
- **Message it on Telegram.** Using **your own bot**, created in BotFather.
  There is no Josi-operated relay and nowhere to configure one. Each person
  links their own account with a single-use code; an administrator can revoke a
  link and cannot read a word of it. See [`docs/TELEGRAM.md`](docs/TELEGRAM.md).

## Requirements

- Docker and Docker Compose
- PostgreSQL (bundled in the compose file)
- A domain name, if you want the bundled automatic HTTPS
- An LLM provider: OpenAI, Anthropic, xAI, or any OpenAI-compatible endpoint
  such as Ollama, vLLM, LM Studio or LocalAI.

  Alternatively, on a Community Edition installation, **your own ChatGPT plan**
  through OpenAI's own Codex CLI running on the same machine. Josi never sees,
  stores or forwards your login. It is per installation rather than per person,
  shares your own Codex usage limits, reports no cost, and can use Josi's
  permission-checked tools through the bundled private MCP harness. The same
  first-party-CLI mechanism is implemented for Claude Code, but its public
  release representation remains gated on the counsel review recorded in
  FI-006. Both positions, with sources, are in
  [`docs/SUBSCRIPTION_AUTH.md`](docs/SUBSCRIPTION_AUTH.md).

`linux/amd64` and `linux/arm64` images are published. Low-power ARM64 devices are
supported within realistic limits.

> **No capacity numbers are published yet.** Concurrency and performance depend
> on your hardware, database, connector load and whether inference is local or
> remote. Real figures will be published only after representative hardware has
> actually been benchmarked — not estimated.

## Installation

For the shortest verified path, see [`docs/QUICK_START.md`](docs/QUICK_START.md).

### Browser installer (recommended for Community Preview)

Create an empty directory, enter it, and run the installer container. The same
absolute directory is mounted into the container because Docker Compose passes
the secret-file paths to the host daemon. The installer uses the Docker socket
only while its local HTTPS wizard writes the reviewed release files, generates
the two local secrets, validates the chosen address and ports, and starts the
normal isolated services. It then exits; no privileged controller remains.

```bash
mkdir josi-ce && cd josi-ce
# Linux:
docker run --rm \
  -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD:$PWD" -w "$PWD" \
  romanvaxman/josi-ce-installer:latest
```

On macOS with Docker Desktop, use its user socket instead:

```bash
docker run --rm \
  -p 8080:8080 \
  -v "$HOME/.docker/run/docker.sock:/var/run/docker.sock" \
  -v "$PWD:$PWD" -w "$PWD" \
  romanvaxman/josi-ce-installer:latest
```

Open the HTTPS LAN address printed by the container, accept its temporary local
certificate, and enter the one-time setup code. Address, domain, proxy, and
port choices are completed in the browser and persisted to `.env`. The final
**Open Josi** handoff binds first-admin creation to that paired browser; only a
hash is stored and the raw token is removed from the address immediately.

The socket mount is root-equivalent access to the Docker host. It is acceptable
for this one-shot installer only because the published image is inspectable,
version-pinned, and exits after Compose starts. Do not run it as a permanent
service and do not give the socket to the Josi application containers.

### Josi CLI

The standalone Linux CLI is distributed as versioned `amd64` and `arm64`
archives with SHA-256 checksums and a detached Sigstore signature. The installer
requires an explicit version and verifies both the release signer and archive
before writing anything. Prefer downloading and inspecting the installer before
running it; see [`docs/CLI.md`](docs/CLI.md) for interactive, noninteractive,
and manual verification instructions.

### Manual installation

The complete operator guide is in
[`docs/INSTALLATION.md`](docs/INSTALLATION.md). It covers prerequisites, DNS,
every supplied environment setting, secret generation, bundled Caddy, an
existing reverse proxy, optional OCR and ClamAV profiles, verification,
operations, security, and troubleshooting. Where a workflow is not implemented
it says so explicitly rather than inventing commands for features that do not
exist yet.

For a local evaluation after reading the guide:

```bash
cp .env.example .env
./scripts/install.sh
docker compose up -d
```

## Backups and the master key

The Backups page includes a persistent **Back up now** progress display, guided SMB/NFS setup,
off-site encryption, and non-destructive destination editing. See [the backup guide](docs/BACKUPS.md).

Runtime credentials — LLM keys, OAuth secrets, SMTP passwords — are encrypted in
PostgreSQL using an installation master key that is stored **outside the
database**, as a Docker secret.

**A database backup alone cannot restore your credentials.** Back up the master
key separately and keep it somewhere you would still have it if the server were
gone.

This is deliberate, and it has been measured rather than assumed. Josi's backup
tooling never puts the key in an archive, so a stolen backup is useless — and
the acceptance test drops the database, restores it, and proves the credentials
decrypt with the key and are unusable without it. The cost of that property is
the warning above: restore your data without the key and your saved provider
keys, connected accounts and mail passwords do not come back.

See [`docs/PHASE_10_EVIDENCE.md`](docs/PHASE_10_EVIDENCE.md) for what was
proven and what was not.

## Running it

Full detail is in [`docs/INSTALLATION.md`](docs/INSTALLATION.md). These are the
four things an operator actually does.

### Fresh install

```bash
git clone https://github.com/vaxman14/josi-ce-public.git && cd josi-ce-public
cp .env.example .env          # set JOSI_DOMAIN and JOSI_APP_URL
./scripts/install.sh          # generates the master key and database password
docker compose up -d
```

Then open the domain and complete the setup wizard. The first person through it
becomes the super admin, and setup cannot be run twice.

### Back up

```bash
# Settings → Administration → Backups, or:
POST /api/ops/admin/backups   {"kind":"full","masterKeyConfirmed":true}
```

**Copy the archive off the host, and back up `secrets/master.key` separately.**
The key is never inside a backup — that is what makes a stolen archive useless,
and it is also why an archive restored without the key returns your data but not
your credentials.

### Restore

```bash
POST /api/ops/admin/restore   {"backupId":"<id>","confirm":"restore"}
```

The reply reports `rowsRestored` and `credentialsRecovered` separately, because
they are different facts. If the second is `false`, put the original key back
and the credentials work again.

### Upgrade and roll back

**Josi never updates itself.** There is no setting that enables automatic
updating. When an update is applied it backs up first and refuses to proceed if
that fails, health-checks afterwards, and rolls back on failure keeping the
recorded version at the old one.

> **Not implemented yet:** nothing downloads a release, so there is no
> in-product upgrade. Until there is, take a `full` backup, confirm you hold the
> master key separately, then pull and rebuild — and be prepared to restore,
> because migrations are not reversible.

## Privacy

- Telemetry is **off** unless you affirmatively switch it on during setup. It
  never includes prompts, message contents, contacts, calendars, credentials or
  identifiable business data.
- Enabling an external LLM provider means the data needed for a request leaves
  your server and is processed under that provider's terms. Self-hosting the
  application does not by itself keep everything local.
- **Local-only mode** blocks external LLM providers entirely and shows a
  persistent badge while active.
- Full data categories, recipients, Family BETA handling, retention and user
  choices are in the [`Privacy Notice`](docs/PRIVACY_NOTICE.md). Strictly
  necessary cookies and PWA caching are in the [`Cookie Notice`](docs/COOKIE_NOTICE.md).

## Terms and Family BETA

Use of the official application and paid modules is governed by the
[`Terms of Use`](docs/TERMS_OF_USE.md). **Family and Parental Controls are BETA
and must not be relied on for a child's safety.** They control only Josi, not a
device, other apps, websites, location, emergencies or actual screen time.

## Support

Josi CE includes no support entitlement, guaranteed response, or SLA. Read the
[`Community Preview support policy`](SUPPORT.md) before opening a report.

## Licence

Code: **GNU AGPL v3** — see [`LICENSE`](LICENSE).

Branding: the Josi name, the mark (the white `J` on navy), the wordmark and the
product identity are **not** covered by the AGPL and remain the property of
SOCAL RECEPTIONIST LLC.

This does not restrict what the AGPL grants. You may modify Josi CE and you may
remove its branding — for a fork, removing it is the right thing to do. What the
trademark asks is only that a modified version not present itself as the
official Josi product. Unmodified redistribution may keep the branding, because
it is accurate. See [`TRADEMARK.md`](TRADEMARK.md).

## Appliance platforms and launch material

- [`Portainer, Unraid, and TrueNAS SCALE`](docs/APPLIANCE_PLATFORMS.md)
- [`Product Hunt launch kit`](docs/PRODUCT_HUNT.md)

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.
