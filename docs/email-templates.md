# Email Templates

Open **Email / Templates** from the sidebar or Home. Templates are private to their owner, including when another user is an administrator. Create, select, edit, and delete saved templates. Duplicate names are allowed; the picker shows an ID suffix to distinguish them.

The builder accepts a name, subject, heading, plain body, six-digit accent color, optional button label and URL, and footer/signature. It is a structured text builder: blank lines become paragraphs and single newlines become line breaks. HTML and Markdown are literal text. There is no raw HTML, custom CSS, script, image, or embed input. Button URLs must be absolute HTTP(S), without credentials or merge fields. Both label and URL must be provided together.

The live preview uses labeled sample data and can switch between desktop and a 375px mobile width. It also shows the plain-text fallback. Actual drafts use only the values supplied for that draft.

## Exact merge syntax

Names are case-sensitive with no spaces inside the braces:

| Token | Value |
| --- | --- |
| `{{recipient}}` | The draft's single To email address. CC recipients do not change it. |
| `{{name}}` | Recipient name supplied in `merge_values.name`. |
| `{{date}}` | Literal date text supplied in `merge_values.date`, e.g. `September 18, 2026`. |
| `{{time}}` | Literal time text supplied in `merge_values.time`, e.g. `10:00 AM PDT`. Include the time zone. |

Tokens work in subject, heading, body, button label, and footer. Name, color, and URL are not interpolated. Unknown tokens and missing/blank referenced values stop rendering. Dates/times are never taken from the clock, inferred, or reformatted. Substitution is single-pass: a token-like string inside a value is displayed literally. Merge values cannot contain control characters and are limited to 500 characters. User text is escaped in all HTML contexts. Subjects cannot contain newlines.

## Draft and approval

The draft form chooses an exact saved ID; unsaved edits must be saved first. **No template — plain text** preserves the existing plain-text send path. Preparing a draft creates a private assistant task and pending approval; it does not contact a provider. Review the final subject, plain body, button URL, signature, and rendered layout on Approvals before approving.

The assistant's `draft_email` accepts either `template_id` or `template_name`, plus `recipient`, optional `cc`, and `merge_values`. Names match exactly, case-sensitively. Zero matches are refused. Multiple matches are refused with a request for an exact ID; the assistant never chooses the first match. Supplying both selectors is refused. Subject/body come from the selected template; conflicting draft overrides are refused. Edit the template to change them. Without a template the existing `subject` and `body` fields work as before.

Example tool arguments:

```json
{
  "recipient": "alex@example.test",
  "template_name": "Appointment reminder",
  "merge_values": {"name": "Alex", "date": "September 18, 2026", "time": "10:00 AM PDT"}
}
```

The approval hashes the entire task, including the template snapshot, merge values, exact subject, HTML, and text. The worker verifies the approval and safe snapshot, and sends those exact alternatives without loading the current template or time. Later edits or deletion do not change a prepared draft. Changing any approved task field invalidates the approval. A new draft needs a new approval. Delivery uses multipart/alternative MIME for Google and Microsoft; provider capability checks still apply. Operational thread SMTP routes retain their existing plain-text behavior.

## HTTP API

All routes use session authentication and the application's CSRF protection. Owner identity always comes from the session; it is never accepted in input. Another owner's object returns the same 404 as a missing object.

- `GET /api/mail/templates` — list owned templates.
- `POST /api/mail/templates` — create structured fields (201).
- `GET /api/mail/templates/:id` — read one owned template.
- `PUT /api/mail/templates/:id` — replace all structured fields.
- `DELETE /api/mail/templates/:id` — delete (204).
- `POST /api/mail/templates/preview` — `{template, recipient, merge_values}` to `{subject,text,html}`; no mutation.
- `POST /api/mail/templates/draft` — draft tool arguments above; creates a private approval task (201); never sends.
- `GET /api/mail/templates/approvals/:id/preview` — owner-only pending approval preview, checked against the pinned task hash.

Template fields: `name` (120 characters), `subject` (300), `heading` (300), `body` (30,000), `accentColor` (`#RRGGBB`), `ctaLabel` (120), `ctaUrl` (2,000), `footer` (2,000). Name, subject, body, and valid color are required; optional text fields default to empty. Unknown fields are rejected. Drafts with missing information cannot become sendable tasks.

Migration `0055_email_templates.sql` adds the owner-indexed table with row-level security enabled, following the repository's application-scoped ownership convention.

Provider reference: [Microsoft Graph MIME sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0).
