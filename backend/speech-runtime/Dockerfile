# Magpie-only CPU serving image for the reviewed speech recipe (linux/arm64, Graviton).
# Builds NVIDIA NeMo-Speech.cpp from pinned, checksummed source with the completion
# patch, then copies only the native libraries, notices and the stdlib server.
# No PyTorch, no other model runtime, no model weights: SageMaker supplies the
# verified bundle at /opt/ml/model. Build context: backend/.
#
# Amazon Linux 2023: the speech trial admits an image only with no high or critical
# ECR findings. The Debian base used elsewhere carried unfixed high findings in the
# GCC runtime libraries this native code needs. Security updates are applied at
# build time; the build and runtime share one distribution so library ABIs match.
ARG BASE=public.ecr.aws/amazonlinux/amazonlinux:2023-minimal@sha256:5c546c873970e79e5c9152cd9c8a9c7013824352bc89071d21feb15ad68496aa

FROM --platform=linux/arm64 ${BASE} AS build
ARG RUNTIME_REVISION=0f706e43cf1fbc031bad1423e05460d3acaeaa1c
ARG RUNTIME_SHA256=4f4caf09b3010360f3b239a604d688dddabf365106a727f1a3ab8789e17a2810
ARG GGML_REVISION=c03b4e2bcece5134827881af90242086daf75be5
ARG GGML_SHA256=7f1fe40bdd9d75bc675dab06c0436308a69556b71125bd1c9c668b26a641d94c
ARG PATCH_SHA256=e86315d8bd768d3abd4d9d9edc791c2e34a2cb511cabdfbdd2105c4ef16c33d0
# FP16 arithmetic and dot-product instructions: Graviton2 and later (not Graviton1).
ARG ARM_ARCH=armv8.2-a+fp16+dotprod
RUN dnf -y upgrade --refresh \
    && dnf -y install gcc gcc-c++ make patch tar gzip python3.12 python3.12-pip \
    && dnf clean all \
    && python3.12 -m venv /buildtools \
    && /buildtools/bin/pip install --no-cache-dir cmake==3.31.6 ninja==1.11.1.4
COPY speech-runtime/magpie-completion.patch /completion.patch
RUN set -eu; \
    curl -fsSL -o /runtime.tar.gz "https://codeload.github.com/NVIDIA/NeMo-Speech.cpp/tar.gz/${RUNTIME_REVISION}"; \
    curl -fsSL -o /ggml.tar.gz "https://codeload.github.com/ggml-org/ggml/tar.gz/${GGML_REVISION}"; \
    echo "${RUNTIME_SHA256}  /runtime.tar.gz" | sha256sum -c -; \
    echo "${GGML_SHA256}  /ggml.tar.gz" | sha256sum -c -; \
    echo "${PATCH_SHA256}  /completion.patch" | sha256sum -c -; \
    mkdir /src; tar -xzf /runtime.tar.gz -C /src --strip-components=1; \
    rm -rf /src/ggml; mkdir /src/ggml; tar -xzf /ggml.tar.gz -C /src/ggml --strip-components=1; \
    patch -d /src -p1 < /completion.patch
ENV PATH="/buildtools/bin:${PATH}"
RUN cmake -S /src -B /build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_LIBDIR=lib \
      -DNEMO_SPEECH_BUILD_ASR=OFF -DNEMO_SPEECH_BUILD_DIAR=OFF \
      -DNEMO_SPEECH_BUILD_TTS=ON -DNEMO_SPEECH_BUILD_CLI=OFF \
      -DNEMO_SPEECH_BUILD_MIC_CAPTURE=OFF -DNEMO_SPEECH_BUILD_HTTP=OFF \
      -DNEMO_SPEECH_BUILD_NMT=OFF -DNEMO_SPEECH_BUILD_S2S=OFF \
      -DNEMO_SPEECH_GGML_PATCHED=OFF -DGGML_CUDA=OFF -DGGML_METAL=OFF \
      -DGGML_OPENMP=OFF -DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=${ARM_ARCH} \
    && cmake --build /build -j "$(nproc)" \
    && cmake --install /build --prefix /native \
    && rm -rf /native/include /native/lib/cmake

FROM --platform=linux/arm64 ${BASE}
RUN dnf -y upgrade --refresh \
    && dnf -y install python3.12 libstdc++ \
    && dnf clean all && rm -rf /var/cache/dnf
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY --from=build /native/lib/ /opt/magpie-runtime/lib/
COPY --from=build /native/share/licenses/ /opt/magpie-runtime/licenses/
COPY deploy/magpie-v2607.json /opt/eddie-speech/magpie-v2607.json
COPY speech-runtime/serve.py speech-runtime/worker.py /opt/eddie-speech/
# SageMaker starts the container as `docker run <image> serve`; the argument is unused.
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["python3.12", "/opt/eddie-speech/serve.py"]
