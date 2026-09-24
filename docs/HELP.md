# Josi CE Help

Josi CE 0.1 includes one self-hosted workspace, account roles and MFA,
conversations, tasks, approvals, contacts, personalization and memory, usage and
cost limits, hosted or local model providers, Google/Microsoft connections,
contact synchronization, operational mail, document storage/search, external
messaging channels, backups/restore/export, diagnostics, optional telemetry,
system checkups, an installable PWA, optional Voice Box, developer-service
connections, and licensed Family BETA controls.

## Start and operate

* [Quick start](QUICK_START.md)
* [Complete installation and operations manual](INSTALLATION.md)
* [Josi CLI, one-line installer, repair doctor, and support bundles](CLI.md)
* [PWA installation and cache behavior](PWA.md)
* [Telegram setup and troubleshooting](TELEGRAM.md)
* [Contact synchronization](CONTACT_SYNC.md)
* [Subscription authentication](SUBSCRIPTION_AUTH.md)
* [Voice Box](VOICE_BOX.md)
* [Parental Controls BETA](PARENTAL_CONTROLS.md)
* [Backups, restore, updates and diagnostics](PHASE_10_EVIDENCE.md)
* [Backups: progress, SMB/NFS, encryption, and recovery](BACKUPS.md)
* [Integrations and per-user developer accounts](DEVELOPER_SERVICE_CONNECTIONS.md)
* [Custom REST APIs](CUSTOM_API_CONNECTIONS.md)
* [Security model](THREAT_MODEL.md)
* [Legal and policy index](LEGAL.md)

## Josi CLI and one-line installer

The signed Josi CLI keeps Docker Compose as the only runtime while providing
operator commands for installation, status, updates, backups, logs, rollback,
uninstallation, diagnosis, and repair. Install the current verified Linux
`amd64` or `arm64` release with:

```bash
curl -fsSL https://github.com/vaxman14/josi-ce-public/releases/download/v0.1.65/install.sh |
  sudo bash -s -- --version 0.1.65 --yes
```

The installer requires an explicit version, verifies its own pinned verifier,
the release's Sigstore workflow identity, and the signed SHA-256 manifest before
installing anything. Download and inspect the script instead of piping it when
that better fits your security policy.

Use `josi doctor` to back up state, apply safe deterministic repairs, verify the
real postcondition, and roll back repairs that regress readiness. Use
`josi doctor --check-only` for a read-only audit or `--dry-run` for the exact
repair plan. `--yes` does not authorize AI repair.

Use `josi logs --since 30m`, `josi support bundle`, or
`josi doctor --export-ai-context PATH` to collect a bounded, structured,
secret-redacted diagnostic bundle. After deterministic repair is exhausted,
`josi doctor --ai-repair --allow-ai` can offer a separately approved local
Codex or loopback Ollama investigation. It presents the exact plan and requires
a second approval bound to that plan before executing allowlisted changes.

See the [complete CLI guide](CLI.md) and the
[public installer provenance](https://get.heyjosi.com/provenance.json).

## Family / Parental Controls BETA

Open **Workspace → Family (BETA)** to add a managed child account, set Josi-only
schedules and message-minute limits, view usage, and—with explicit relationship
authority—review that child's Josi conversations. Open **Admin → Parental
controls (BETA)** only to manage the publisher-issued licence.

Do not rely on Family BETA for a child's safety. It does not control a device,
other apps, websites, location, emergencies or actual screen time. Use active
adult supervision and proven device-level controls, and verify restrictions.

## Help link

Every signed-in page includes a persistent **Help** link to the public guide.
The login page includes public legal links. If Help is absent after an upgrade,
hard-refresh once; if it remains absent, the running image is not the expected
release and the operator should compare its image digest and revision label.

## Gmail SMTP and App Passwords

Gmail SMTP normally uses `smtp.gmail.com`, TLS on port `465` (or STARTTLS on
port `587`), and the full Gmail address as the username. Google accounts with
2-Step Verification use a Google App Password rather than the normal account
password.

Google displays an App Password as four groups of four lowercase letters. Josi
removes spaces automatically, but must receive exactly 16 letters. Before
selecting **Save and test**, enable **Show password** and confirm that all four
groups contain four letters. Google's copy action can occasionally omit the
final character; if the field shows `4-4-4-3`, append the missing final letter
from Google's display or generate a new App Password.

If Gmail reports that it rejected the username or password, first confirm the
full Gmail address and all 16 App Password letters. Do not keep retrying a
15-letter value. Regenerate any App Password that appears in a screenshot,
message, ticket, log, or other shared location.

## First-run recovery key and model test

The setup wizard shows the Vault recovery key once. Its on-screen preview is
masked except for the final four characters; use **Copy key** or **Download
key**, store it offline, then acknowledge it. The later launch checklist reuses
that acknowledgement and does not ask for the same key again.

The model is saved and put through the full five-part capability test on the
**Language model** step. Setup does not advance until that test passes. Other
configuration summaries appear only on **Review and finish**, not on unrelated
privacy or security screens.

## Developer workspace

The browser installer can optionally mount one host project folder at
`/workspace`. Skip this unless Josi's coding connectors need local files.
Read-only access supports inspection; read/write supports editing, tests and
Git. The installer validates the selected capability and refuses system,
credential, secret, and Josi installation paths. Normal application containers
do not receive the Docker socket.

## Password recovery

Reset emails use the exact browser-facing origin approved by the installer,
including LAN HTTP and non-default ports. If email is unavailable, run
`./reset-password.sh USERNAME_OR_EMAIL` from the installation directory. The
command accepts the new password through a hidden prompt, replaces only one
active account, and invalidates its sessions and unused reset links.

## Connection saves and consent

A settings Save control is disabled until there is a valid unsaved change and
while a request is pending. A saved announcement follows confirmed persistence
and readback; an error retains unsaved input for retry. Editing multiple provider
sections does not discard the other sections when one is saved. Browser exits
and navigation warn about pending credential or permission edits.

Google, Microsoft, Dropbox, and Box request their supported scope bundle during
account connection. Older partial grants have one account-level permission
upgrade. Provider consent never enables local write switches automatically;
turn the desired capabilities on separately. The latest granted scopes replace
old grants, so removed provider permissions cannot remain authorized locally.
Disconnect withdraws local access before attempting remote token revocation.
Consequential actions still require their own local confirmation.

### Chat drafts, approval, and status

Email sends and calendar writes are kept as server-side action records scoped
to your account, conversation, domain, operation, and originating turn. Josi
shows the exact recipient/subject/body or calendar/title/time before asking for
approval. A plain “yes” applies only when exactly one action was prepared in
the immediately preceding assistant turn; otherwise Josi asks you to name the
action. “No” cancels it, and unanswered approvals expire after 15 minutes.

Partial drafts keep only fields from the same active action. For example, a
follow-up subject completes the current email without changing its recipient or
body; an unrelated calendar name cannot enter that email. “The main one” means
the single calendar marked primary by the connected provider. If that metadata
is missing or ambiguous, choose an exact calendar instead.

Connection status is configuration evidence, not a live mailbox probe. Josi
must say whether email is configured versus actually reached during a read or
send. After approval, “was it sent?” reports the email action's recorded state
(queued, sent, or failed), not the state of a calendar action.

Native workflow discovery, exact-input approvals, callbacks, and Obsidian access
are covered in [Integrations](DEVELOPER_SERVICE_CONNECTIONS.md).

## Persistent chat attachments

See [Chat attachments](CHAT_ATTACHMENTS.md) for supported formats, storage limits,
privacy, retention, installation/upgrade volume provisioning and troubleshooting.
