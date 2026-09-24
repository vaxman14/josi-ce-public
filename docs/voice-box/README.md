# Voice Box CPU artifact evidence

`artifacts.json` identifies the reviewed local amd64/arm64 OCI manifests and
configs, SPDX SBOM checksums, source-input hashes, and validation scope. Each
architecture has a final `.spdx.json.gz`, runtime `.audit.json.gz`, and `.report.json`.
`cpu-acceptance.json` records the real amd64 container acceptance and timings.
These are the review artifacts for the authorized CPU image published as
`ghcr.io/vaxman14/josi-voice-box:0.1.0`; authorization and its immutable index
digest are recorded in `artifacts.json`. This evidence does not authorize a
different image, GPU build, or deployment.

The SPDX documents combine Syft's installed-package inventory with verified
model/voice, native-library, source-archive and notice hashes. Syft's complex
Debian license expressions and unresolved automatic license classifications are
retained, rather than relabeling the whole image as permissive. Actual Debian
copyright texts and source/build archives accompany the image. Selected Python
license conclusions reference reviewed upstream notices. See
[LICENSES.md](../../services/voice-box/LICENSES.md) for the artifact-level review.

The layer check scans every OCI layer, including deleted files, for codec and
proprietary static runtime code. It also checks the final embedded source/model
bytes against the lockfiles, image architecture, and runtime-audit identity.
The SBOM passes the official SPDX 2.3 schema and contains no dangling references.

## Reproduce without publishing

Build each CPU architecture to a local OCI archive using Docker Buildx:

```sh
docker buildx build --platform linux/amd64 --target cpu --provenance=false --output type=oci,dest=voice-box-amd64.oci.tar services/voice-box
docker buildx build --platform linux/arm64 --target cpu --provenance=false --output type=oci,dest=voice-box-arm64.oci.tar services/voice-box
```

Use Syft 1.51.1 and Python with `jsonschema` installed. Obtain the official schema
from `https://raw.githubusercontent.com/spdx/spdx-spec/v2.3/schemas/spdx-schema.json`.
The script requires its SHA-256 to equal
`239208b7ac287b3cf5d9a9af23f9d69863971102a5e1587a27a398b43490b89b`.

```sh
python3 scripts/voice-box-sbom.py voice-box-amd64.oci.tar --architecture amd64 --syft /path/to/syft --schema /path/to/spdx-schema.json --output /tmp/voice-box-evidence
python3 scripts/voice-box-sbom.py voice-box-arm64.oci.tar --architecture arm64 --syft /path/to/syft --schema /path/to/spdx-schema.json --output /tmp/voice-box-evidence
```

The commands scan local files only and perform no registry writes. A rebuilt
image gets its own identity and evidence; it must not reuse these receipts as
proof about different bytes. Any authorized distributor must retain the source
and notice materials in the reviewed image and supply its matching SBOM.

The JSON evidence is stored with deterministic gzip compression to keep the PR
reviewable. Decompress with `gzip -dc amd64.spdx.json.gz > amd64.spdx.json`.
Both compressed and original SPDX JSON hashes are recorded in the report.
The original JSON was schema-validated and secret-scanned before compression.
