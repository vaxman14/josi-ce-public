# Josi CE application image. One image, two commands: the API and the worker.
#
# Built for linux/amd64 and linux/arm64 from this same file — CE targets old
# 64-bit hardware and low-power ARM devices, so the image must stay lean and
# must not depend on anything architecture-specific.

# ---------------------------------------------------------------- build stage
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Dependency install is its own layer so a source change does not re-resolve the
# tree. --ignore-scripts is deliberate: no dependency gets to run code at
# install time. @node-rs/argon2 ships prebuilt native binaries per platform, so
# it needs no build step on either architecture.
COPY package.json package-lock.json ./
# EVERY workspace must be listed here. npm creates the node_modules symlink for
# a workspace only if its package.json exists at install time, so a missing line
# here becomes "cannot find module @josi-ce/x" during the build — which is
# exactly how Phase 4 broke the image while `tsc -b` passed locally against an
# already-linked tree.
COPY packages/core/package.json packages/core/
COPY packages/auth/package.json packages/auth/
COPY packages/llm/package.json packages/llm/
COPY packages/agent/package.json packages/agent/
COPY packages/connectors/package.json packages/connectors/
COPY packages/mail/package.json packages/mail/
COPY packages/storage/package.json packages/storage/
COPY packages/ops/package.json packages/ops/
COPY packages/persona/package.json packages/persona/
COPY packages/channels/package.json packages/channels/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY docs-site ./docs-site

# The edition capability boundary, stamped BEFORE the compile so it becomes a
# constant in the bundle rather than something read from the environment at
# start. See packages/core/src/edition.ts for why that distinction is the whole
# control. Defaults to `ce`; a hosted or white-label build passes
# --build-arg JOSI_EDITION=hosted and gets an artefact that structurally cannot
# enable CE-only capabilities.
ARG JOSI_EDITION=ce
ARG JOSI_BUILD_ID=source
ARG JOSI_RELEASE_KEY=none
# The publisher's paid-feature licence verifier. This is a PUBLIC Ed25519 key,
# never the signing key. Official SOCAL RECEPTIONIST LLC releases pass it at
# build time; source builds default to `none` and therefore fail closed.
ARG JOSI_LICENCE_KEY=none
RUN node scripts/stamp-edition.mjs \
      --edition "$JOSI_EDITION" \
      --build-id "$JOSI_BUILD_ID" \
      --release-key "$JOSI_RELEASE_KEY" \
      --licence-key "$JOSI_LICENCE_KEY"

RUN npx tsc -b

# The web bundle. Built here rather than committed, so what ships is always
# built from the source in this image — and the API serves it from its own
# origin, which is why the app needs no cross-origin cookie story at all.
RUN npm run build --workspace @josi-ce/web

# Drop dev dependencies from what gets copied forward. Done here rather than in
# the runtime stage so the runtime image never contains a package manager cache.
RUN npm prune --omit=dev --ignore-scripts

# -------------------------------------------------------------- runtime stage
FROM node:22-bookworm-slim AS runtime

# tini reaps zombies and forwards signals, so `docker stop` is a clean shutdown
# rather than a ten-second wait for SIGKILL. curl is here for the container
# healthcheck. postgresql-client is here for backup and restore — without it the
# backup feature could only return "not available", which is a worse answer than
# a slightly larger image.
#
# The MAJOR VERSION has to match the server. Debian bookworm ships client 15 and
# the database is postgres:16, and pg_dump refuses to dump a server newer than
# itself — so every backup failed with a generic error until this was pinned.
# The packaging test asserts the two stay in step.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl ca-certificates gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && apt-get purge -y gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Josi's own writable areas, created in the IMAGE and owned by the runtime user.
#
# Docker seeds a fresh named volume from the image path it is mounted over,
# ownership included. Without these, the volume directories are created by the
# daemon as root:root 0755, the application runs as `node`, and every backup
# fails with a permission error on a real installation — which is exactly what
# the first runtime run found while every unit test passed.
RUN mkdir -p /data/backups /data/diagnostics /data/versions /data/codex /data/claude /data/chat-attachments \
 && chmod 0700 /data/chat-attachments \
 && chown -R node:node /data

