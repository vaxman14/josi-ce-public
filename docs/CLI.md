# Josi CLI installation

The Josi CLI is a shell executable published for Linux `amd64` and `arm64`.
Every release contains architecture-labelled archives, a SHA-256 manifest, and
a detached Sigstore signature plus signing certificate. The payload is identical
on both architectures, but separate archive names make platform selection and
release auditing explicit.

## Recommended: download, inspect, then run

Pin one exact release. Do not substitute `latest`:

```bash
VERSION=0.1.65
curl -fSLo josi-install.sh "https://github.com/vaxman14/josi-ce-public/releases/download/v${VERSION}/install.sh"
curl -fSLo josi-install.sh.sha256 "https://github.com/vaxman14/josi-ce-public/releases/download/v${VERSION}/install.sh.sha256"
printf '%s  %s\n' "$(cat josi-install.sh.sha256)" josi-install.sh | sha256sum -c -
less josi-install.sh
sh josi-install.sh --version "$VERSION"
rm josi-install.sh josi-install.sh.sha256
```

The prompt shows the version and destination before writing. The default is
`/usr/local/bin` for root or `$HOME/.local/bin` for an unprivileged account.
Choose another absolute destination with `--install-dir`:

```bash
sh josi-install.sh --version "$VERSION" --install-dir "$HOME/bin"
```

The installer supports Linux only. It selects `amd64` or `arm64`, downloads the
matching versioned archive, and then:

1. authenticates a pinned Cosign verifier by its embedded SHA-256 digest;
2. verifies the checksum manifest's detached signature, certificate, GitHub
   Actions OIDC issuer, and exact tagged-release workflow identity;
3. compares the archive with the SHA-256 digest in that signed manifest;
4. rejects an archive containing anything except one regular `josi` file and
   verifies that its embedded version equals the requested release; and
5. verifies the staged executable's digest, then installs it with one atomic rename.

A missing signature or certificate, an unknown signer, a digest mismatch, an
unsupported platform, or an unavailable verification service fails closed.
There is no flag to bypass verification and no unpinned `latest` mode.

## Noninteractive install

Automation must still pin the version and explicitly opt out of the prompt:

```bash
sh josi-install.sh \
  --version 0.1.65 \
  --install-dir /usr/local/bin \
  --non-interactive
```

`--yes` is an equivalent shorter flag. The installer never invokes `sudo`; run
it with an account that can write to the selected directory.

## Optional pipe shorthand

Downloading and inspecting the installer is preferred. If the release's
installer has already been reviewed, this shorthand preserves the same explicit
version pin and verification:

```bash
VERSION=0.1.65
curl -fsSL "https://github.com/vaxman14/josi-ce-public/releases/download/v${VERSION}/install.sh" \
  | sh -s -- --version "$VERSION" --yes
```

The release URL is pinned by version, and the installer cannot install an
unpinned payload: `--version` must match the release assets it verifies.
Downloading, hashing, and inspecting the bootstrap first remains preferred.

## Verify or install manually

Operators who do not want to run the installer can download these four files
from `https://github.com/vaxman14/josi-ce-public/releases/download/v<version>/`:

- `josi-cli-<version>-linux-<arch>.tar.gz`
- `josi-cli-<version>-checksums.txt`
- `josi-cli-<version>-checksums.txt.sig`
- `josi-cli-<version>-checksums.txt.pem`

Use Cosign to verify the manifest against the exact release workflow identity,
then compare the archive's SHA-256 digest before extracting it. The installer is
the canonical, auditable implementation of those steps.

After installation:

```bash
josi --help
```

## Operating an installation

Run the CLI from an installation directory, pass `--root /absolute/path`, or set
`JOSI_HOME`. It remains a thin orchestration layer: Docker Compose is the only
runtime, and experts can continue to use raw `docker compose` commands. A
generated `docker-compose.workspace.yml` is included automatically in every
lifecycle command so updates cannot drop existing workspace binds. Other custom
overrides must be named explicitly, in order, with colon-separated absolute or
installation-relative paths in `JOSI_COMPOSE_FILES`.

- `josi install [--yes]` runs the existing read-only preflight and existing
  secret generator, pulls the pinned images, starts Compose, and waits for real
  `/ready` checks. It never installs Docker, Compose, or host packages.
- `josi status [--json]` reports container state plus direct and public
  readiness.
- `josi logs --since 30m [--service NAME]` emits bounded, timestamped, redacted
  Compose logs.
