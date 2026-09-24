-- New parsers must apply to files discovered before the upgrade. The cloud
-- walker skips settled, unchanged rows, so move only newly-readable formats
-- back to discovered; the next normal sync will download and extract them.
update documents
set state = 'discovered', skip_reason = null
where state = 'skipped'
  and skip_reason = 'unsupported_type'
  and lower(extension) in (
    'pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp',
    'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'
  );

-- Older releases could index obvious credential bundles as ordinary text.
-- Purge every derived copy immediately, then leave an honest skipped row so
-- the owner can see why the file is absent from search.
create temporary table credential_documents on commit drop as
select id from documents
where lower(filename) ~ '(^|[-_. ])(cred(ential)?s?|passwords?|passwd|recovery[-_ ]?codes?|backup[-_ ]?codes?|private[-_ ]?key|tokens?|secrets?)([-_. ]|$)';

delete from document_embeddings where document_id in (select id from credential_documents);
delete from document_segments where document_id in (select id from credential_documents);
delete from document_text where document_id in (select id from credential_documents);

update documents
set state = 'skipped', skip_reason = 'credential_detected'
where id in (select id from credential_documents);