# ------------------------------------------------- the ChatGPT subscription path
#
# OpenAI's own CLI, pinned to an exact version. It is what makes subscription
# sign-in possible on a Docker installation at all: the binary that matters is
# inside this container, and an operator has no shell into it, so the wizard
# drives `codex login --device-auth` here rather than telling somebody to run a
# command they cannot reach.
#
# PINNED, NEVER FLOATING. `@openai/codex@latest` would mean the CLI's interface
# changing under a running installation — and the wizard reads what that CLI
# prints, so a reworded prompt is a broken sign-in. The default below is a real
# published version; `--build-arg JOSI_CODEX_VERSION=` skips the install
# entirely, and an image built that way reports the path as unavailable rather
# than pretending.
#
# The exact version is asserted by the packaging test, so moving it is a
# deliberate edit in two places rather than a drifting tag.
ARG JOSI_CODEX_VERSION=0.152.0
RUN if [ -n "$JOSI_CODEX_VERSION" ]; then \
      npm install -g --ignore-scripts "@openai/codex@${JOSI_CODEX_VERSION}" \
      && codex --version; \
    else \
      echo "JOSI_CODEX_VERSION empty — building without the Codex CLI"; \
    fi

# -------------------------------------------------- the Claude subscription path
#
# Anthropic's own CLI, pinned the same way and for the same reason. The sign-in
# it drives is Anthropic's: `claude auth login --claudeai` prints an authorize
# URL and then waits on STDIN for a code the operator brings back from their own
# browser. Josi shows the link, carries the paste, and never sees a credential —
# the CLI writes its own login into CLAUDE_CONFIG_DIR.
#
# THE BINARY IS UNMODIFIED. It is installed from the published package and run
# as published; nothing here patches it, wraps its auth, or reads its files.
# That is the arrangement Anthropic documents for a product that ships Claude
# Code, and it is the only one Josi implements. See docs/SUBSCRIPTION_AUTH.md
# for the terms, the date read, and the outstanding counsel review (FI-006).
#
# PINNED, NEVER FLOATING, for the same reason as Codex: the login flow is driven
# by reading what this CLI prints, so a reworded prompt is a broken sign-in.
# `--build-arg JOSI_CLAUDE_VERSION=` skips the install, and an image built that
# way reports the path as unavailable rather than pretending.
ARG JOSI_CLAUDE_VERSION=2.1.258
#
# `--ignore-scripts` STAYS, and the one script that has to run is run by name.
# This package needs its own postinstall to link its native build — without it
# the binary is a stub that exits 1 — but dropping the flag would also let every
# transitive dependency execute arbitrary code during the image build. Naming
# the single script keeps that blast radius at one file, in the open, in a line
# a reviewer can see.
RUN if [ -n "$JOSI_CLAUDE_VERSION" ]; then \
      npm install -g --ignore-scripts "@anthropic-ai/claude-code@${JOSI_CLAUDE_VERSION}" \
      && node "$(npm root -g)/@anthropic-ai/claude-code/install.cjs" \
      && claude --version; \
    else \
      echo "JOSI_CLAUDE_VERSION empty — building without the Claude Code CLI"; \
    fi

# The `node` user (uid 1000) ships with the base image. Everything below runs as
# it: the application never needs to write to its own code, so the whole tree is
# owned by root and readable — not writable — by the runtime user.
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/packages ./packages
COPY --from=build --chown=root:root /app/apps ./apps
COPY --from=build --chown=root:root /app/package.json ./package.json
# The built SPA. `WEB_DIR` points the API at it; absent, the API serves no UI.
COPY --from=build --chown=root:root /app/apps/web/dist ./web

# Git does not track directory modes. A checkout created below a private 0700
# directory can therefore give Docker a source tree whose directories and
# non-executable files are owner-only. COPY preserves those modes even with
# --chown, and the non-root runtime user then sees entrypoints such as
# packages/db/migrate.mjs as "missing" because it cannot traverse the path.
# Normalize readability in the image so the artefact is reproducible across
# CI, ordinary clones and locked-down build worktrees. Capital X adds execute
# only to directories and files that were executable already.
RUN chmod -R a+rX /app/node_modules /app/packages /app/apps /app/web \
 && chmod a+r /app/package.json

USER node

# No MASTER_KEY_FILE ENV here on purpose.
#
# It would only ever hold a PATH, never key material — but BuildKit's
# SecretsUsedInArgOrEnv check flags any ENV whose name looks secret-ish, and the
# honest fix is to remove the line rather than suppress the check. Suppressing
# it file-wide would also hide a genuine secret-in-ENV mistake later.
#
# Nothing is lost: the default lives in code (core/masterKey.ts,
# DEFAULT_MASTER_KEY_PATH) and compose sets the variable explicitly for the
# services that need it.

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/server.js"]
