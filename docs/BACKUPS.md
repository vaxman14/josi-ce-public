# Backups

Open **Administration → Backups** to create, download, and copy backups off the Josi server.

## Back up now

Choose **Back up now** for a restorable archive. The progress bar reports database export,
archive creation, off-site upload, and verification. The running job remains visible after
navigation or refresh, and Josi refuses a second backup while one is active. Success is shown only
after the archive and any configured off-site copy are verified.

## SMB or NFS NAS

Choose **NAS / network share**, select SMB or NFS, and enter the NAS address and share/export name.
SMB normally needs a username and password; NFS normally authorizes the Josi host. Use **Connect
and browse** to select a folder. Josi's restricted storage controller creates the Docker mount and
keeps Docker authority out of the normal web and worker containers. Credentials are stored in the
Master Vault and are never returned to the browser, Compose file, or logs.

Off-site encryption is enabled by default. Save the one-time backup recovery key somewhere other
than the NAS or cloud bucket. Disabling encryption affects future backups only and means a storage
administrator can read those archives.

## Changing or removing a destination

**Change** preserves the saved address, folder, and encrypted credential. Blank secret fields mean
“keep the saved secret.” Nothing changes until **Save destination** succeeds. Removing a destination
is a separate confirmed action and does not delete archives already stored there.

Troubleshooting: confirm the NAS is reachable from the Docker host, SMB/NFS permissions allow the
Josi host to write, and the restricted storage-helper container is healthy. Removing the destination
also removes its runtime mount and stored credential.
