# Custom API connections

Connect an external HTTP service Josi has never heard of — a booking system, a
CRM, something written in-house — and then say, one action at a time, exactly
what Josi may ask it.

This is the only connection kind in Josi CE where **the assistant chooses which
request to make**. That single fact is the reason every other decision on this
page went the way it did.

---

## What an administrator does

**Admin → Custom API.** Nothing here is preset: a fresh installation has no
connection, no environment variable creates one, and no seeded row exists.

1. **Name it and give its address.** The address must start with `https://`.
   Josi refuses `http://` outright — a plain-text base URL would put this
   installation's credential on the wire in the clear on every call.
2. **Give it a credential.** An API key in a header you name, a bearer token, or
   HTTP basic. It is sealed with the installation master key before it reaches
   the database and is never shown again.
3. **Test it.** A `GET` to the test path you chose, and nothing else.
4. **Make it available to Josi.** This button does not work until the test has
   succeeded. A connection cannot reach the assistant on the strength of a form
   somebody filled in — only on the strength of the API having answered.
5. **List the actions.** By hand, or by importing an OpenAPI document. Each one
   arrives **switched off** and has its own switch.

Josi can call an action only when **both** switches are on: the connection's and
the action's. There is no row anywhere that means "any path on this host", and
no code path that composes one.

---

## What the assistant gets

Two tools, and neither of them is "make an HTTP request":

| Tool | What it does |
| --- | --- |
| `list_custom_api_actions` | Lists the allowed actions and their parameters. Makes no request to any API. |
| `call_custom_api` | Runs **one** allowed action, named by connection and action id. |

`call_custom_api` accepts four things: which connection, which action, values
for the parameters that action declares, and (for actions that take one) a body.
There is no argument it could fill with a URL, a host, a method, a path or a
header. The host, the scheme, the method, the path and the credential all come
from the allowlist row that the lookup found.

Three gates stand between the model deciding something and it happening, and
they are enforced in three different places:

1. **Offering.** The tools are offered only when at least one enabled action
   under an enabled connection exists.
2. **Resolution.** Execution re-resolves the action against the same enabled set
   at call time. A connection switched off mid-conversation refuses even though
   the tool was offered when the turn began. *The offering is never the
   authority.*
3. **Approval.** A read runs. A write or a delete becomes a request its owner
   has to agree to.

---

## Read is separated from write and delete, by the method

| Method | Capability | What happens when the assistant calls it |
| --- | --- | --- |
| `GET`, `HEAD` | read | Runs immediately. |
| `POST`, `PUT`, `PATCH` | write | Waits for the person to approve. |
| `DELETE` | delete | Waits for the person to approve. |

**The method decides, and the database enforces the pairing.** An administrator
cannot label a `POST` that creates an invoice as a read, because
`custom_api_endpoints_capability_matches_method` refuses the row.

A search endpoint that genuinely needs `POST` is therefore treated as a write
and asks for approval. That is the safe side of a trade-off, and it is a
deliberate one.

There is also no user preference and no admin setting that can make a write
automatic. The approval-level machinery in `packages/core/src/approvals.ts`
governs Josi's own actions (email, calendar, tasks); it is deliberately not
wired to this, because a per-user "automatic" here would mean somebody's
preference silently authorising a delete against an outside system.

### What approval looks like

The request appears on the person's **Approvals** page, showing the connection,
the action, the exact method and path, and the values that would be sent. Two
things are true of that card and both matter:

* **Approving is sending.** The decision and the request happen on one route, in
  one conditional `UPDATE` that moves the row out of `pending`. An approved call
  cannot sit unexecuted, and two browser tabs cannot spend it twice.
* **It expires.** Thirty minutes. A pending write from last month is not
  consent, and offering it as one is how somebody approves something they no
  longer remember being asked about.

The request itself is **sealed** while it waits — a request body on the way to a
CRM is somebody's data, and it has no business being readable in a database dump.
The approval is pinned to a hash of the exact request, so an endpoint edited
between "may I?" and "yes" produces a refusal rather than a different action.

---

## Importing an OpenAPI specification

**Paste the JSON form of an OpenAPI 3 document.** Josi reads it and *proposes*
actions; it saves nothing until you choose from the list, and everything you
choose arrives switched off.

Three things worth knowing:

* **The document's `servers` are ignored, completely.** They are reported back
  so you can see that Josi ignored them and check they agree with the address
  you typed. A specification is usually downloaded from the API it describes,
  which means it is written by the party on the other side of the credential — a
  document that could move the target would be a document that could redirect
  this installation's credential somewhere else.
* **Header and cookie parameters are dropped.** A header the assistant can set
  is a header nobody reviewed, and one of the headers on this request carries
  the credential.
* **JSON only.** OpenAPI is commonly published as YAML, and CE ships no YAML
  parser in its runtime dependencies; adding one to read an untrusted document
  is a supply-chain cost with a sharp edge. Convert the document first — most
  API tooling exports JSON, and any converter will do. This is a real limitation
  and it is stated rather than hidden.

Operations that cannot be used are listed with a reason rather than silently
dropped, and an import stops at 200 actions so a partial list is never presented
as a complete one.

---

## Where requests can go

**The host column is the allowlist.** Every request is assembled and then
re-parsed, and refused unless its hostname equals the connection's host exactly
and its path lies under the base URL's path. A path template with a scheme in
it, a parameter value that tries to escape the path, a base URL edited between
save and use: all three end at that comparison.

