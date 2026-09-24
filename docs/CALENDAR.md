# Calendar views and exact sources

Open **Calendar** and refresh discovery after connecting an account. Each checkbox
names both its calendar and account. Only checked calendars appear in the combined
view; colors supplement, rather than replace, their names. An unavailable selected
calendar produces an error, never substitution with the account's primary calendar.
Enable calendar reading in Connections if access was withdrawn.

Discovery reconciles Google's request alias `primary` to the stable provider
calendar ID and permits only one provider-marked primary per account. Every
selected calendar, including secondaries, gets an internal sync origin and is
synced immediately. Select exactly one writable calendar as **Write default**.
Ordinary new-event requests use that destination without asking among calendars
selected only for reading; an explicit calendar name or source still wins.

Choose List, Month, Week or Day. List shows the next seven civil dates from the
chosen date. Month has a six-week grid; click a date for Day. Previous/Next move a
whole month in Month, a week in Week/List, or a day in Day. Today uses the displayed
timezone. Timezone selection applies to timed events and range boundaries; all-day
dates remain calendar dates. Daylight-saving days have their actual 23 or 25 hours,
with timezone labels distinguishing repeated hours. Overlapping timed events occupy
separate columns. Recurrence occurrences retain their provider event IDs. Use Tab
to reach events, Enter to inspect them, and arrow/Home/End keys on Month dates.
Small screens can scroll the calendar grid without scrolling the whole page.

Reads follow provider pagination, up to 1,000 events per calendar per range. If a
range cannot be completely retrieved within that bound, the calendar reports an
error and asks for a shorter range instead of presenting a silently partial agenda.
Discovery and event descriptions are remote reads, not a copy of event bodies into
Josi's database. The existing capability and ownership checks apply on every read.

Assistant `query_calendar` uses exactly those selections. An explicit `source_id`
selects exactly that owned calendar; an unavailable or revoked source fails. Its
receipt includes provider, account ID/email, calendar ID/name, source ID and an
opaque event ID encoding the calendar source and provider event ID. `get_event`
uses that receipt's original source, even when another calendar has an identical
event ID. Ambiguous older IDs require a fresh query. Keep these receipts in
citations and pass the exact `calendar_event_id` for calendar reminders; the
verified provenance is retained in the reminder's durable message. Event drafts
preserve the exact source in their approval slots; no provider write is implied by
a draft. An empty answer is returned only when every selected source has fresh,
successful synchronization coverage. Missing, stale, incomplete or failed coverage
produces an explicit refusal instead of a false "nothing scheduled" claim.

Google sync requests expanded recurrence instances and retains the provider series
ID plus original occurrence time, so recurring appointments appear in the queried
range without pretending the first occurrence is the whole series.

Assistant turns receive one effective timezone: the person's USER profile value,
falling back to the workspace timezone and then UTC. The prompt includes the exact
local current date/time and explicit today/tomorrow/yesterday civil dates. Relative
dates advance calendar dates rather than adding 24 hours, including 23- and 25-hour
daylight-saving transitions.

## Acceptance checklist and reproduction

- [x] Civil date, UTC-boundary Today, spring/fall DST, true month navigation,
  all-day exclusive end, overnight events, overlap and recurrence-instance cases:
  `apps/web/test/calendar.test.ts`.
- [x] Selected secondary-calendar provider URLs, pagination, explicit cap failure,
  UTC Graph normalization, and hostile continuation URL refusal:
  `packages/connectors/test/mailCalendarAdapters.test.ts`.
- [x] Two accounts with identical event IDs, exact follow-up token/calendar,
  deselection, revocation, cross-user/forged references, and durable reminder
  provenance against the real migrated schema: `packages/agent/test/dataTools.test.ts`.
- [x] HTTP source identity, disabled/revoked errors, unauthorized and cross-owner
  boundaries: `apps/api/test/calendarRoutes.test.ts`.
- [x] Rendered desktop/mobile, keyboard and error/empty proof:
  `scripts/acceptance/test-list-7-calendar-browser.mjs` against a local web server.
  This script uses synthetic provider responses, not a claim of live Google or
  Microsoft account acceptance.

Run focused unit/integration checks with:

```sh
npx vitest run apps/api/test/calendarRoutes.test.ts apps/web/test/calendar.test.ts packages/agent/test/dataTools.test.ts packages/connectors/test/mailCalendarAdapters.test.ts --maxWorkers=2
npm run dev --workspace=@josi-ce/web -- --host 127.0.0.1 --port 18492
node scripts/acceptance/test-list-7-calendar-browser.mjs
```

Focused evidence: 50/50 tests passed across four files on 2026-09-16.
Chromium rendered acceptance passed at 1440×1000 and 390×844; twelve checks per
viewport. Browser provider/auth responses are synthetic. No live provider-account
acceptance was performed by this calendar-only verification.
