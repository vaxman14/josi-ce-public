# Josi CE quick start

This installs the Community Preview from published images. It does not clone
the repository or build anything locally.

## Before you start

- A 64-bit Linux host (`amd64` or `arm64`)
- Docker Engine and Docker Compose v2
- At least 5 GB free disk and 2 GB RAM
- Optional: a DNS name pointing at the host, with ports 80 and 443 open

## Install

Create a dedicated directory and run the temporary browser installer:

```bash
mkdir -p ~/josi-ce && cd ~/josi-ce
docker run --rm \
  -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD:$PWD" -w "$PWD" \
  romanvaxman/josi-ce-installer:latest
```

Open the HTTPS LAN URL printed by the installer, accept the temporary local
certificate, and enter its one-time setup code. The browser wizard detects the
host address, checks ports, and asks whether Josi uses LAN access, automatic
HTTPS, or an existing reverse proxy. It writes the selected values, starts the
stack, verifies it, and exits without leaving a Docker-socket controller.

For Docker Desktop on macOS, replace the socket source with
`$HOME/.docker/run/docker.sock`. macOS is suitable for evaluation, not a
supported production server.

## Open Josi

When deployment passes, select **Open Josi** in the installer. The URL is the
LAN or public address you reviewed in the browser and is stored in `.env`.

The application wizard creates the super admin and initializes the Master Vault
with its one-time offline recovery key. The installer never asks for or stores
the administrator password. **Open Josi** also carries a one-time fragment-only
handoff so another device on the LAN cannot claim the first administrator.

## Useful commands

```bash
docker compose ps
docker compose logs -f web
docker compose restart web
docker compose down
```

`docker compose down` keeps data. `docker compose down -v` destroys it.

For DNS, reverse proxies, LAN-only use, optional OCR/ClamAV, backups, restores,
and troubleshooting, read [INSTALLATION.md](INSTALLATION.md).
The browser installer may optionally expose one host project folder inside Josi
as `/workspace`. Skip it unless you want the coding connectors to work on local
files. Read-only and read/write access are explicit, validated choices.

If SMTP is unavailable, an operator can replace an account password from the
installation directory with `./reset-password.sh USERNAME_OR_EMAIL`; input is
masked and existing sessions and reset links are invalidated.
