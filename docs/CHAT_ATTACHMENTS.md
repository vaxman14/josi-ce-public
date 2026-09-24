# Chat attachments

Chat uploads use the dedicated `josi_chat_attachments` persistent volume mounted at `/data/chat-attachments`. Web and worker run as UID/GID 1000. A one-shot `attachment-init` service repairs only the volume directory's ownership and mode on installation and upgrades; it has no network, host mounts, or secrets. Container recreation preserves the volume. Never delete this volume to upgrade.

## Upload and storage contract

Multipart bodies stream into a private, bounded staging file; multer does not retain the request body in memory. After validation, bytes stream to an exclusive UUID-addressed file. HEIC/HEIF conversion and strict format validation currently require a bounded in-process buffer after staging, but network upload buffering is eliminated. Database rows persist only the opaque UUID in the legacy `storage_path` column—never a filesystem path or URL.

Defaults are 20 MiB for images, documents and ZIP, and 25 MiB for audio and video, so a valid approximately 20 MiB video is accepted. Operators may set `JOSI_ATTACHMENT_IMAGE_MAX_BYTES`, `JOSI_ATTACHMENT_DOCUMENT_MAX_BYTES`, `JOSI_ATTACHMENT_AUDIO_MAX_BYTES`, `JOSI_ATTACHMENT_VIDEO_MAX_BYTES`, or `JOSI_ATTACHMENT_ARCHIVE_MAX_BYTES` to positive byte counts up to the 100 MiB hard safety ceiling. Other quotas remain one file per request, 10 attachments per message, 100 files per conversation, 1,000 files/200 MiB per user, and 10,000 files/2 GiB per installation. Database reservations serialize concurrent uploads.

The authoritative capability matrix is `ATTACHMENT_CAPABILITIES` in `packages/storage/src/attachmentContract.ts`:

- images: JPEG/JPG, PNG, GIF, WebP, HEIC and HEIF;
- documents: PDF, UTF-8 TXT/Markdown/CSV, JSON, RTF, DOC/XLS/PPT, DOCX/XLSX/PPTX, ODT/ODS/ODP;
- audio: MP3, M4A, AAC, WAV, OGG, Opus and FLAC;
- video: MP4, M4V, MOV, WebM and MPEG;
- archives: ZIP as opaque stored content only.

Extension, declared MIME, and magic/container structure must agree. Empty, malformed, truncated, oversized, executable, malware-test, active-PDF, macro-enabled, embedded-object and polyglot content is rejected with a stable machine-readable code. ZIP and ZIP-based document packages receive bounded central-directory inspection without extraction: entry count, central-directory size, expanded-size declarations, encryption, methods, paths, duplicates and executable/active entry names are checked. ZIP contents are never analyzed or executed.

AVI is intentionally rejected with `avi_validation_unavailable`: the bundled runtime has no codec/container probe strict enough to validate arbitrary AVI safely. Convert AVI to MP4, MOV or WebM. This service does **not** enforce audio/video duration. It validates container structure and byte limits only; no safe existing duration probe is bundled, so the API never claims a duration limit was checked.

Names are NFC-normalized and path, control, bidi-control, leading-dot and unsafe trailing characters are removed. Duplicate display names are supported because stored objects are addressed only by server UUID.

HEIC/HEIF input is verified as ISO-BMFF/HEIF, converted in an isolated worker, and stored as JPEG for download and vision-capable providers. Original HEIC bytes are not retained. Corrupt/disguised files, timed-out conversions, and converted images over the image limit are rejected.

## Storage versus analysis

Successful storage and content analysis are separate facts. Every upload response and durable/history attachment receipt contains machine-readable analysis metadata. Formats with an approved parser or provider path report `available`; storable formats without one report `unavailable` with `analysis_unavailable`. Parser failure preserves the valid stored file and records `analysis_parser_failed` instead of deleting it or claiming that it contained no text. Unsupported bytes are never sent to document parsers. Audio, video, GIF, legacy Office, RTF and opaque ZIP are currently storage/download-only. This validation is not antivirus certification.

Only the conversation owner can upload, retrieve or delete attachments. Model selection checks owner and conversation. A file is unavailable until its write succeeds. Supported image bytes are supplied only to a provider with verified vision capability; supported documents contribute only approved extracted text. Downloads require authentication and use attachment disposition, `nosniff`, no-store caching and a sandbox content policy.

Unsent uploads expire after 24 hours; the worker sweeps hourly. Files referenced by web or durable turns are preserved, including pre-upgrade references. Deleting an unused attachment is available through `DELETE /api/assistant/attachments/:id`; referenced attachments return 409. Back up the attachment volume together with the database.

If `/ready` reports `attachment_storage`, inspect the web/worker startup diagnostic:

- `storage_missing`: provision the named volume and recreate web/worker using the release's Compose definition, including `attachment-init`.
- `storage_permission`: rerun `docker compose run --rm attachment-init`, then check that web/worker run as UID 1000.
- `storage_read_only`: restore read/write access to the dedicated attachment volume.
- `storage_full`: free disk capacity; deleting a container does not free a volume.
- `storage_unsafe`: remove a symlink configuration and mount a real dedicated volume.

Readiness exposes only the subsystem name, never host paths or raw filesystem errors. An unavailable volume must be repaired; restarting alone does not provision a missing persistent mount.
