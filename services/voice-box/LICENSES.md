# Voice Box redistribution review

Reviewed 2026-09-12 as a release candidate. Roman subsequently authorized the
reviewed CPU build, which was published for amd64 and arm64 and entered in the
production catalog by immutable digest. This authorization does not cover the
GPU target or any different image. No models are fetched by the running gateway,
and no third-party TTS web service receives audio or text.

## Engines, weights and voices

| Component | Pinned artifact | Terms and evidence | Packaging decision |
| --- | --- | --- | --- |
| Kokoro neural model | v1.0 quantized ONNX; revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231` | [Converted model repository](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/1939ad2a8e416c0acfeecc08a694d14ef25f2231) and [original model card](https://huggingface.co/hexgrad/Kokoro-82M/blob/f3ff3571791e39611d31c381e3a41a3af07b4987/README.md) declare Apache-2.0 | Bundle with model cards, attribution and Apache license |
| Kokoro Heart and Bella voice vectors | `af_heart.bin`, `af_bella.bin`, same converted revision | Included in the same Apache-2.0 model repository; the original model card describes the training provenance and attribution | Bundle only these two reviewed vectors, each separately SHA-256 pinned; no voice cloning |
| Kokoro inference | ONNX Runtime 1.22.1 | [MIT](https://github.com/microsoft/onnxruntime/blob/v1.22.1/LICENSE) | Keep wheel license and third-party notices |
| English pronunciation | Misaki 0.9.4, spaCy 3.8.7, `en_core_web_sm` 3.8.0 | [Misaki Apache-2.0](https://github.com/hexgrad/misaki/blob/main/LICENSE), [spaCy MIT](https://github.com/explosion/spaCy/blob/v3.8.7/LICENSE), [English model metadata](https://huggingface.co/spacy/en_core_web_sm) | Pin tagger wheel and retain its MIT license and corpus attribution; dictionary-based pronunciation with spelling for unknown words |
| Speech recognition engine | faster-whisper 1.2.1; CTranslate2 4.8.2+josi.cpu1 from pinned source | [faster-whisper MIT](https://github.com/SYSTRAN/faster-whisper/blob/v1.2.1/LICENSE), [CTranslate2 MIT](https://github.com/OpenNMT/CTranslate2/blob/v4.8.2/LICENSE) | Keep installed notices |
| Speech recognition weights | Whisper Base English revision `3d3d5dee26484f91867d81cb899cfcf72b96be6c` and Tiny English revision `0d3d19a32d3338f10357c0889762bd8d64bbdeba` | [Base model MIT](https://huggingface.co/Systran/faster-whisper-base.en), [Tiny model MIT](https://huggingface.co/Systran/faster-whisper-tiny.en), [original Whisper MIT](https://github.com/openai/whisper/blob/main/LICENSE) | Bundle with model card, immutable revision and file checksums |
| Voice activity detection | Silero model bundled in faster-whisper 1.2.1 | [Silero MIT](https://github.com/snakers4/silero-vad/blob/master/LICENSE); wheel is checksum-pinned | Keep upstream notice for bundled model |


`models.lock.json` records the exact URL, revision, size, SHA-256 and license
for every included model/voice/provenance file. `download_models.py` rejects
changed bytes or length before activating the artifact. The selected models
permit redistribution under the terms above, so a separate end-user download
and license acceptance is not needed for them. Any future voice with restricted
or ambiguous terms must stay out of the image/catalog; adding it requires an
explicit first-install notice and a checksum-pinned download after acceptance.

## Artifact-level CPU distribution conclusion

The v1 CPU builds for Linux amd64 and arm64 use Kokoro as their only TTS engine.
The exact final image identities and SBOM hashes are recorded outside the image
in `docs/voice-box/artifacts.json`; this avoids a circular image-digest claim.
The later publication authorization covers only the reviewed CPU image recorded
there. No gate installation or upgrade is authorized merely by this review.

The runtime has no PyAV dependency or compressed-audio codec libraries.
`patch_whisper.py` checks the upstream faster-whisper 1.2.1 audio module hash,
removes its unused decoder and dependency declaration, and identifies the result
as **1.2.1+josi.pcm1**. Upstream MIT notices, original source and the complete
adaptation are preserved. Input is already decoded float32 PCM; inference,
Silero VAD, streaming and transcription are unchanged. NumPy handles PCM16
conversion; Python's standard-library `wave` writes Kokoro output. Unsupported
encoded-file inputs fail explicitly rather than reaching an absent decoder.

`audit_runtime.py` runs inside each architecture's image. It rejects codec
libraries, verifies compiler-runtime substitutions, hashes every preserved
source archive, checks every installed Debian source-package/version against
that source collection, and verifies the remaining Python copyleft sources.
The resulting native-library hashes, notice index and package inventory are
stored in `/usr/share/voice-box/artifacts.json`. Independent Syft SPDX SBOMs and
an image-layer check accompany the candidate. Package metadata is supplemented
with model/voice, source archive and native-file hashes because a Python package
license alone does not describe its bundled native dependencies.

CTranslate2 is built as **4.8.2+josi.cpu1** from pinned MIT source and exact
submodules, with CPU dispatch, OpenBLAS and Ruy enabled. MKL, CUDA and DNNL are
disabled. This avoids the proprietary static MKL/CUDA code present in upstream
amd64 wheels. The Debian OpenBLAS runtime is also source-version matched.
OpenBLAS uses one thread per call to avoid oversubscribing the container CPU
quota; CTranslate2 retains its four-thread inference pool.
Pinned build tools and a dated Debian build-package snapshot reconstruct the
native build; no compiler or build dependency is taken from a floating index.

## Remaining copyleft materials and recipient rights

| Artifacts | Terms | Source and notices preserved in each CPU image |
| --- | --- | --- |
| `num2words` 0.5.14 | LGPL-2.1-or-later | Exact upstream sdist, editable installed Python source and LGPL notices |
| `certifi` 2026.7.22 | MPL-2.0 | Exact upstream sdist including certificate data, installed source and MPL license |
| `tqdm` 4.70.1 | MPL-2.0 AND MIT | Exact upstream sdist, installed source and both license notices |
| Debian base packages, including glibc and GNU tools | Per-package GPL/LGPL and other terms, not a blanket container license | Every installed source-package/version has its complete upstream archive(s), Debian patch/build archive and `.dsc`; `/usr/share/doc/*/copyright` and `/usr/share/common-licenses` are retained |
| GCC 12 runtimes (`libgomp`, `libgfortran`, amd64 `libquadmath`, base `libgcc` and `libstdc++`) | GCC Runtime Library Exception where specified; libquadmath LGPL-2.1-or-later | Exact Debian gcc-12 `12.2.0-14+deb12u1` source/build material and copyright notices |
| Vendored Python build-tool dependencies | Including autocommand 2.2.2 LGPL-3.0 and pip’s vendored certifi MPL-2.0 | Complete pip/setuptools sdists, autocommand sdist, vendoring recipes, editable installed sources and original notices |
| Josi Voice Box gateway and build adaptation | AGPL-3.0-or-later; the faster-whisper adaptation retains upstream MIT terms | Editable gateway/helper/build Python, Dockerfile, every artifact lock, reconstruction scripts and AGPL COPYING text |

Opaque GCC runtime copies from NumPy wheels are replaced with the
pinned Debian libraries **in the same installation layer**. Wheel-private names
remain symlinks to the corresponding dynamically loaded system libraries;
RECORD hashes reflect the replacement. Neither the previous binaries nor their
unmatched source obligations survive in an earlier image layer. OpenBLAS/LAPACK
remain BSD-licensed, with their attribution in NumPy's installed license text.
CTranslate2 and its exact CPU submodule sources supply the notices missing from
the upstream wheel. The tokenizers and hf-xet source distributions and all 535
registry crates in their Cargo locks accompany the image, with their original
license/notice files. Rust standard-library notices are also preserved. This
source collection is a conservative superset of compiled crate dependencies.
ONNX Runtime and other permissive native dependencies retain their license and
third-party notices. The English spaCy model retains its MIT license and corpus
attributions. No installed license or attribution files are stripped.

Corresponding source is included, not merely promised via an upstream URL:
`/usr/share/voice-box/sources/debian/` and `/usr/share/voice-box/sources/python/`, plus `native/` and `rust/`.
`/usr/share/voice-box/THIRD_PARTY_NOTICES.txt` exposes the archived notices in
one readable file; all original archives remain available.
Every archive has a fixed URL, version, size and SHA-256 in `sources.lock.json`.
Debian archives were obtained from its historical source archive for the exact
installed versions. Their `.dsc` files identify source format and checksums;
the Debian tarballs contain `debian/rules`, patches and build dependencies.
Python source archives include their upstream build configuration and licenses.

Recipients may copy, modify and redistribute these covered sources under their
respective licenses. They may modify or replace dynamically linked libraries,
rebuild the image with the included Dockerfile, and use an operator-controlled
catalog for their resulting digest. No additional restriction on debugging or
reverse engineering those modifications is imposed. The image contains no
installation key or technical restriction that prevents an operator from using
a modified build. The read-only runtime default is a configurable security
setting, not a restriction on the recipient's modification rights.

To obtain the materials without starting the service:

```sh
docker create --name voice-source-copy YOUR_REVIEWED_IMAGE
docker cp voice-source-copy:/usr/share/voice-box ./voice-box-materials
docker rm voice-source-copy
```

Rebuild Debian libraries by extracting the matching `.dsc` with `dpkg-source -x`
in a matching Debian build environment and using its declared build dependencies
and `debian/rules`. Replace their locked binary artifacts when rebuilding the
image; the documented dynamic links preserve the library replacement mechanism.
For Python modules, unpack the corresponding sdist, modify/build it, and update
the hash lock for your artifact. Build commands are in `docs/VOICE_BOX.md` and
the complete image recipe is under `/usr/share/voice-box/build/`.

These arrangements follow the [MPL source-availability requirements](https://www.mozilla.org/en-US/MPL/2.0/)
and preserve the applicable GNU license texts and Debian source/build materials.
A distributor must ship this complete image and its matching SBOM; stripping
the source or notices invalidates this artifact-level conclusion. Rebuilding
with changed versions or another architecture requires a fresh check.

The optional CUDA build is **outside this CPU publication conclusion**. NVIDIA
runtime licenses and an independent GPU artifact review still apply. CPU images
do not contain those proprietary libraries. No image, including the verified
CPU candidates, may be published until Roman explicitly authorizes it.
