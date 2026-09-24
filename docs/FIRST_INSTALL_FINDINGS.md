# First-install findings

This is the live findings list from a clean Josi CE installation on an
Intel N150 test host running Ubuntu and Docker Engine. A finding stays
open until the fix is implemented and verified during a fresh install
or an explicitly documented equivalent retest.

## Open

### FI-001: Reject URLs and private IP addresses in `JOSI_DOMAIN`

**Observed:** `.env` contained `JOSI_DOMAIN=http://192.168.1.50`. Compose treated
the value as a public HTTPS hostname. Caddy returned cacheable `308` redirects
to HTTPS and then failed the TLS handshake. The permanent redirect remained in
the browser after the configuration was corrected.

**Required:**

- The installer and preflight must reject values containing a URL scheme,
  path, port, or private/local IP address.
- The field must say that it accepts a bare public DNS name only, for example
  `josi.example.com`.
- LAN installations must leave `JOSI_DOMAIN` empty and use plain HTTP unless
  the operator deliberately configures trusted local TLS.
- Invalid input must fail before containers start and explain how to correct
  it.
- The invalid configuration must never emit a permanent redirect that poisons
  the operator's browser.

**Acceptance:** A clean LAN install using `192.168.1.50` reaches `/health`,
`/ready`, and `/setup` over HTTP without redirecting. Scheme-qualified and
private-IP values entered as `JOSI_DOMAIN` are refused with actionable text.

### FI-002: Every launch-checklist task needs contextual instructions

**Observed:** The post-install checklist says "Copy the master key somewhere
else" but does not identify `secrets/master.key`, show how to copy or verify
it, or link to the relevant documentation. The operator must leave the product
and hunt for instructions.

**Required:**

- Every checklist task has a visible **Show me how** link.
- Each link opens the exact relevant documentation section, not the top of a
  general manual.
- The linked instructions include paths, commands, expected output,
  verification, and recovery steps.
- Returning from documentation preserves checklist progress.
- Completed checklist items retain their help links.
- The master-key item explicitly names `secrets/master.key` and links directly
  to instructions for copying and hash-verifying the backup without printing
  the secret.

**Acceptance:** Every checklist item has a valid contextual help link, all
targets exist, and an operator can complete each item using only the linked
instructions.

### FI-003: OpenAI model test sends an invalid request

**Observed:** The admin Model page shows the configured OpenAI primary model as
`not tested`. Running **Test this model** fails the basic-reply check with:
"The provider rejected the shape of the request. This is a defect in Josi
rather than in your configuration." Josi then disables assistant chat, task
extraction, calendar tools, email tools, and document search.

**Required:**

- The OpenAI verification request must use the correct request shape for the
  selected model and authentication method.
- The test must distinguish a malformed Josi request from invalid credentials,
  an unavailable model, quota exhaustion, and unsupported capabilities.
- A failed basic request must retain enough non-secret diagnostic detail for
  the operator and support documentation to identify the failing API contract.
- The first-install flow must not present the model as usable until this exact
  verification succeeds.

**Acceptance:** From a clean installation, the configured OpenAI model passes
the basic-reply test with real content, and only capabilities actually verified
for that model are enabled. The provider receives a valid request for the
selected model and authentication method.

### FI-004: Replace ambiguous setup deferral with explicit choices

**Observed:** Optional setup work can be dismissed with **Not for this
installation**. That wording sounds permanent and does not tell the operator
whether the task will return, remain incomplete, or be disabled.

**Required:**

- Replace the old ambiguous deferral label with two explicit actions:
  **Skip once** and **Remind me later**.
- **Skip once** bypasses the item for the current setup pass only. It remains
  visibly incomplete on the admin launch checklist and can be resumed at any
  time.
- **Remind me later** keeps the item incomplete and creates a visible reminder
  rather than silently burying it.
- Neither action may imply that the feature is permanently disabled or that
  its verification passed.
- The screen must explain the consequence of each choice in plain language.

**Acceptance:** Choosing **Skip once** lets setup continue and leaves the item
open on the launch checklist. Choosing **Remind me later** does the same and
causes the operator to receive a clear follow-up reminder. Both choices can be
reversed without repeating installation.

