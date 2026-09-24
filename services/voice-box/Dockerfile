ARG PYTHON_IMAGE=python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7
# Downloads are architecture-independent and reuse one native build stage.
FROM --platform=$BUILDPLATFORM ${PYTHON_IMAGE} AS assets
WORKDIR /build
COPY download_models.py render_notices.py models.lock.json sources.lock.json native.lock.json ./
RUN python download_models.py /models \
    && python download_models.py /redistribution/sources --lock sources.lock.json \
    && python download_models.py /native --lock native.lock.json \
    && python render_notices.py


# Build both architectures from source. This avoids proprietary static MKL/CUDA
# code in upstream amd64 wheels, and retains CPU dispatch and optimized kernels.
FROM ${PYTHON_IMAGE} AS native-build
WORKDIR /build
ENV SOURCE_DATE_EPOCH=1735689600 CMAKE_BUILD_PARALLEL_LEVEL=4
RUN printf 'Types: deb\nURIs: https://snapshot.debian.org/archive/debian/20251101T000000Z/\nSuites: bookworm\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\nCheck-Valid-Until: no\n' > /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends build-essential cmake libopenblas-pthread-dev \
    && rm -rf /var/lib/apt/lists/*
COPY requirements-build.lock prepare_native.py ./
RUN pip install --no-cache-dir --no-compile --no-deps --require-hashes -r requirements-build.lock
COPY --from=assets /redistribution /redistribution
COPY --from=assets /build/sources.lock.json /build/sources.lock.json
RUN python prepare_native.py \
    && cmake -S /native-build/ctranslate2 -B /native-build/ctranslate2/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/ct2 -DBUILD_CLI=OFF -DBUILD_TESTS=OFF -DWITH_MKL=OFF -DWITH_DNNL=OFF -DWITH_CUDA=OFF -DWITH_OPENBLAS=ON -DWITH_RUY=ON -DRUY_BUILD_TESTS=OFF -DRUY_BUILD_BENCHMARKS=OFF -DOPENMP_RUNTIME=COMP \
    && cmake --build /native-build/ctranslate2/build --parallel 4 \
    && cmake --install /native-build/ctranslate2/build \
    && CTRANSLATE2_ROOT=/opt/ct2 pip wheel --no-deps --no-build-isolation --wheel-dir /wheels /native-build/ctranslate2/python

FROM ${PYTHON_IMAGE} AS common
ARG TARGETARCH
LABEL org.opencontainers.image.title="Josi CE Voice Box" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
WORKDIR /app
ENV HF_HUB_OFFLINE=1 PYTHONDONTWRITEBYTECODE=1 SOURCE_DATE_EPOCH=1735689600 OPENBLAS_NUM_THREADS=1
COPY --from=assets /native/${TARGETARCH}/ /tmp/native/
COPY requirements.lock requirements-build.lock patch_whisper.py use_system_runtimes.py ./
COPY --from=native-build /wheels /wheels
COPY --from=native-build /opt/ct2/lib/ /usr/local/lib/
# Install and replace in one layer: neither codec wheels nor opaque compiler
# runtime copies survive in the distributable image layers. No unlocked builds.
RUN dpkg -i /tmp/native/*.deb && rm -r /tmp/native \
    && pip install --no-cache-dir --no-compile --no-deps --require-hashes -r requirements-build.lock \
    && pip install --no-cache-dir --no-compile --no-build-isolation --no-deps --require-hashes -r requirements.lock \
    && pip install --no-deps /wheels/*.whl \
    && python patch_whisper.py && python use_system_runtimes.py && pip check
COPY --from=assets /models /models
COPY --from=assets /redistribution/ /usr/share/voice-box/
COPY *.py /app/
COPY Dockerfile *.txt *.lock *.json *.py COPYING /usr/share/voice-box/build/
COPY LICENSES.md /usr/share/voice-box/LICENSES.md
RUN python audit_runtime.py --output /usr/share/voice-box/artifacts.json \
    && python model_smoke.py
USER 1000:1000
CMD ["python", "/app/gateway.py"]

# Local-only optional GPU target; requires a separate artifact review before
# publication. Only STT uses CUDA, and CPU remains the default.
FROM common AS gpu
USER root
RUN pip install --force-reinstall --no-cache-dir --no-compile --no-deps --require-hashes -r /usr/share/voice-box/build/requirements-gpu.lock \
    && python -c "import json; from pathlib import Path; Path('/usr/share/voice-box/artifacts.json').write_text(json.dumps({'profile': 'gpu', 'publicationReady': False, 'reason': 'Requires independent NVIDIA and native-artifact redistribution review'}))"
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib
USER 1000:1000

FROM common AS cpu
