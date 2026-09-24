update task_templates set contract =
  '{"slots":{"required":["recipient","subject","body_brief"],"optional":["body","cc"]},"urgency_ceiling":"text","max_attempts":2}'::jsonb
  where key = 'send_message';
update task_templates set contract =
  '{"slots":{"required":["title","start","end"],"optional":["event_id","description","location","attendees"]},"urgency_ceiling":"text","max_attempts":3}'::jsonb
  where key = 'schedule_appointment';
insert into task_templates (key, name, contract, requires_capability) values
  ('update_contact', 'Create or update a contact',
   '{"slots":{"required":["name"],"optional":["contact_id","email","phone","notes"]},"urgency_ceiling":"push","max_attempts":2}',
   'contacts_write')
on conflict (key) do update set contract = excluded.contract, requires_capability = excluded.requires_capability;

insert into admin_approval_policy (action_class, max_level) values ('contacts_write', 'always_ask')
on conflict (action_class) do nothing;