On top of that:

* **Addresses are checked at request time, not once at save time.** A hostname
  that resolves to something benign when the administrator tested it and to
  `169.254.169.254` when the assistant uses it is the whole DNS-rebinding trick.
* **Every resolved address is checked, not the first.** A hostname answering
  with one public and one metadata address is an attack, not a lucky draw.
* **Public addresses only.** Loopback, RFC1918, carrier-grade NAT, link-local
  and cloud metadata are all refused. This is stricter than the model-endpoint
  checker in `packages/llm/src/ssrf.ts`, which must permit LAN addresses because
  self-hosted inference is the point of it — there nothing chooses the path,
  here the assistant does. **A custom API on your own LAN cannot be connected**,
  and that is deliberate.
* **Redirects are not followed.** Validating a URL and then chasing a 302 checks
  the wrong URL.
* **Argument values are narrowed.** Text, numbers and true/false only; path
  values are percent-encoded; a value containing a control character is refused
  rather than encoded away. Any argument the action does not declare is dropped,
  and the assistant is told which.

---

## What happens to the credential

Sealed with the installation master key (`packages/core/src/sealing.ts`) before
it reaches a query, and opened only inside the request builder at the moment of
use. The row holds no prefix, no suffix, no length and no hash of it.

It does not appear in chat, in a tool result, in a log, in a diagnostics bundle,
in the audit trail, in an administrator's view, or in any ordinary API response.
The admin page shows a **fixed mask** — four characters of a credential are
still four characters of a credential, and a length narrows a search. A database
dump without the master key does not yield it.

It travels in a header and never in a URL, because a URL reaches logs, proxies
and error messages.

**An API's own error text is never passed through.** An arbitrary API's error
body is attacker-influenced and may quote the request back — and the request
carried this installation's credential. Failures become a category and a
sentence CE wrote. A *successful* read's body does go back to the assistant;
that is the point of the feature.

---

## Ownership and isolation

Connections are **installation-scoped and administrator-owned**, which is the
opposite of the call made for developer services — and for the same reason,
applied to a different fact.

A GitHub personal access token *acts as* the person who minted it: commits carry
their name. A custom API credential is a service credential the operator holds
on behalf of the installation, exactly like an SMTP profile or the LLM provider
key. It acts as the product, not as a person. So there is no owner column on the
connection: a column that let one member own one would let one member's
credential be spent by another member's conversation.

**Per-person isolation is absolute and lives one table down.** Every request is
made *for* one person, and every write or delete becomes a pending request only
its owner can see or decide. Another member's request is a `404`, not a `403` —
`403` would confirm that a colleague asked Josi for something. An administrator
using the member routes is a member.

An administrator configures the pipe. They do not get to see what somebody sent
through it.

---

## Audit and diagnostics

Events record who did what to which resource, and never what the resource said:

| Event | Payload |
| --- | --- |
| `custom_api.connection_created` / `_updated` / `_enabled` / `_disabled` / `_deleted` | slug, host, authentication kind |
| `custom_api.connection_tested` | slug, ok, HTTP status, category |
| `custom_api.endpoint_added` / `_updated` / `_enabled` / `_disabled` / `_deleted` | slug, action id, method, capability |
| `custom_api.spec_previewed` / `_imported` | slug, how many proposed, saved, skipped |
| `custom_api.call_requested` / `_approved` / `_denied` | slug, action id, method, capability |
| `custom_api.call_executed` / `_failed` | slug, action id, the HTTP status — a number, never a body |

The summary shown to the owner is content — it quotes what would be sent — so it
belongs to them and is never copied into an audit payload.

A diagnostics bundle carries **counts**: how many connections exist, how many
are available to the assistant, and how many actions are switched on. Never a
name, never a host, never a credential. A bundle goes to somebody else's ticket
system, and a host is your internal service.

---

## Why this is not one of the things it resembles

* **Not an OpenAI-compatible model endpoint** (`packages/llm`). That is one
  caller asking one question with one shape; nothing chooses its path. Here the
  assistant chooses, which is the entire risk and the entire reason
  `custom_api_endpoints` exists.
* **Not a developer-service connection** (`docs/DEVELOPER_SERVICE_CONNECTIONS.md`).
  Those have one pinned host compiled into CE and four hand-written probes;
  nothing about them is operator-supplied, so there is no allowlist to keep.
  Here the host comes from a form, so the host *is* the allowlist.
* **Not an MCP server.** External MCP servers are not implemented in CE, and
  this is not a step towards one: nothing here speaks a protocol, and nothing
  here lets the model name a URL, a method or a header.

## Why there is no OAuth option

CE's OAuth machinery (`packages/connectors/src/connections.ts`) is built around
a client the operator registered with a named provider, a provider consent
screen that names scopes, and a refresh cycle. An arbitrary API supplies none of
those. An option that said "OAuth" while the code pasted a long-lived token into
a header would be a lie told in the schema, so it is not offered. Use a bearer
token issued by the service instead, and rotate it there.

---

## Removing a connection

Deleting a connection takes its actions and any pending requests with it. A
pending write against an API that no longer exists is a request nobody could
honour and nobody should be asked about.

Josi deletes its own copy of the credential. It cannot revoke the credential at
the service — do that in the service's own settings.
