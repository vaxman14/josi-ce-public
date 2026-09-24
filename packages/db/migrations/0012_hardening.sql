-- Josi CE 0012: hardening.
--
-- Phase 1 rate-limited sign-in, because that is where credential stuffing goes.
-- Phase 11 covers the rest: the endpoints that are expensive rather than
-- security-critical, where the failure is not a break-in but a small server
-- brought to its knees by one person holding down a button.
--
-- The two need different shapes. Sign-in counts FAILURES and forgets on
-- success, because the thing being limited is guessing. These count ATTEMPTS
-- regardless of outcome, because the thing being limited is work.

create table rate_limits (
  -- Who, and at what. Scoped per user so one person cannot exhaust another's
  -- allowance, which is the failure mode of a global counter on a shared box.
  bucket text not null,
  subject text not null,
  window_started_at timestamptz not null default now(),
  count integer not null default 0 check (count >= 0),
  primary key (bucket, subject)
);
create index rate_limits_window on rate_limits (window_started_at);
