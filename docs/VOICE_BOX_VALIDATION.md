# Voice Box v1 validation

Validated on Linux amd64 on 2026-09-12. CPU candidates use Kokoro only,
faster-whisper 1.2.1+josi.pcm1 and source-built CTranslate2 4.8.2+josi.cpu1.
The image identities, input hashes and final SPDX SBOMs are recorded in
[the artifact manifest](voice-box/artifacts.json).

| Check | Result |
| --- | --- |
| Full `npm test` | 86 files, 2,305 tests passed |
| `npm run typecheck` | Passed, including web type checking |
| Web production build | Passed |
| Python helper/artifact tests | 12 passed, including hidden/deleted image-layer codec rejection and rejection of an unreviewed upstream decoder patch |
| Real amd64 CPU container acceptance | 11 passed: actual STT/VAD/TTS, API/model readiness, isolation, authentication, Heart/Bella, speech speed, Tiny STT, rollback, restart, uninstall |
| Focused browser acceptance | Passed: healthy-only settings and WAV preview, microphone capture, partial/final transcript, normal assistant reply, interruption and track cleanup |
| CPU builds | Linux amd64 and arm64; both run real Kokoro → PCM → VAD → Whisper inference during the build |
| CE application Docker build | Passed, local amd64 image only |
| Optional GPU image build | Passed; retains CUDA-capable upstream CTranslate2 and an explicit unreviewed-publication receipt. GPU inference is not verified because the host lacks NVIDIA Container Toolkit/CDI configuration |
| License/SBOM checks | Per-architecture runtime audit, all-image-layer check, exact source/model hashes, SPDX 2.3 schema and relationship checks; final reports accompany the SBOMs |
| Existing full browser suite | 58 passed, 10 failed; identical assertions reproduced on untouched base `aa66b23` in the preceding baseline audit and reproduced again after this revision |

The final amd64 acceptance record is [cpu-acceptance.json](voice-box/cpu-acceptance.json).
It records 8.50 s installation/readiness, 2.92 s synthesis, and 5.831 s processing
for 6.175 s of streamed audio. Maximum simulated backlog was 2.791 s, below the
browser's existing 4 s capture-queue budget. These are measurements on this
host, not a throughput guarantee for every CPU. Arm64 inference was exercised
under QEMU, not on native arm64 hardware.

## Reproduce

Use the commands in [Voice Box development and verification](VOICE_BOX.md#development-and-verification).
After building the API and web app, run `node scripts/test-voice-browser.mjs`
for focused browser acceptance; `--full` adds the existing suite. The focused
fixture uses the real Josi API/UI with deterministic helper/assistant replies.
`scripts/test-voice-box.py` independently exercises the actual private container,
pinned models and streaming of synthesized speech through STT/VAD.

[The SBOM instructions](voice-box/README.md) describe local OCI generation,
schema validation and artifact checks. Sources, notices, build recipes and
runtime inventories remain inside each candidate image.

## Publication-readiness verdict

The reviewed CPU candidates have the required redistribution materials and pass
the requested Voice Box checks. No remaining CPU redistribution-material blocker
was identified in this artifact review. Roman subsequently authorized the CPU
image, which was published for amd64 and arm64 and added to the production
catalog by immutable digest. That authorization does not extend to GPU artifacts.

The broader Josi CE browser gate is **not green**: ten pre-existing assertions
still fail (console policy, existing control sizes, connection/provider choices,
admin header and branding/offline expectations). This change does not weaken
those assertions or claim that the complete application release gate passed.
GPU artifacts require a separate redistribution review and runtime validation.
The validation pass itself performed no merge, publication, release, deployment
or gate upgrade; the later publication is recorded in the artifact manifest.
