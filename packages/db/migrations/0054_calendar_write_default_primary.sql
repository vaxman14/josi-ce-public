-- Reconcile upgrade-time write routing after provider discovery. A stale
-- internal default may point at an arbitrary selected secondary calendar;
-- writable provider primaries take precedence. A person may still explicitly
-- choose another write default after this one-time reconciliation.
with preferred as (
  select distinct on (s.owner_user_id) s.owner_user_id, s.id
    from calendar_sources s
    left join calendar_sync_origins o
      on o.connection_id=s.connection_id and o.provider_calendar_id=s.provider_calendar_id
    left join calendars c on c.id=o.calendar_id
   where s.writable and s.selected
   order by s.owner_user_id, s.is_primary desc, c.is_default desc,
            (s.provider_calendar_id <> 'primary') desc,
            s.last_discovered_at desc, s.id
)
update calendar_sources s
   set is_write_default=false
  from preferred p
 where s.owner_user_id=p.owner_user_id
   and s.id<>p.id
   and s.is_write_default;

with preferred as (
  select distinct on (s.owner_user_id) s.owner_user_id, s.id
    from calendar_sources s
    left join calendar_sync_origins o
      on o.connection_id=s.connection_id and o.provider_calendar_id=s.provider_calendar_id
    left join calendars c on c.id=o.calendar_id
   where s.writable and s.selected
   order by s.owner_user_id, s.is_primary desc, c.is_default desc,
            (s.provider_calendar_id <> 'primary') desc,
            s.last_discovered_at desc, s.id
)
update calendar_sources s
   set is_write_default=true
  from preferred p
 where s.id=p.id
   and not s.is_write_default;

-- When that source already has an internal origin, move the internal default
-- to the same calendar. Clear first because calendars_one_default is a partial
-- unique index and cannot temporarily hold both rows.
with target as (
  select s.owner_user_id, o.calendar_id
    from calendar_sources s
    join calendar_sync_origins o
      on o.connection_id=s.connection_id and o.provider_calendar_id=s.provider_calendar_id
   where s.is_write_default
)
update calendars c
   set is_default=false
  from target t
 where c.owner_user_id=t.owner_user_id
   and c.id<>t.calendar_id
   and c.is_default;

with target as (
  select s.owner_user_id, o.calendar_id
    from calendar_sources s
    join calendar_sync_origins o
      on o.connection_id=s.connection_id and o.provider_calendar_id=s.provider_calendar_id
   where s.is_write_default
)
update calendars c
   set is_default=true
  from target t
 where c.id=t.calendar_id
   and not c.is_default;
