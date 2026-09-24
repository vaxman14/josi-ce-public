# Durable native turns and Expo push

Migration `0057_durable_mobile_turns_push.sql` reserves `0056` for the parallel assistant migration. **Merge gate:** land and validate the parallel `0056` first, then rebase this branch and run the real PostgreSQL upgrade suite before merge; migration filenames are ledger keys, so adding `0056` after an already-deployed `0057` is not a supported order.

## Native API contract

All routes use the existing authenticated session and CSRF boundary. Resources are owner-only; a thread share and super-admin role do not grant access.

### `POST /api/assistant/threads/:threadId/turns`

Accepts JSON:

```json
{
  "client_message_id": "stable-device-generated-key",
  "message": "hello",
  "reply_to_message_id": "optional-message-uuid",
  "attachment_receipts": ["already-uploaded-attachment-uuid"],
  "attempt_of": "optional-failed-turn-uuid"
}
```

`Idempotency-Key` may supply `client_message_id`. The server atomically verifies owner/thread bindings, pins ready upload receipts, persists the inbound message and durable turn, and enqueues one opaque `assistant.turn` job. It returns `202` immediately:

```json
{"turn":{"id":"uuid","job_id":"uuid","status":"queued","lifecycle_state":"accepted_queued","thread_id":"uuid","client_message_id":"...","attempt_of":null},"duplicate":false,"telemetry":{"state":"accepted_queued","turn_id":"uuid","thread_id":"uuid"}}
```

Reusing the key with the exact request returns the same turn with `duplicate: true`; reusing it for different input returns `409 idempotency_conflict`. Submission is limited to 20 turns per owner per minute and 50 queued/running turns per owner; overload returns `429` with `Retry-After`. A terminal failure remains `failed`. Retry by sending a new `client_message_id` and linking `attempt_of` to that failed turn.

### `GET /api/assistant/threads/:threadId/turns?cursor=<opaque>`

Returns owner-scoped queued/running/completed/failed reconciliation state ordered by the stable `(updated_at,id)` key. The response includes `next_cursor`; `turn_id=<opaque UUID>` directly reconciles one known turn. Timestamp-only cursors are rejected because equal timestamps can lose events. `completed` is emitted only after the assistant message is persisted. Failure includes a stable code and `retryable` hint.

`job_id` intentionally equals the opaque turn UUID; the database queue's
sequential internal identifier is never exposed. Native records a Sentry
breadcrumb/tag only from the content-free `telemetry` shape. Before receiving
the `202`, transport exceptions are tagged `pre_accept_transport_failure` and
the same idempotency key is safe to retry. After receiving `202`, the client
must not report a generic network failure if it is killed or loses transport:
it stores the opaque IDs and reconciles, tagging `accepted_queued`,
`reconciling`, `completed`, or `terminal_failed`. Never attach message text,
attachment names/content, auth data, or push tokens to those events. This is
the regression contract for production Sentry event
`64dfcff0fc1c4b9aae0d528530bf9548` (`josi-mobile`, iPhone18,2,
2026-09-18 01:55:22 PDT).

### Device registry

- `PUT /api/assistant/devices` registers or rotates `device_identity`, `platform`, `expo_token`, `app_state`, `privacy_locked`, category booleans, quiet-hour local times, and IANA `timezone`.
- `GET /api/assistant/devices` returns settings and state, never a token or ciphertext.
- `DELETE /api/assistant/devices/:deviceId` revokes the owner-bound device.

Expo tokens are AES-256-GCM sealed with the installation master key. Logs, events, queue payloads, API responses, and audit data never contain plaintext tokens. Registering a token after an account switch revokes its old owner binding.

## Worker and delivery semantics

Each accepted turn records the authenticated server-side session. A queued turn fails closed as non-retryable `session_expired` if that login is revoked or expired, or the account is disabled, before the worker starts it. Workers renew the turn and queue leases together so slow provider responses are not mistaken for crashed work. They reclaim an expired row after crashes, but do **not** replay an expired running model/tool turn. Before every consequential tool, CE persists a unique `(turn, tool-input hash)` effect fence; its exact receipt is durable after success. A crash after the fence but before a receipt is `effect_outcome_unknown`, non-retryable, and a linked retry is refused. A crash before any consequential boundary is retryable as a new `attempt_of`. Compare-and-set leases prevent an old process from later creating a reply. Existing action-state, approval hash/consumption, and task compare-and-set boundaries provide additional protection.

Assistant completion and approval-needed notifications, task/calendar success or failure, and explicit reminder/calendar-reminder notifications create unique per-device outbox rows in the authoritative source-state transaction. Foreground devices suppress banners. Privacy lock replaces content with generic text. Ordinary updates respect local quiet hours using `Intl` IANA timezone conversion (including DST); explicit reminders may bypass quiet hours. Deep-link data contains only a route type (`turn`, `approval`, `task`, or `reminder`) and its opaque, owner-authorized UUID; provider event identifiers and content never enter it.

The Expo sender uses batches of at most 100, unique `(device,event)` delivery keys, bounded timeouts/exponential retry, `Retry-After`, and separate ticket/receipt states. Permanent provider/configuration errors fail immediately. A ticket is not delivery; a successful receipt becomes `provider_accepted`, never a claim that the OS displayed it. `DeviceNotRegistered` revokes only the matching token generation. Deep links contain only route type plus opaque UUID. Category, owner binding, token generation, foreground state, privacy lock, and quiet hours are rechecked at send time.

Tests inject HTTP and never contact Expo. No EAS cloud build is involved.

## Known provider boundary

Expo does not provide an idempotency key for push requests. If a worker loses the HTTP response after Expo accepted a request, retry can produce a duplicate OS notification. Likewise, an account switch concurrent with an already-dispatched Expo request cannot recall that request; CE revokes the old binding for future sends while preserving the in-flight row through ticket/receipt reconciliation so local state never falsely claims it was suppressed. The database guarantees one logical delivery/outbox row and never falsely marks it delivered, but transport-level exactly-once is not claimable. Model providers likewise do not universally provide crash-safe idempotency; this is why an interrupted turn fails closed rather than automatically replaying, while server-side consequential actions remain fenced by CE's persisted approval/action/task state.