- `josi backup` writes a compressed database backup, SHA-256 sidecar, and
  verification receipt. The master key is deliberately separate.
- `josi update VERSION [--yes]` requires a newly verified backup and readable
  migration fingerprint, then verifies readiness and exact running image pins.
  It automatically rolls application images back only when the migration
  ledger did not change. If migrations changed, restoring the pre-update
  database backup and matching master key is required for a downgrade.
- `josi rollback [VERSION]` rolls application images back and verifies the pin,
  readiness, and the target release's recorded pre-update migration fingerprint.
  If the current ledger differs, rollback is refused until the verified database
  backup and matching master key are restored. It never claims to reverse migrations.
- `josi uninstall [--yes]` removes containers but keeps volumes, data, backups,
  config, workspace binds, and tunnel/domain settings. Data deletion requires
  the separate `--purge-data --confirm DELETE-JOSI-DATA` phrase.
- `josi support bundle [PATH]` and `josi doctor --export-ai-context PATH` use
  the same versioned, bounded, secret-redacted collector. The collector records
  per-file command/timestamp/truncation/hash provenance and queue/push summaries;
  it never directly queries message bodies or files, and therefore rejects
  `--include-content`. Application logs can still contain user-supplied paths,
  names, URLs, or text; inspect a bundle before sharing it.

`josi doctor` is transactional. It classifies all checks, captures configuration
and running/stopped service state before a repair, applies only safe reversible repairs by
default, reruns checks, emits JSON/human receipts, and restores its snapshot if
direct or public readiness regresses. `--check-only` never writes; `--dry-run`
prints the exact deterministic plan. Risky or non-deterministic issues remain
precise operator blockers rather than being guessed at. A failed migration is
rerun only with `--repair-migrations --yes`, after a fresh verified backup and
with a bounded wait.

AI repair is disabled by default and runs only after deterministic repair is
exhausted. `--ai-repair` still requires separate `--allow-ai`; `--yes` does not
grant it. Only a configured host-local Codex CLI or Ollama model is accepted
(the synthetic adapter exists only in the test harness). The provider receives the shared redacted evidence bundle first,
can plan only from read-only evidence, and cannot execute until the plan is
shown with its SHA-256 and separately approved with
`--approve-ai-plan <exact-sha256>`. The approval run loads that exact saved
plan instead of asking the model to regenerate it. Execution is restricted
to dependency-free start/restart operations for web, worker, and Caddy, recorded, followed by all failed
postconditions, and covered by the same snapshot/rollback boundary. Operators
must use loopback Ollama or a read-only sandboxed local Codex CLI; non-loopback
Ollama endpoints are refused.

To remove only the standalone client, remove the single `josi` executable from
the directory chosen at installation.

## Existing-solutions preflight

Objective 2 deliberately reuses project machinery rather than adopting a generic
installer/updater that cannot preserve Josi's invariants:

- `scripts/preflight.sh` remains the authoritative read-only host check.
- `scripts/install.sh` remains the secret generator and never replaces the
  master key.
- `scripts/aio-install.sh` remains the browser-first release installer; it now
  places the same CLI beside the installed Compose files.
- `packages/ops/src/update.ts` supplied the backup-first, health-check, audit,
  and rollback state-machine invariants mirrored at the host boundary.
- release Compose remains version-pinned, multi-architecture, and the only
  runtime.

Maintained patterns reviewed were POSIX/Bash thin launchers, conventional
architecture-labelled archives, SHA-256 manifests, and Sigstore/Cosign keyless
GitHub Actions signing. A generic framework such as Commander would add a host
Node.js prerequisite, while generic self-updaters cannot preserve the separate
master-key, Compose-volume, tunnel, migration, and readiness rules. The CLI is
therefore self-contained shell with injected synthetic adapters for tests.

## Maintainer release process

A tagged release runs `scripts/build-cli-release.sh` after the application image
release succeeds. The script packages `scripts/josi` into both Linux archive
names and creates the checksum manifest. In GitHub Actions, `--sign` uses the
workflow's short-lived OIDC identity; it does not accept or load a private key.
The workflow publishes the archives, manifest, detached signature, certificate,
and reviewed installer as assets on the matching public GitHub release. The
versioned installer downloads signed files directly from that public release;
it never directs customers to private repository URLs.

A local unsigned packaging check is available without release credentials:

```bash
bash scripts/build-cli-release.sh --version 0.1.65 --output-dir ./dist/cli
```

Unsigned local output is not publishable. The installer requires the tagged
workflow signature and will reject it.
