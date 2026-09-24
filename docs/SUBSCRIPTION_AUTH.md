# Using a subscription instead of an API key

Josi CE can use a **ChatGPT plan** or a **Claude subscription** for its model,
instead of a metered API key. This document says exactly how, and on what
basis — with sources and dates, so the reasoning can be re-checked rather than
taken on trust.

The Admin Model page tests each configured model before Josi uses it. Any
failed capability appears under **Unavailable features**. **Image
understanding** means the model was given a real test image and correctly
identified it; it is not inferred from the model name. On the ChatGPT-plan
path, attached images are passed to `codex exec` with its documented
`--image` option and are removed from Josi's temporary directory immediately
after the call.

> **The Claude section of this document said the opposite until 2 September
> 2026.** It stated that Anthropic prohibited the path outright. That reading
> was wrong, and the correction is recorded below rather than quietly applied,
> because anyone who read the old version made a decision on it.

This is a Community Edition capability. A hosted, business or white-label build
of this same source is structurally unable to enable it. See
[the edition boundary](#the-edition-boundary) below.

---

## The research, and when it was done

Re-checked **1 September 2026**. Both positions below are current as of that
date and should be re-checked before any release that changes this feature.

### OpenAI / ChatGPT — a supported path exists

OpenAI's Codex documentation covers two things Josi relies on:

- **`codex login` signs the CLI in with a ChatGPT plan.** The CLI caches
  credentials locally and refreshes them itself.
  ([Authentication](https://learn.chatgpt.com/docs/auth))
- **`codex exec` is a documented non-interactive mode**, intended for scripts
  and CI — a prompt in, an answer out, no TUI.
  ([Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode))

OpenAI also documents the consequence that matters: when the CLI is signed in
with a ChatGPT plan rather than an API key, **headless runs draw on the same
rolling usage window as your interactive sessions**.
([Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan))

There is **no documented mechanism for a third-party application to implement
"Sign in with ChatGPT"**, and Josi does not attempt one. What Josi does is
different in kind: it runs the operator's own unmodified first-party binary,
under the operator's own login, on the operator's own machine.

The terms confine this to **individual productivity** and exclude using a
personal plan to **power a commercial service or resell access**. That sentence
is the entire reason the edition boundary exists.

### Anthropic / Claude — a supported path exists, through Anthropic's own CLI

**What this document used to say.** That Anthropic's policy confines Free, Pro
and Max sign-in to Claude Code and Claude.ai, that using those credentials in
any other product "including the Agent SDK" is not permitted, that it was
enforced on 4 April 2026, and that there was therefore nothing to build.

**What re-reading it showed.** The prohibition is narrower than that summary,
and the distinction it draws is the one that matters here. What is forbidden is
a third party **implementing Claude.ai login itself, collecting or
intermediating Claude.ai credentials, or routing requests through a user's
subscription credentials on their behalf**. What is described as permitted is a
product that **preinstalls or runs the unmodified Claude Code binary, where each
end user authenticates with their own credential through Anthropic's own flow**.
([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
section "Can customers offer Claude Code in their products?", read 2 September
2026.)

The old summary collapsed those two into one prohibition. The Agent SDK clause
is real; it is not the same clause as the one about shipping the CLI.

**What Josi does, therefore, and what it refuses to do.** Josi installs the
published `@anthropic-ai/claude-code` package at a pinned version and runs it
unmodified. Signing in runs `claude auth login --claudeai`, which prints an
Anthropic URL and then waits on its own standard input for a code the operator
brings back from their own browser. Josi displays the link and passes the one
paste through to that process. It does not implement Claude.ai OAuth, does not
read or store the credential the CLI writes, does not refresh or forward it,
and makes no HTTP request to Anthropic on this path at all.

**Still outstanding, and not for this document to close.** FI-006 in
`docs/FIRST_INSTALL_FINDINGS.md` requires two things that remain open:
confirmation of whether Anthropic's Commercial Terms must be accepted before
shipping Claude Code inside a distributed image, and **counsel review before
this integration is represented as permitted in a public release**. Nothing here
substitutes for either. The implementation exists and is honest about its
mechanism; the legal representation is Roman's call to make with advice.

**An Anthropic API key remains available** on every build, including hosted
ones, and needs none of the above.

### GitHub Copilot

Not offered, and as of 2026-09-02 not listed in the product at all. It is
licensed for use inside GitHub's own editor integrations, not for a server
answering on somebody's behalf; a choice that can never be chosen is noise, so
the permanently-unavailable entry was removed.

---

## What Josi actually does

```
Josi  ──spawn──▶  codex exec --json --sandbox read-only --skip-git-repo-check
                             --model <model> -
                    │
                    ├─ prompt arrives on STDIN  (never in argv — an argv is
                    │                            world-readable in the process
                    │                            table, and the prompt is
                    │                            somebody's conversation)
                    │
                    └─ the CLI uses ITS OWN login and talks to OpenAI itself
```

Josi never:

- implements "Sign in with ChatGPT" — there is no OAuth client, redirect,
  callback or token anywhere in the code
- reads `~/.codex/auth.json`, a keychain, a browser profile or a cookie jar
- stores, copies, forwards, refreshes or expires any credential
- makes an HTTP request to OpenAI on this path

Those are not intentions. A test in `packages/llm/test/subscription.test.ts`
walks **every source file in the repository** and fails the build on any
reference to a credential store — the Codex credential file, the Claude Code
one, the gh one, a Chrome profile, the macOS keychain, the Linux keyring,
`keytar`, or a cookie database. It is why the path above appears in this
document and not in the source.

### The environment the child gets

`OPENAI_API_KEY` and its relatives are **deleted** from the subprocess
environment, not merely left unset. Codex prefers an API key when one is
present, and the server process may well have one — if that happened, "use my
subscription" would quietly bill an API account. That is the exact
misrepresentation this feature exists not to commit.

`PGPASSWORD`, `DATABASE_URL` and `MASTER_KEY_FILE` are removed too. Nothing in
the child needs them, and a subprocess is the classic way an environment ends up
in a log.

---

## What it costs you — the honest list

This path is the **lesser option**, not the default. Every limitation below is
shown in the product on the Model screen, not only here.

| | Subscription (Codex CLI) | API key |
|---|---|---|
| Per user? | **No — per installation.** Everyone shares the operator's plan. | Per installation, metered |
| Usage limits | **Shares your own Codex rolling window.** Heavy Josi use eats your personal Codex allowance. | Your API quota |
| Token counts | **None reported.** | Reported |
| Cost reporting | **None.** Usage rows record `subscription` and zero — the true per-call figure for a flat fee. | Estimated or reported |
| Spending caps | **Cannot be enforced** in currency on this path. | Enforced |
| Tool calling | **Yes, through Josi's MCP harness.** The same ownership, step-up and approval code runs; vendor built-in shell/file tools remain denied. | Yes |
| Structured output | **No.** | Usually |
| Conversation history | Flattened into one prompt — lossy | Native message array |
| Needs on the host | The `codex` binary, installed and signed in | Nothing |
| Local-only mode | **Refused**, same as any hosted provider | Refused |

Tool outcomes do not come from parsing vendor prose. Each call and its real
result is written by Josi's MCP server to a mode-0600 file inside a private
per-call temporary directory. The provider reads that file before deleting the
directory and passes the intact result to approval, grounding and presentation
guards. The result is never printed by the harness, and internal receipts are
removed before a reply reaches a person.

---

## Setting it up

### On a Docker installation — the normal case

The published image already contains the Codex CLI, pinned to an exact version.
You do not install anything and you do not need a shell into the container.

1. In the setup wizard, at **Language model**, choose **My ChatGPT plan (no API
   key)**. It appears only on a Community Edition build.
2. Press **Sign in with ChatGPT**. Josi runs the CLI's own
   `codex login --device-auth` and shows you the link and one-time code it
   prints.
3. Open the link in your own browser, enter the code, approve it.
4. Continue. Josi sends one real message before treating the model as working.

The same flow is at **Admin → Model** after setup.

> **Why the wizard drives this rather than telling you to run a command.**
> The binary that matters is inside the container and you are outside it. A
> `codex login` on the host signs in a CLI that Josi will never run — which is
> exactly the failure a real installation on an Intel N150 hit, and the reason
> this section was rewritten.

The login is stored by the CLI in its own home directory, which is a dedicated
Docker volume (`josi_codex`, mounted at `/data/codex`). It survives the
container being replaced, so an update does not sign you out. `docker compose
down -v` destroys it along with everything else.

**Josi never sees your login.** No credential is read, parsed, copied, stored or
forwarded, and the one-time code is a pairing code rather than a secret — it is
meant to be read aloud, it grants nothing without you completing the flow with
your own ChatGPT account, and it expires in fifteen minutes.

### Running Josi outside Docker

Install and sign in the CLI as the account Josi runs as:

```bash
codex login          # opens a browser; sign in with your ChatGPT plan
codex login status   # should say you are signed in
codex exec --json --sandbox read-only -  <<< 'say hello'
```

The last command is the exact shape Josi uses. If it works by hand, it will work
from Josi.

### In Docker

The default CE image does **not** contain the Codex CLI, and the container does
not have your login. To use this path in Docker you must either:

- install the CLI into a derived image and mount your Codex configuration
  directory into the container, read-only; or
- run the API outside Docker on the machine where you are signed in.

Neither is the default and neither is recommended for a shared installation.
This capability suits a single-person installation on a machine its owner
already uses.

---

## The edition boundary

OpenAI's terms permit an individual to use their own plan for their own
productivity, and exclude using it to power a commercial service. CE is the
first; a hosted build of this same source would be the second.

So the difference is not a setting. It is the **build**:

- `packages/core/src/buildStamp.ts` holds the edition as a compiled constant,
  written by `scripts/stamp-edition.mjs` during `docker build` from
  `--build-arg JOSI_EDITION`.
- The environment can only **narrow** the capability set. `JOSI_EDITION=ce` on
  a hosted image does nothing.
- An unrecognised stamp falls to the **least** capable edition, never to CE.
- Four layers refuse independently: the route is not mounted, the route guard
  answers 404, the provider factory throws, and `buildProvider` throws again —
  so a row inserted directly with `psql` on a hosted build still cannot be used.

`apps/api/test/subscription.test.ts` computes a hosted profile and drives the
real routers with it, because no hosted build exists to try.

To build a hosted image:

```bash
docker build --build-arg JOSI_EDITION=hosted -t josi:hosted .
```

---

## Troubleshooting

**"The Codex CLI was not found."** The binary is not on the `PATH` of the
account Josi runs as. Set an explicit path when configuring the provider.

**"The Codex CLI on this machine is not signed in."** On Docker, use the
**Sign in with ChatGPT** button — it runs the device flow inside the container,
which is where the CLI Josi actually runs lives. Signing in on the host does not
sign in the container. Outside Docker, run `codex login` **as the account Josi
runs as**, not as your own user.

**"The Codex CLI is not present in this installation."** A published image
contains it. A source build only has it if the build supplied
`--build-arg JOSI_CODEX_VERSION=<version>`; one built with an empty value
deliberately ships without it and says so rather than pretending.

**"Your ChatGPT plan has hit its usage limit."** Shared with your own Codex
sessions, by design and by OpenAI's documentation. Wait, or switch the primary
model to an API key provider.

**"…does not understand `codex exec --json`."** An old CLI. Update it.

**Josi says it cannot book a meeting.** Correct — this path has no tool calling.
Configure an API key provider for anything that acts.

**Everything worked and then stopped after a container rebuild.** The CLI and
its login live outside the image. A rebuild that does not carry them forward
leaves the path unconfigured.

---

## Where the code is

| Concern | File |
|---|---|
| The provider — spawn, environment, parsing, errors | `packages/llm/src/providers/codexCli.ts` |
| The registry branch that refuses a stored key | `packages/llm/src/registry.ts` |
| `subscription` as a charge basis | `packages/llm/src/metering.ts` |
| Route, options list, save-path refusals | `apps/api/src/http/llmRoutes.ts` |
| Edition boundary | `packages/core/src/edition.ts`, `packages/core/src/buildStamp.ts` |
| Schema and the no-key constraint | `packages/db/migrations/0015_subscription_auth.sql` |
| Tests, including the repository-wide credential guard | `packages/llm/test/subscription.test.ts` |
| Tests, over the wire and the hosted-build proof | `apps/api/test/subscription.test.ts` |
