// Runtime metadata only: no token unsealing, host paths, provider response bodies or contact contents.
import { randomUUID } from 'node:crypto';
import { appendEvent, type Db } from '@josi-ce/core';

export async function providerStatus(db: Db, userId: string) {
  const connections = await db.query(`select c.id, c.provider, c.account_email as account,
    c.status, c.last_check_at, c.last_check_ok, c.last_error_category,
    coalesce((select jsonb_agg(jsonb_build_object('capability', cc.capability,
      'enabled', cc.enabled, 'granted', cc.scopes_granted_at is not null,
      'admin_allowed', coalesce(p.allowed, true)))
      from connection_capabilities cc left join admin_capability_policy p on p.capability=cc.capability
      where cc.connection_id=c.id), '[]'::jsonb) as capabilities
    from connections c where c.owner_user_id=$1 order by c.provider, c.id`, [userId]);
  const folders = await db.query(`select m.id, m.provider, m.display_path as folder,
    m.root_id, m.connection_id, m.remote_folder_id, m.status, m.paused_reason,
    m.indexing_enabled, m.may_create, m.may_edit, m.may_move, m.may_delete,
    s.last_sync_at, s.next_sync_after, s.consecutive_failures, s.last_error_category,
    (select count(*)::int from documents d where d.mapping_id=m.id and d.owner_user_id=$1) as discovered,
    (select count(*)::int from documents d where d.mapping_id=m.id and d.owner_user_id=$1 and d.state='indexed') as indexed,
    (select count(*)::int from documents d where d.mapping_id=m.id and d.owner_user_id=$1 and d.state in ('failed','blocked','skipped')) as unavailable,
    (select count(*)::int from processing_jobs j join documents d on d.id=j.document_id
      where d.mapping_id=m.id and d.owner_user_id=$1 and j.owner_user_id=$1 and j.state in ('queued','running')) as pending
    from folder_mappings m left join sync_state s on s.mapping_id=m.id and s.owner_user_id=$1
    where m.owner_user_id=$1 order by m.provider, m.id`, [userId]);
  const contacts = await db.query(`select id, connection_id, provider, status, sync_mode,
    last_sync_at, last_attempt_at, last_error_category, last_sync_counts,
    delta_cursor is not null as incremental, page_cursor is not null as more_pages,
    sync_interval_seconds from contact_sync_origins where owner_user_id=$1 order by id`, [userId]);
  const native = await db.query(`select id, service as provider, account_label as account,
    status, last_check_at, last_check_ok, last_used_at,
    case when last_error is not null then 'Check this provider in Connections; reconnect or verify its permissions.' else null end as remediation
    from developer_connections where owner_user_id=$1 order by service`, [userId]);
  const workflows = await db.query(`select id, provider, name, status, enabled,
    account_identity as account, last_check_at, last_check_ok,
    (select count(*)::int from workflow_definitions d where d.integration_id=i.id and d.active and d.exposed) as exposed_workflows
    from workflow_integrations i where created_by=$1 order by provider, id`, [userId]);
  const custom = await db.query(`select id, name, slug, enabled, status, last_check_at,
    last_check_ok, last_error_category from custom_api_connections
    where created_by_user_id=$1 order by slug`, [userId]);
  const receipt = randomUUID();
  await appendEvent(db, { actor: 'agent', actorUserId: userId, kind: 'providers.status_read',
    payload: { receipt, connections: connections.length, mappings: folders.length } });
  return { ok: true, receipt, observed_at: new Date().toISOString(), connections, folders, contacts, native, workflows, custom,
    unprobed: ['Obsidian vault discovery requires the separately authorized list_obsidian_vaults tool. No filesystem scan was performed.'],
    evidence_scope: 'Current installation records, not a live provider probe. A connected account does not imply that files were mapped or indexed. Local/NAS mappings do not have provider delta cursors.',
    remediation: 'Reconnect accounts with revoked or expired access in Connections. Enable the required capability on the exact account. Map folders in Storage and separately consent to indexing. Resume paused mappings or inspect their error category; pending jobs need a running worker. Contact sync starts automatically within two minutes after contact-read is enabled; stopped origins require explicit restart.' };
}
