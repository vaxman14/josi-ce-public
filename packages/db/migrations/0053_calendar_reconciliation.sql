-- Reconcile the placeholder Google `primary` alias with the provider's true
-- calendar id, make write routing explicit, and retain recurrence-instance
-- provenance. Existing event rows remain on their internal calendar UUID.
alter table calendar_sources add column if not exists is_write_default boolean not null default false;
alter table calendar_events add column if not exists recurring_provider_event_id text;

-- A pre-discovery origin may use Google's synthetic `primary` alias while
-- calendar discovery has already learned the stable id. Move the origin to the
-- stable id when there is no competing origin, then remove the duplicate source.
with true_primary as (
  select connection_id, provider_calendar_id
    from calendar_sources
   where is_primary and provider_calendar_id <> 'primary'
), movable as (
  select o.id, p.provider_calendar_id
    from calendar_sync_origins o
    join true_primary p on p.connection_id=o.connection_id
   where o.provider_calendar_id='primary'
     and not exists (
       select 1 from calendar_sync_origins x
        where x.connection_id=o.connection_id
          and x.provider_calendar_id=p.provider_calendar_id
     )
)
update calendar_sync_origins o
   set provider_calendar_id=m.provider_calendar_id
  from movable m
 where o.id=m.id;

delete from calendar_sources synthetic
 where synthetic.provider_calendar_id='primary'
   and exists (
     select 1 from calendar_sources real
      where real.connection_id=synthetic.connection_id
        and real.is_primary and real.provider_calendar_id <> 'primary'
   )
   and not exists (
     select 1 from calendar_sync_origins o
      where o.connection_id=synthetic.connection_id
        and o.provider_calendar_id='primary'
   );

-- Bad historical discovery responses must not leave two provider primaries.
with ranked as (
  select id, row_number() over (
    partition by connection_id
    order by (provider_calendar_id <> 'primary') desc, last_discovered_at desc, id
  ) as position
  from calendar_sources where is_primary
)
update calendar_sources s set is_primary=false
  from ranked r where s.id=r.id and r.position>1;

create unique index if not exists calendar_sources_one_provider_primary
  on calendar_sources(connection_id) where is_primary;

-- Preserve an existing internal default where it maps to a writable source;
-- otherwise prefer the provider's true primary, then the first writable source.
with candidates as (
  select s.id, s.owner_user_id,
         row_number() over (
           partition by s.owner_user_id
           order by c.is_default desc, s.is_primary desc,
                    (s.provider_calendar_id <> 'primary') desc,
                    s.last_discovered_at desc, s.id
         ) as position
    from calendar_sources s
    left join calendar_sync_origins o
      on o.connection_id=s.connection_id and o.provider_calendar_id=s.provider_calendar_id
    left join calendars c on c.id=o.calendar_id
   where s.writable and s.selected
)
update calendar_sources s
   set is_write_default=(c.position=1)
  from candidates c
 where s.id=c.id;

create unique index if not exists calendar_sources_one_write_default
  on calendar_sources(owner_user_id) where is_write_default;