### FI-005: Admin Model page cannot actually connect Codex or configure Claude

**Observed:** The subscription card says ChatGPT through Codex is available,
but its only action is **Use this for the primary model**. That action merely
changes the configured provider. The page does not start Codex device login,
show the verification URL and one-time code, report sign-in state, or explain
the next action. The documentation incorrectly says the setup wizard's sign-in
flow is also available at **Admin → Model**. The same screen discusses why a
Claude subscription is unavailable but offers no visible route to configure
Claude correctly with an Anthropic API key.

**Required:**

- The Codex option must present a clear **Connect ChatGPT** action.
- Starting it must run the supported device-login flow and display the
  verification URL, one-time code, expiration, progress, success, and
  actionable failure state.
- Selecting Codex as primary and authenticating it must be separate, clearly
  labelled steps; neither may imply the other already happened.
- The page must show whether Codex is installed and signed in before asking the
  operator to test it.
- Claude must appear as a normal provider that can be configured with an
  Anthropic API key.
- The prohibited Claude subscription path must not appear as an unavailable
  provider option or occupy the primary model-selection UI. If the policy needs
  explanation, put it in documentation or behind a small contextual **Why
  isn't Claude subscription supported?** help link.
- Contextual **Show me how** links must open the exact Codex and Anthropic
  setup instructions.

**Acceptance:** On a clean CE Docker installation, an administrator can connect
their ChatGPT plan from **Admin → Model**, see a confirmed signed-in state,
select it as primary, and run the real model test without using a shell. The
same page lets an administrator configure and test Claude with an Anthropic API
key. The UI never conflates an unavailable Claude subscription with an
unavailable Claude API, and it does not present unusable providers as choices.

### FI-006: Claude subscription policy is represented incorrectly

**Observed:** The Model page and `docs/SUBSCRIPTION_AUTH.md` say Anthropic
prohibits using a Claude subscription through Josi and therefore expose no
supported Claude subscription path. Anthropic's current legal and compliance
documentation explicitly permits products to preinstall or run the unmodified
Claude Code binary when each end user authenticates with their own Claude
subscription, API key, or supported inference-provider credential. It forbids
a third-party product from implementing its own Claude.ai login, collecting or
intermediating Claude.ai credentials, or routing requests through a user's
subscription credentials itself. OpenClaw uses the permitted first-party
Claude Code/Agent SDK path and leaves authentication and refresh under
Anthropic's control.

**Required:**

- Re-evaluate Claude subscription support against Anthropic's current
  **Legal and compliance** documentation, including the section **Can customers
  offer Claude Code in their products?**
- If Josi offers this path, it must run the unmodified first-party Claude Code
  binary and use Anthropic's own authentication flow.
- Josi must not implement Claude.ai OAuth, read or store Claude credentials,
  intermediate session tokens, resell usage, or authenticate on a user's
  behalf.
- Each operator must authenticate with their own Anthropic account, and the UI
  must distinguish this first-party CLI path from direct Anthropic API-key use.
- Replace the current blanket prohibition in the UI and documentation; cite
  the exact current Anthropic terms and the date checked.
- Confirm whether Josi must accept Anthropic's Commercial Terms before shipping
  Claude Code inside the image, and obtain counsel review before representing
  the integration as permitted in a public release.

**Acceptance:** The product's Claude options match Anthropic's current written
policy exactly. If the first-party Claude Code route ships, a clean Docker
installation can authenticate through Anthropic's own flow and return a real
response without Josi accessing the credential. If it does not ship, the UI
does not falsely claim Anthropic prohibits the permitted first-party route.

## Verified during this run

- The source-built stack starts successfully on the N150.
- PostgreSQL, web, worker, and Caddy containers report healthy.
- The migration container exits successfully with status 0.
- `/health` returns HTTP 200 with `{"ok":true,"service":"josi-ce"}`.
- `/ready` returns HTTP 200 with `{"ready":true,"blockers":[]}` after the
  invalid `JOSI_DOMAIN` value is removed.
