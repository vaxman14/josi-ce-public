# Test List 7 verification — Bananana, September 15–16, 2026

This report supersedes the earlier blanket completion claim for items 1–6.
Implementation and local verification are complete. The external acceptance
checks below remain unproven; they are not counted as passes.

## Reconciliation

The isolated branch `fix/test-list-7-completion` starts from the current CE main
base `a025123`, through the recovered network and consent commits `aaf0779` and
`3ecd086`. Source commit `80ac8698e3589dc1fe1c433912831bc27f42bcdd` incorporates
and strengthens the interrupted implementation. Merge commit
`fcd8b5fa77bccd4c3572c73d56123ac039b2a5ba` records reconciliation of the subsequently
pushed `b48c31e2b88d15085a95fe30ddcaf78486176383`. Its migration-preservation test
was retained. The final OAuth readback fix is
`57cb7a55a8e3f4271ac408af388ff8171e9f70c4`. Existing dirty worktrees and unrelated changes were left alone.

## Item status

1. **Implemented; external autofill acceptance pending.** The visible Admin
   password label is associated with the masked reauthentication input, retaining
   `current-password`, validation, and keyboard submission. Chromium proved the
   label, empty disabled action, rejected-password announcement, mobile/desktop
   layout and 200% zoom. A real HTTP API test verifies password hashing/checking:
   wrong or absent passwords launch nothing; the correct password launches once.
   These checks do not prove a live 1Password extension or physical screen reader.
2. **Complete.** The actual Docker supervisor runs with networking disabled.
   It discovers the host LAN route through Docker, publishes the temporary
   controller only on that private address, and probes HTTPS inside its network
   namespace. A real LAN HTTPS `/health` returned 200. Unauthorized requests,
   wrong pairing codes, replay, session-cookie security and cleanup were tested.
   Authentication, bounded startup, non-root execution and expiration remain.
3. **Complete with provider contract/sandbox tests.** The original GitHub,
   Netlify, Vercel and Supabase providers remain. Separate native behavior covers
   GitLab, Cloudflare, Docker Hub, GHCR, Sentry, Railway, Render, Linear, Jira, npm,
   Neon and Notion. Obsidian discovers filesystem vaults and reads bounded
   Markdown, without Sync credentials. Zapier uses MCP initialization, sessions,
   JSON/SSE, discovery and calls; n8n uses public API discovery and registered
   authenticated production webhooks; Make uses region/team identity, scenario
   interfaces and responsive execution. Structured input validation, explicit
   exposure, owner approval, authorization-change invalidation, replay-resistant
   signed callbacks, Vault credentials and bounded sanitized history are tested.
   Provider tests use safe protocol fixtures, not live external writes.
4. **Implemented and locally runtime-proven; external public-origin acceptance
   pending.** Startup reconciles runtime origin, deployment/TLS metadata,
   certificate verification, workspace, OAuth callbacks and Telegram metadata
   in one database statement. Verification occurs after public health; configured
   Telegram registration is finalized then. Failure restores environment/Compose/
   proxy files, the previous runtime, exact metadata/timestamps, and the prior
   registered webhook. A failed remote restoration still restores local metadata
   and explicitly reports incomplete recovery. Switching a registered Telegram
   deployment to HTTP requires disconnecting its webhook first. Runtime proof
   covers actual Caddy/LAN application, failed public health and successful exact
   rollback; real PostgreSQL covers domain/port/proxy/LAN metadata transitions.
   Public ACME, external proxy DNS and provider-side changes remain external checks.
5. **Complete.** User/admin OAuth, developer, workflow and Custom API forms have
   guarded saves, appropriate pristine/invalid/pending states, accessible success
   and error feedback, readback before success, retained failed edits, and dirty
   navigation/discard protection. Nextcloud also warns on unsaved connection
   input. Rendered workflow tests prove delayed response, failure, retry, disabled
   pending action and clearing the secret only after confirmed persistence.
6. **Complete.** OAuth requests the supported provider bundle once per account.
   Legacy incomplete accounts receive one account-level upgrade. Local capability
   toggles and consequential action approvals remain separate. Latest token scopes
   replace withdrawn grants; reconnect identity is checked. Disconnect withdraws
   local authority before remote revocation and atomically removes the connection
   and its Vault credential. Vault-backed revoke tests prove the ordering and
   deletion; credentials never appear in the audit response.

## Verification results

Complete suite: **2,667/2,667 tests passed across 113 files**, 332.41 seconds,
using `npm test -- --maxWorkers=2 --fileParallelism` on the 64 GB workstation.
The final assistant exposure test is included in that run.

- Focused run: **134/134**, 12 files. After the final revocation fix: **95/95**,
  three files; strengthened Vault-backed API assertions: **31/31**. Assistant exposure/revocation tests: **2/2**. These runs
  overlap and are not summed.
- Python rollback matrix: **54** previous-mode/target-mode/failure combinations,
  plus explicit failed recovery. Database-trigger failures independently prove
  all four metadata consumers remain atomic. Changed Python files compile.
- TypeScript, server/packages production build, web production build and generated
  documentation build: passed.
- Fresh PostgreSQL: **48 migrations** applied. Migration preservation/validation
  tests passed; the repository has no down-migration runner.
- Compose default/proxy configuration: passed. Clean-install runtime acceptance:
  **45 passed, 0 failed, 5 skipped** for the genuine model-credential dependency.
- Real LAN HTTPS maintenance, real Compose/Caddy successful application and failed
  health rollback, exact PostgreSQL restoration, and all three Chromium proof scripts:
  passed. Browser provider/auth responses are fixtures; API password checking and
  controller/runtime proofs are separate real executions.
- Dependency audit: **0 vulnerabilities**. Repository secret scan and diff hygiene:
  passed. Tracked credential-path review found only the intentional `.env.example`.
  Generated logs/diagnostic archives were checked against the temporary
  installation's actual secret values; none were present. Application image
  inspection confirmed no installation `.env` or secret directory.
- Repository Buildx validation: **linux/amd64 and linux/arm64 passed**, cache only.
  Installer/AIO builds also passed for both architectures. No image was pushed.
  BuildKit warnings name existing public verification-key build arguments; no
  private signing keys or credentials were supplied.

Reproduction scripts are listed in [ACCEPTANCE.md](ACCEPTANCE.md). Updated user,
admin/native-provider and installer behavior is documented in HELP.md,
DEVELOPER_SERVICE_CONNECTIONS.md and INSTALLATION.md; the docs site was rebuilt.

## External acceptance still required

- **Item 1:** an operator session with 1Password/browser autofill and a physical
  assistive-technology client. Run the labeled reauthentication flow on a disposable
  installation; no access to a personal password vault is needed by the build agent.
- **Item 4:** a disposable operator-controlled public domain, trusted ACME or an
  external TLS proxy, OAuth application callback allowlists, and a test Telegram
  bot. Verify public domain/proxy success and provider-side rollback there.
  This local pass neither changes public DNS nor touches the live gate.
- **Clean-install acceptance:** supply a dedicated test model credential through
  `JOSI_ACCEPTANCE_LLM_KEY` to execute the five post-setup checks. The script
  correctly refuses to declare setup complete with an untested synthetic key.

No production deployment, release, image publication, merge to production, or
live-gate upgrade occurred. Only isolated local validation stacks were started.

Temporary validation stacks were stopped after proof; their data volumes were
retained. Existing user worktrees and running services were not cleaned or reset.
