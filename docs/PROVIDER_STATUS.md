# Grounded provider status

Ask Josi “What storage is connected and indexed?” The read-only
`get_provider_status` tool reads current database records for the signed-in user.
It reports OAuth account identity and capabilities, native developer provider
health, owned workflow integrations, Google Drive/OneDrive/Dropbox/Box/Nextcloud
and local/NAS mapped folders, indexing counts and processing queues, and contact
sync timestamps and cursor presence. No credential is opened. Cursor contents,
absolute host paths, contact contents and provider error bodies are omitted.

Every result has a receipt UUID and UTC observation time; the audit log records
that receipt and counts only. Those fields are internal grounding evidence and
must not be rendered in assistant replies or returned in the public talk API.
The assistant may name the human-facing provider/source and summarize useful
status. A connection record is not proof of live provider reachability. A folder
mapping is not proof of indexing. Missing timestamps mean no successful sync has
been recorded, not an empty provider account. Local/NAS folders have no remote
delta cursor. Counts cover local indexed metadata, not all remote files.

Reconnect expired/revoked accounts in Connections. Enable capability switches on
the exact account. Map folders and separately opt into indexing in Storage. For
paused mappings inspect the pause/error category; pending extraction/index jobs
need a running worker. Storage access and file contents remain governed by their
existing authorization checks; this tool grants no additional access.

Custom API definitions configured by the caller are reported separately under
`custom`, never presented as native providers. Native workflow status is limited
to integrations created by the caller. Native developer connections remain owner
scoped. Obsidian is filesystem discovery rather than a stored connection: the
status receipt explicitly marks it unprobed and directs an authorized
administrator to the separate `list_obsidian_vaults` tool. No host filesystem
scan occurs as a side effect of asking for provider status.
