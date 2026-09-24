# Product Hunt launch kit — Josi CE Community Preview

This file is launch copy, not proof that the repository is public. Publish only
after the legal/trademark and clean-history gates are closed.

## Name

Josi CE

## Tagline

Your AI executive assistant, on your own server

## Short description

Self-host an AI executive assistant for your team with Docker. Bring your own
model credentials, keep workspace data on infrastructure you control, and reach
Josi from the web or your own Telegram bot.

## First comment

We built Josi CE because useful assistants need context, tools, and continuity,
but teams should not have to surrender control of their workspace to get them.

The 0.1 Community Preview installs from published multi-architecture Docker
images, supports multiple isolated users in one workspace, and includes a
guided setup for model providers, mail, storage, Telegram, backups, and policy.
It is AGPL-3.0 software and deliberately early: no SLA, no automatic updates,
and no invented production-capacity claims.

We want feedback on the workflows that save real time, the installation path,
and the places where the assistant should be more transparent or easier to
control.

## Suggested gallery

1. Product promise: “Your assistant. Your server. Your credentials.”
2. Setup wizard and provider choice
3. Multi-user workspace and policy controls
4. Conversation with a visible tool approval
5. Connections: mail, storage, and Telegram
6. Backup warning: database plus separately held master key
7. One-command Docker installation

Every screenshot must come from the release build with synthetic data. Remove
names, email addresses, tokens, hostnames, private IPs, and browser bookmarks.

## Maker FAQ

**Is everything local?** The application and database are self-hosted. Requests
sent to an external model provider are processed under that provider's terms.
Local-only mode blocks external model providers.

**Can I use a ChatGPT subscription?** Josi CE supports the official Codex CLI
path on the installation host, subject to OpenAI's terms and plan limits. API
providers and OpenAI-compatible local endpoints are also supported.

**Is this production-ready?** No. It is a Community Preview with no SLA or
support entitlement.

**What platforms are supported?** Published images target Linux amd64 and
arm64. Docker Desktop works for evaluation. Portainer, Unraid, and current
Docker-based TrueNAS SCALE have documented Compose deployment paths; formal
hardware certification is pending.

**How is it licensed?** Code is AGPL-3.0. The Josi name and marks are governed
separately by the trademark policy.

## Launch gates

- Repository public from sanitized history
- Docker Hub mirror verified
- Public quick-start URLs tested without repository credentials
- Synthetic screenshots and logo assets exported at Product Hunt dimensions
- Support/bug/security intake enabled and linked
