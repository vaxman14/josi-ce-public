# Portainer, Unraid, and TrueNAS SCALE

Josi CE is a multi-container Compose application. The supported appliance path
uses the same reviewed `docker-compose.release.yml`; it does not flatten the
stack into an unsafe single container.

## Prepare the stack once

On the appliance host, create a persistent directory and run the installer in
prepare-only mode. It writes files and generates secrets but starts nothing:

```bash
mkdir -p /opt/josi-ce && cd /opt/josi-ce
docker run --rm \
  -e JOSI_PREPARE_ONLY=1 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD:$PWD" -w "$PWD" \
  romanvaxman/josi-ce-installer:latest
```

Back up `/opt/josi-ce/secrets/master.key` outside the appliance. In `.env`, set
all three file paths explicitly when the UI stores the stack elsewhere:

```dotenv
JOSI_MASTER_KEY_FILE=/opt/josi-ce/secrets/master.key
JOSI_DB_PASSWORD_FILE=/opt/josi-ce/secrets/db_password
JOSI_CADDYFILE=/opt/josi-ce/Caddyfile
```

## Portainer

1. Open **Stacks → Add stack** and name it `josi-ce`.
2. Upload `/opt/josi-ce/docker-compose.yml` or paste its contents.
3. Add the values from `/opt/josi-ce/.env` as stack environment variables.
4. Ensure all three absolute file paths above are present.
5. Deploy the stack and confirm `db`, `web`, `worker`, and `caddy` are healthy;
   `migrate` should exit successfully.

Portainer's Git deployment is intentionally not the primary path while the
repository is private. The published installer requires no repository access.

## Unraid

Use the **Docker Compose Manager** plugin because Josi needs networks, secrets,
health dependencies, and multiple services. A Community Applications XML for a
single container would misrepresent the architecture and is not provided.

1. Prepare `/mnt/user/appdata/josi-ce` using the command above, replacing
   `/opt/josi-ce` with that path.
2. Add that directory as a Compose Manager stack.
3. Set the secret paths to `/mnt/user/appdata/josi-ce/secrets/...` and the
   Caddyfile path to `/mnt/user/appdata/josi-ce/Caddyfile`.
4. Compose up, then verify the health endpoint.

Do not use `docker compose down -v`; it deletes the database and durable data.

## TrueNAS SCALE

This path targets SCALE releases with Docker-based **Custom Apps** and a YAML
editor. Older Kubernetes-based releases are not supported by this guide.

1. Create a persistent dataset mounted at `/mnt/<pool>/apps/josi-ce`.
2. Prepare that directory with the installer command above.
3. In **Apps → Discover Apps → Custom App**, choose the Docker Compose/YAML
   option and paste `docker-compose.yml`.
4. Set all three file variables to absolute paths inside the dataset.
5. Save and verify all required services plus `/health`.

TrueNAS permissions must allow Docker to read the two secret files while they
remain inaccessible to other users. Do not move the master key into an
environment variable or paste it into the UI.

## What is verified

The Compose stack and one-shot installer are live-tested on clean Docker. The
platform-specific UI clicks above are distribution instructions, not claims of
hardware certification. Platform certification requires a recorded clean
install on each named product and remains pending until those runs exist.
