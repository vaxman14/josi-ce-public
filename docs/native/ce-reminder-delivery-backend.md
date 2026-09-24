# CE reminder delivery backend contract

## Authority and reliability

The CE backend is the only authoritative reminder delivery owner. Creating, editing, or cancelling a reminder does **not** emit `meta.nativeActions` or return a `native_action`. The authenticated, account-scoped `/api/assistant/reminders/native-actions` snapshot exposes only content-free, revisioned reminder intent for durable mobile status and explicit calendar export; it is not an alarm acknowledgement or ownership transfer. A device registration is not evidence that the app durably scheduled a particular reminder revision, and this backend has no per-device acknowledgement protocol that could establish that fact. It therefore never suppresses server delivery in favor of an inferred local alarm.

At the due instant, the worker persists the reminder in chat and creates one Expo outbox row for every enabled, non-revoked registered device. This includes devices whose last reported state is foreground: stale foreground state from an offline or killed app cannot discard a reminder. Explicit reminders bypass quiet hours and foreground deferral; ordinary assistant notifications retain their bounded foreground grace behavior.

Revocation, token-generation fencing, category changes, and owner binding are rechecked during dispatch. Reminder payloads use the mobile parser's opaque shape:

```json
{"route":"reminder","id":"opaque-reminder-id","threadId":"opaque-thread-id","owner":"sha256([deployment-origin, account-id])"}
```

The owner hash binds both deployment and account without exposing either identifier. A reminder for a registration that predates this binding is suppressed as `owner_binding_unavailable`, rather than sent with an unprovable route. The mobile client accepts `route` as the route discriminator, requires `id`, `threadId`, and the exact owner hash for reminders, and then relies on normal server authorization when opening the thread.

## Edit, cancel, multi-device, and deduplication behavior

Queue payloads contain only reminder id and revision. Every edit increments the revision and creates a new job. Claim requires the exact revision, `scheduled` state, and `due_at <= now()`, so an old job cannot deliver an edited or cancelled reminder. Chat persistence and all per-device push rows share one SQL statement. Push event keys include reminder id and revision, and the unique `(device,event)` key makes duplicate workers/retries idempotent while preserving one delivery per capable device.

Cancellation increments the revision and leaves old jobs harmless. Revoked devices are excluded at enqueue time and fenced again at dispatch. A token rejected as `DeviceNotRegistered` revokes only that token generation. Offline devices retain their server outbox row for bounded retry; Expo ticket acceptance remains transport acceptance, not proof that the OS displayed the notification.

## Migration and rollout

Migration `0059_native_reminder_delivery.sql` adds timezone, revision, device owner binding, push route thread identity, update timestamp, and revision backfill for existing queued jobs. Despite the historical filename, it does not establish native ownership. Existing and new reminders remain server authoritative.

Roll out database migration, API, and worker from the same commit. Do not run a new worker against an unmigrated database. No deployment is performed by this branch.

## Verification boundary

Automated tests cover timezone/DST formatting, monotonic edit/cancel revisioning, stale-job suppression, worker idempotency, multi-device outbox creation including stale foreground state, explicit-reminder foreground dispatch, owner-bound payload shape, account authorization, and migration backfill. Expo delivery, physical-device notification presentation, and a live upgraded PostgreSQL deployment remain rollout checks.
